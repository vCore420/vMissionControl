// The Code tab's runtime — one streamed, tool-calling turn per session.
//
// runTurn() is the whole thing: build the message stack, then loop — stream a
// round from the model, run whatever tools it asked for, feed the results
// back, repeat until it answers or hits the step cap. Each tool call is a
// "step" patched onto the pending assistant message live.
//
// A write tool (write_file / edit_file / append_file / create_dir /
// delete_path / run_command / generate_image) is prepared into a diff, then
// either auto-applied or held for a Confirm/Reject card per the session's
// approval mode (ask | auto-edit | auto-all) — a held write suspends the
// turn mid-loop until the user decides. run_command also consults the
// per-command rules (codeCommandRules.js), and the pre-write file state is
// snapshotted for the "revert this turn" button (codeCheckpoints.js).
//
// Turn context — an @file mention (codeMentions.js), an attached image's
// vision description (codeVision.js), or a /command's expansion
// (codeCommands.js, in routes/code.js) — is spliced onto the last user
// message in buildMessages(). A long turn compacts its older rounds
// (compactWorking) so it doesn't overflow the model's window.
//
// Reuses ollama.js#chatStream (transport) and toolCalls.js#recoverToolCalls
// (small-model repair, shared with ollamaChat.js). The loop is written fresh
// rather than shared with ollamaChat.js#generateReply — that one is tangled
// up with chat's own out-of-band action-confirmation flow.

import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { chatStream, chat, preloadModel, showModel } from './ollama.js';
import { getSession, addMessage, updateMessage, setSessionTasks } from './codeStore.js';
import { resolveWorkspacePath, readContextFile, readMemoryFile, ensureMemoryFile } from './codeWorkspace.js';
import {
  getCodeToolDefinitions, executeCodeTool, codeToolNames, codeToolLabel, parseArgs,
  isWriteTool, writeToolAutoInEditMode, prepareWriteTool, executeWriteTool,
} from './codeTools.js';
import { recoverToolCalls } from './toolCalls.js';
import { hasBackground } from './codeBackground.js';
import { classifyCommand } from './codeCommandRules.js';
import { captureBeforeWrite, noteCommandRun, finalizeCheckpoint } from './codeCheckpoints.js';
import { attachmentBlock } from './codeAttach.js';
import { mentionBlock } from './codeMentions.js';
import { describeImages, visionBlock } from './codeVision.js';
import { appEvents } from './events.js';
import { logActivity } from './activityLog.js';

// One turn per session at a time. A second send while a turn is running (or
// suspended on an approval) is rejected by the route (409) rather than queued.
const busySessions = new Set();
const controllers = new Map(); // sessionId -> AbortController
const pendingApprovals = new Map(); // approvalId -> { resolve, sessionId }
const pendingQuestions = new Map(); // questionId -> { resolve, sessionId } (ask_user)
const KNOWN_TOOLS = codeToolNames();

const MIN_ROUNDS = 3;
const MAX_ROUNDS = 40;
const APPROVAL_TTL_MS = 15 * 60 * 1000; // a held write / an unanswered question

export function isBusy(sessionId) {
  return busySessions.has(sessionId);
}

const APPROVAL_MODES = new Set(['ask', 'auto-edit', 'auto-all']);

// ---------- Context compaction (Code parity roadmap 1b) ----------
// Same chars/4 estimate the Code view's context meter uses. Counts message
// text plus any tool_calls JSON — the two things that fill the window.
const estTokens = (msgs) =>
  Math.round(
    msgs.reduce(
      (n, m) => n + (m.content?.length || 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0),
      0
    ) / 4
  );
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// The window Ollama will actually give the model: config.code.contextTokens,
// clamped to the model's own max (same as the meter). Cached per model.
const modelCtxCache = new Map();
async function effectiveWindow(baseUrl, model, configured) {
  if (!modelCtxCache.has(model)) {
    try {
      modelCtxCache.set(model, (await showModel(baseUrl, model)).contextLength || null);
    } catch {
      modelCtxCache.set(model, null);
    }
  }
  const max = modelCtxCache.get(model);
  return max ? Math.min(configured, max) : configured;
}

// Summarise everything the turn has done so far into one recap and reset the
// working stack to just [system, recap]. Aggressive on purpose: a single
// round can be four big file reads, so keeping "recent rounds" verbatim
// often still doesn't fit — and once we're over budget Ollama would drop the
// start anyway. The recap is the model's own briefing; it re-reads a file if
// it needs one again. Progressive: a later compaction folds this recap plus
// the new work into a fresh one.
// Never throws to the caller — a failed compaction just leaves `working` as
// it was (Ollama's own truncation is the last-resort fallback). `turnSignal`
// is the turn's AbortController signal; the summariser call is given its own
// bounded timeout on top of that (the turn timer is paused around it).
const COMPACT_TIMEOUT_MS = 150000;
async function compactWorking(working, { baseUrl, model, keepAlive, turnSignal, tasks }) {
  const system = working[0];
  const rest = working.slice(1);
  if (rest.length < 3) return working; // barely anything to fold

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), COMPACT_TIMEOUT_MS);
  const relay = () => abort.abort();
  turnSignal?.addEventListener('abort', relay, { once: true });

  const transcript = rest
    .map((m) => {
      if (m.role === 'tool') return `TOOL RESULT (${m.name}): ${(m.content || '').slice(0, 2000)}`;
      const calls = m.tool_calls?.length
        ? `\nCALLS: ${m.tool_calls.map((c) => `${c.function?.name}(${JSON.stringify(c.function?.arguments).slice(0, 300)})`).join(', ')}`
        : '';
      return `${m.role.toUpperCase()}: ${(m.content || '').slice(0, 2000)}${calls}`;
    })
    .join('\n\n');

  let summary;
  try {
    summary = await chat(baseUrl, {
      model,
      keepAlive,
      signal: abort.signal,
      messages: [
        {
          role: 'system',
          content:
            'You compress the first part of a coding session into a briefing the same assistant will keep working from. Be factual and specific — file paths, exact findings, exact changes. Terse notes, no preamble.',
        },
        {
          role: 'user',
          content:
            'Summarise everything done so far in this task:\n' +
            '- what was investigated and what was found (files, line numbers, key facts)\n' +
            '- every change made (which file, what changed) and whether it is confirmed applied\n' +
            '- anything that failed or was rejected\n' +
            '- what still needs doing\n\n' +
            `===\n${transcript}\n===`,
        },
      ],
    });
  } finally {
    clearTimeout(timer);
    turnSignal?.removeEventListener('abort', relay);
  }

  const taskLines = tasks?.length
    ? `\n\nCurrent task list:\n${tasks.map((t) => `[${t.status}] ${t.text}`).join('\n')}`
    : '';
  return [
    system,
    {
      role: 'user',
      content:
        `[The conversation and your work so far this turn, compacted to fit the context window. ` +
        `Continue from here; re-read a file if you need its exact contents again.]\n\n${summary}${taskLines}`,
    },
  ];
}

// A workspace doc (source-of-truth or memory file) as a fenced block for the
// tail of the system prompt. `intro` frames what the file is and how to treat
// it. Empty string when the doc is off / missing / blank.
function docBlock(doc, intro) {
  if (!doc?.exists || !doc.content.trim()) return '';
  const trunc = doc.truncated
    ? `\n\n[${doc.name} is larger than the 16 KB context budget — the rest was left out. Use read_file if you need more of it.]`
    : '';
  return `\n\n===== ${doc.name} =====\n${intro}\n\n${doc.content.trim()}${trunc}\n===== end ${doc.name} =====`;
}

// ctx: { workspacePath, mode, allowCommands, contextFile, memoryFile,
//        hasAttachments, hasMentions, hasVision, canGenerateImages, hasChecks,
//        planMode } — the same object buildMessages() works from.
function systemPrompt(ctx) {
  const {
    workspacePath, mode, allowCommands, contextFile, memoryFile,
    hasAttachments, hasMentions, hasVision, canGenerateImages, hasChecks, planMode,
  } = ctx;
  const modeNote = planMode
    ? "You are in PLAN mode. Investigate the workspace thoroughly, then write a concrete implementation " +
      "plan: the files to change, the approach, the order of steps, the risks, and any open questions. " +
      "You CANNOT write, edit, delete, run commands, or generate anything this turn — only read, search, " +
      (hasChecks ? "run_checks, " : "") +
      "and ask_user. When the plan is agreed, the user saves it themselves."
    : mode === 'auto-all'
      ? 'Your file changes are applied automatically.'
      : mode === 'auto-edit'
        ? 'Your file edits are applied automatically; deleting a file or running a command still needs the user to confirm.'
        : 'Every file change and command is shown to the user to confirm or reject before it happens. If something is rejected, do not retry it — ask what they would prefer.';
  const memoryNote =
    !planMode && memoryFile && memoryFile.name
      ? `\nYou keep a running-notes file, ${memoryFile.name}, in the workspace. When you learn something ` +
        `durable about this project that a future turn should start with — a gotcha, a decision you made, ` +
        `a convention you had to work out — add one short line to it with append_file. Keep it terse; ` +
        `don't restate what's already there or what's in the source-of-truth file.\n`
      : '';
  const attachNote = hasAttachments
    ? '\nThe user attached one or more files to their latest message; each appears inline there as ' +
      '"[attached: <name>]" with the contents in a code block. Use those contents directly — the ' +
      'attached files are not in the workspace, so do not call read_file for them.\n'
    : '';
  const mentionNote = hasMentions
    ? '\nThe user pointed at one or more workspace files with "@"; each appears inline in their latest ' +
      'message as "[workspace file: <path>]" with its current contents. Start from those. They ARE in ' +
      'the workspace, so you can still read_file for the rest of a truncated one or for related files.\n'
    : '';
  const visionNote = hasVision
    ? '\nThe user attached one or more images. You cannot see them, but a vision model has, and its ' +
      'description of each appears inline in their latest message as "[image: <name> — described ...]". ' +
      'Treat that description as your only view of the image — act on it directly.\n'
    : '';
  const base =
    'You are a coding assistant working in a session inside Mission Control, a self-hosted dashboard. ' +
    `You work inside one project folder (its name on disk is "${workspacePath.split(/[/\\]/).pop()}").\n\n` +
    'ALL tool paths are relative to that folder — e.g. "src/index.js", "package.json". Never pass an ' +
    'absolute path. Call list_dir with no path to see the top level.\n\n' +
    'Read-only tools: list_dir, read_file, search_text, find_files — use them to look at the real files ' +
    'before changing anything; never guess at file contents.\n' +
    (planMode
      ? ''
      : 'Write tools: write_file (create/overwrite), edit_file (exact-substring replace), append_file ' +
        '(add text to the end of a file — use this to add a line to a notes file, never edit_file for that), ' +
        'create_dir, delete_path (files and empty dirs only).\n') +
    'ask_user: when a choice is genuinely the user\'s to make — an ambiguous requirement, a design fork, ' +
    'something destructive or far-reaching — ask instead of guessing. Not for anything the code or the ' +
    'conversation already answers.\n' +
    (planMode
      ? ''
      : 'update_tasks: for any request that takes more than a step or two, call update_tasks first with your ' +
        'planned steps (short imperative lines, status "pending"), mark one "active" as you work it, and call it ' +
        'again with the full updated list each time a step is done. It keeps you and the user oriented across a ' +
        'long turn. Skip it for a trivial one-step change.\n') +
    (planMode || !allowCommands
      ? ''
      : 'run_command: run a shell command with the project folder as its working directory (builds, tests, git, ...). Read its output before drawing conclusions. ' +
        'For a process that needs to keep running (a dev server, a watcher), pass background:true — it returns a bgId right away; then use check_command(bgId) to read its output and stop_command(bgId) when you are done with it. ' +
        'Some commands are blocked by the user\'s command rules; if one comes back blocked, do not rephrase or route around it — just tell the user.\n') +
    (hasChecks
      ? planMode
        ? "run_checks: run the project's configured checks — use it to see what state things are in.\n"
        : "run_checks: run the project's configured checks (syntax / lint / tests). Run it after making changes and fix whatever it reports before finishing.\n"
      : '') +
    'You can also review code when asked: read the relevant files, run any checks, and report concrete ' +
    'findings — file and line, what is wrong, and why — not vague impressions. Say plainly when something is fine.\n' +
    (planMode || !canGenerateImages
      ? ''
      : 'generate_image: create an image with ComfyUI and save it into the workspace — for placeholder art, textures, sprites, icons, backgrounds. Describe the image plainly and give a path like "assets/crate.png". It takes a while; generate what you need, not extras.\n') +
    `${modeNote}\n` +
    memoryNote +
    attachNote +
    mentionNote +
    visionNote +
    '\nReply in Markdown. Put illustrative code snippets in fenced blocks with a language tag. When you ' +
    'point at a spot in a file, write it as path:line (e.g. src/app.js:42) — the user\'s transcript turns ' +
    'that into a link. ' +
    (planMode ? 'End with the plan itself, clearly structured.' : 'After making changes, briefly say what you changed.');

  // Both docs are appended to the tail — weak models weight the end of the
  // system message more. Source-of-truth first, then the agent's own notes.
  // The action-tool reminder goes after even those, as the very last thing:
  // weak local models (qwen2.5-coder especially) keep "answering" a change
  // request in prose — "Fixed it.", or the file's new contents in a ```block
  // — instead of calling the tool, and this is the line best placed to catch it.
  const actionReminder = planMode
    ? ''
    : '\n\nBEFORE YOU REPLY: a file is created or changed ONLY by a write_file / edit_file / append_file / ' +
      'create_dir / delete_path tool call, and a check or command runs ONLY by a run_checks / run_command ' +
      'call. Writing a file\'s new contents in your reply as a code block, or saying the change is done, ' +
      'does nothing on disk — new file or existing one, "fix this" still means call the tool. If you were ' +
      'about to paste file contents to answer this, call write_file / edit_file with that content instead.';

  return (
    base +
    docBlock(
      contextFile,
      'The user maintains this file as the source of truth for this project — conventions, architecture, ' +
        'things to know. Follow it. If it conflicts with something asked in the conversation, say so rather ' +
        'than silently choosing.'
    ) +
    docBlock(
      memoryFile,
      "Your own running notes from earlier turns in this project. Treat them as things you already " +
        "found out — don't re-derive them. Add to this file (don't rewrite it) as you learn more."
    ) +
    actionReminder
  );
}

// Build the message stack for a turn: [system prompt, task list?, prior turns].
// The pending message and earlier failed replies are dropped; tool steps are
// display-only. This turn's own context — an @file mention, an image's vision
// description, a /command's expansion — is spliced onto the last user message
// (none of it is stored, so it only exists for this turn).
//
// ctx: {
//   session, workspacePath, mode, allowCommands, contextFile, memoryFile,
//   attachments, mentions, commandPrompt, visionDescriptions,
//   canGenerateImages, hasChecks, planMode,
//   historyBudget  — token cap on prior turns; older ones past it are dropped
//                    with a marker so the current turn still has room (1b)
// }
function buildMessages(ctx) {
  const {
    session, contextFile, memoryFile, attachments, mentions, commandPrompt,
    visionDescriptions, planMode, historyBudget,
  } = ctx;
  let history = session.messages
    .filter(
      (m) =>
        !m.pending &&
        !m.error &&
        ((m.text || '').trim() || m.attachments?.length || m.mentions?.length || m.images?.length)
    )
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: (m.text || '').trim() || '(see attached file)',
    }));
  // A /command (Code parity 3b): the model gets the expanded template this
  // turn, not the raw "/name args" the transcript keeps. Past command turns
  // stay as typed — the expansion is only for the turn being generated.
  if (commandPrompt) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') { history[i] = { ...history[i], content: commandPrompt }; break; }
    }
  }
  const turnContext = attachmentBlock(attachments) + mentionBlock(mentions) + visionBlock(visionDescriptions);
  if (turnContext) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        history[i] = { ...history[i], content: history[i].content + turnContext };
        break;
      }
    }
  }

  // Drop the oldest turns if the transcript alone would eat the budget.
  let dropped = 0;
  while (history.length > 6 && historyBudget > 0 && estTokens(history) > historyBudget) {
    history.shift();
    dropped += 1;
  }
  if (dropped) {
    history.unshift({
      role: 'user',
      content: `[${dropped} earlier conversation turn${dropped === 1 ? '' : 's'} omitted to fit the context window. The workspace, the notes file, and the task list below are current regardless.]`,
    });
  }

  // The agent's current task list (1a) — re-stated every turn so update_tasks
  // has something to keep current, and so it survives an in-turn compaction.
  const taskMsg = session.tasks?.length && !planMode
    ? [{
        role: 'user',
        content:
          `[Your current task list for this work — keep it current with update_tasks as you go:]\n` +
          session.tasks.map((t) => `[${t.status}] ${t.text}`).join('\n'),
      }]
    : [];

  return [
    {
      role: 'system',
      content: systemPrompt({
        ...ctx,
        hasAttachments: !!attachments?.length,
        hasMentions: !!mentions?.length,
        hasVision: !!visionDescriptions?.length,
      }),
    },
    ...taskMsg,
    ...history,
  ];
}

// A read-tool call → a step { label, detail } for the transcript.
function readStep(name, args, result) {
  if (result?.error) {
    const err = String(result.error);
    return err.length <= 70
      ? { label: `\`${name}\` — ${err}`, detail: null }
      : { label: `\`${name}\` failed`, detail: err };
  }
  if (result?.note) return { label: `Read \`${args.path}\``, detail: result.note };
  switch (name) {
    case 'list_dir': {
      const items = result.items || [];
      return {
        label: `Listed ${args.path ? `\`${args.path}/\`` : 'the workspace root'} — ${items.length} item${items.length === 1 ? '' : 's'}`,
        detail: items.map((i) => `${i.type === 'dir' ? '[dir] ' : '      '}${i.name}`).join('\n') || '(empty)',
      };
    }
    case 'read_file':
      return {
        label: `Read \`${args.path}\`${result.shownRange ? ` — lines ${result.shownRange} of ${result.totalLines}` : ''}`,
        detail: null,
      };
    case 'search_text': {
      const n = result.count ?? 0;
      return {
        label: `Searched for \`${args.query}\` — ${n} match${n === 1 ? '' : 'es'}`,
        detail: (result.matches || []).map((m) => `${m.file}:${m.line}  ${m.text}`).join('\n') || null,
      };
    }
    case 'run_checks':
      return {
        label: `Checks — ${result.summary}`,
        detail:
          (result.checks || [])
            .map((c) => `── ${c.label} (${c.ok ? 'pass' : c.timedOut ? 'timed out' : `exit ${c.exitCode}`})\n${c.output}`)
            .join('\n\n') || null,
      };
    case 'find_files': {
      const n = result.count ?? 0;
      return {
        label: `Found files matching \`${args.query}\` — ${n}`,
        detail: (result.files || []).join('\n') || null,
      };
    }
    case 'check_command':
      return {
        label: `Checked \`${result.command || args.bgId}\` — ${
          result.running ? `running (${result.ranForSeconds}s)` : `exited ${result.exitCode}`
        }`,
        detail: result.output || null,
      };
    case 'stop_command':
      return {
        label: result.alreadyStopped
          ? `\`${args.bgId}\` had already stopped`
          : `Stopped \`${result.command || args.bgId}\``,
        detail: null,
      };
    default:
      return { label: codeToolLabel(name), detail: null };
  }
}

// Wait for the user to Confirm/Reject a held write. Resolves 'confirm' /
// 'reject' from decideApproval, 'aborted' if the turn is stopped, or
// 'timeout' after APPROVAL_TTL_MS.
function waitForApproval(approvalId, sessionId, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      pendingApprovals.delete(approvalId);
      resolve(decision);
    };
    const onAbort = () => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), APPROVAL_TTL_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    pendingApprovals.set(approvalId, { resolve: finish, sessionId });
  });
}

// Called from routes/code.js when the user clicks Confirm or Reject.
export function decideApproval(approvalId, decision) {
  const entry = pendingApprovals.get(approvalId);
  if (!entry) return { error: 'that change is no longer waiting for a decision' };
  entry.resolve(decision === 'confirm' ? 'confirm' : 'reject');
  return { ok: true };
}

// The ask_user counterpart of waitForApproval — resolves { answer } from
// answerQuestion, 'aborted' on Stop, or 'timeout'.
function waitForAnswer(questionId, sessionId, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      pendingQuestions.delete(questionId);
      resolve(outcome);
    };
    const onAbort = () => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), APPROVAL_TTL_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    pendingQuestions.set(questionId, { resolve: finish, sessionId });
  });
}

// Called from routes/code.js when the user answers an ask_user question.
export function answerQuestion(questionId, answer) {
  const entry = pendingQuestions.get(questionId);
  if (!entry) return { error: 'that question is no longer waiting for an answer' };
  const text = String(answer || '').trim();
  if (!text) return { error: 'an answer is required' };
  entry.resolve({ answer: text.slice(0, 2000) });
  return { ok: true };
}

// Fired (not awaited) by the route after it has stored the user's message.
export async function runTurn({ sessionId, attachments, mentions, images, commandPrompt = null, overrides = {} }) {
  if (busySessions.has(sessionId)) return;
  const config = await loadConfig();
  const session = await getSession(sessionId);
  if (!session) return;

  // A /command (Code parity 3b) can override the session's model / approval
  // mode for this one turn — its frontmatter wins, then the session, then the
  // Settings default.
  const model = (overrides.model || session.model || config.code.defaultModel || '').trim();
  const workspacePath = resolveWorkspacePath(config);
  const mode = APPROVAL_MODES.has(overrides.approvalMode)
    ? overrides.approvalMode
    : APPROVAL_MODES.has(session.approvalMode)
      ? session.approvalMode
      : (config.code.defaultApprovalMode || 'ask');
  const planMode = !!session.planMode;

  if (!model) {
    await addMessage(sessionId, {
      role: 'assistant',
      author: 'assistant',
      text: '⚠️ No model selected — pick one from the dropdown in the session header.',
      error: true,
    });
    return;
  }

  busySessions.add(sessionId);
  // Tells every device to show a "working" marker on this session's sidebar
  // row — the turn may be running in a session nobody has open (ws.js → core.js).
  appEvents.emit('code:turn', { sessionId, running: true });
  const pending = await addMessage(sessionId, { role: 'assistant', author: model, text: '', pending: true, planMode });

  const controller = new AbortController();
  controllers.set(sessionId, controller);
  const timeoutMs = config.code.requestTimeoutMs || 300000;
  let turnTimer = setTimeout(() => controller.abort(), timeoutMs);
  const maxRounds = Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, Math.round(config.code.maxSteps) || 25));

  const allowCommands = !!config.code.allowCommands;
  const comfyEnabled = !!config.comfy?.enabled;
  const checksConfigured = Array.isArray(config.code.checks) && config.code.checks.length > 0;
  const maxImagesPerTurn = Math.max(1, Math.round(config.comfy?.maxPerTurn) || 6);
  let imagesThisTurn = 0;
  // The workspace docs (AGENTS.md source-of-truth + AGENTS-memory.md notes),
  // re-read every turn so an edit — including one the agent just made — takes
  // effect next turn. Neither throws; null when its feature is off. The memory
  // file is created empty first so the agent always has somewhere to append.
  await ensureMemoryFile(config).catch(() => {});
  const [contextFile, memoryFile] = await Promise.all([readContextFile(config), readMemoryFile(config)]);

  // Context budget (Code parity 1b): the window Ollama gives the model, and
  // the % of it at which a long turn compacts its older rounds.
  const contextWindow = await effectiveWindow(config.ollama.baseUrl, model, config.code.contextTokens || 16384);
  const compactPct = Math.min(95, Math.max(40, Math.round(config.code.compactAtPercent) || 75));
  const compactAt = Math.round(contextWindow * (compactPct / 100));

  const disabledTools = Array.isArray(config.code.disabledTools) ? config.code.disabledTools : [];
  // Rebuilt each round: check_command / stop_command only appear once the
  // agent has a background command to act on (Code parity 2a).
  const buildToolDefs = () => getCodeToolDefinitions({
    allowCommands, comfyEnabled, checksConfigured, planMode, disabledTools,
    hasBackgroundCommands: hasBackground(sessionId),
  });
  let toolDefs = buildToolDefs();
  const steps = [];
  const applied = []; // labels of writes that actually happened, for the fallback summary
  let carried = '';
  let latest = '';

  let lastFlushAt = 0;
  const FLUSH_MS = 400;
  const patchNow = (patch) => updateMessage(sessionId, pending.id, patch).catch(() => {});
  const flushSteps = () => patchNow({ text: carried, steps: [...steps], pending: true });
  // Live "generating image 2/3…" on a running generate_image step.
  const updateStepProgress = (step, note) => {
    step.progress = note;
    flushSteps();
  };

  // Vision (Code parity 4a): describe any attached image with the configured
  // vision model and splice it onto the turn — the chosen model stays the
  // driver, this is just its eyes. Runs before the message stack is built.
  let visionDescriptions = null;
  if (Array.isArray(images) && images.length) {
    const vstep = {
      tool: 'vision',
      label: `👁 Reading ${images.length} image${images.length === 1 ? '' : 's'}…`,
      status: 'pending',
      detail: null,
    };
    steps.push(vstep);
    flushSteps();
    clearTimeout(turnTimer); // CPU vision inference is slow — don't time the turn out during it
    const { model: visModel, descriptions } = await describeImages(config, images, { turnSignal: controller.signal });
    turnTimer = setTimeout(() => controller.abort(), timeoutMs);
    visionDescriptions = descriptions;
    const ok = descriptions.filter((d) => !d.error).length;
    vstep.status = ok ? 'done' : 'failed';
    vstep.label = ok
      ? `👁 Read ${ok} image${ok === 1 ? '' : 's'}${visModel ? ` with ${visModel}` : ''}`
      : `👁 Couldn't read the attached image${images.length === 1 ? '' : 's'}`;
    vstep.detail = descriptions.map((d) => `── ${d.name}\n${d.error ? `(${d.error})` : d.text}`).join('\n\n');
    flushSteps();
    logActivity(
      'code',
      `Code agent read ${ok}/${images.length} image(s)${visModel ? ` with ${visModel}` : ''} — session "${session.title}"`
    );
  }

  let working = buildMessages({
    session, workspacePath, mode, allowCommands, contextFile, memoryFile,
    attachments, mentions, commandPrompt, visionDescriptions,
    canGenerateImages: comfyEnabled,
    hasChecks: checksConfigured,
    planMode,
    historyBudget: Math.round(contextWindow * 0.4),
  });
  const looksLikeToolText = (t) =>
    /^`{0,3}(?:json)?\s*[[{]\s*"?(name|type|function)"?\s*:/i.test(t.trimStart().slice(0, 48));
  const onDelta = (roundText) => {
    latest = carried + roundText;
    if (Date.now() - lastFlushAt >= FLUSH_MS) {
      lastFlushAt = Date.now();
      patchNow({
        text: looksLikeToolText(roundText) ? carried : latest,
        steps: steps.length ? [...steps] : undefined,
        pending: true,
      });
    }
  };

  // update_tasks: sanitise the model's list, store it (→ code:sessions
  // broadcast → every device's task panel), and hand a compact echo back to
  // the model so it keeps the same wording next call.
  const handleUpdateTasks = async (args) => {
    const raw = Array.isArray(args.tasks) ? args.tasks : [];
    const tasks = raw
      .map((t) => ({
        text: String(t?.text || '').trim().replace(/\s+/g, ' ').slice(0, 200),
        status: ['pending', 'active', 'done'].includes(t?.status) ? t.status : 'pending',
      }))
      .filter((t) => t.text)
      .slice(0, 30);
    if (!tasks.length) return { error: 'update_tasks needs a non-empty "tasks" array of { text, status }' };
    await setSessionTasks(sessionId, tasks);
    return {
      ok: true,
      recorded: tasks.length,
      done: tasks.filter((t) => t.status === 'done').length,
      tasks: tasks.map((t) => `[${t.status}] ${t.text}`),
    };
  };

  // ask_user: post a question card, suspend the turn until the user answers.
  // Returns { answer } to feed back to the model, or 'stop' (abort / timeout).
  const handleAskUser = async (args) => {
    const question = String(args.question || '').trim();
    if (!question) return { error: 'ask_user needs a "question"' };
    const options = Array.isArray(args.options)
      ? args.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 6)
      : [];

    const questionId = `ask-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const step = { tool: 'ask_user', label: question, status: 'pending', kind: 'question', questionId, options };
    steps.push(step);
    flushSteps();

    clearTimeout(turnTimer); // don't time the turn out while the user thinks
    const outcome = await waitForAnswer(questionId, sessionId, controller.signal);
    turnTimer = setTimeout(() => controller.abort(), timeoutMs);
    delete step.questionId;

    if (outcome === 'aborted' || outcome === 'timeout') {
      step.status = outcome === 'timeout' ? 'expired' : 'cancelled';
      delete step.options;
      flushSteps();
      return 'stop';
    }
    step.status = 'answered';
    step.detail = outcome.answer;
    delete step.options;
    flushSteps();
    return { answer: outcome.answer };
  };

  // Runs one write tool call: prepare → (auto-apply | hold for approval) →
  // execute. Returns the object to feed back to the model as the tool result,
  // or 'stop' to end the whole turn (abort / timeout while held).
  const handleWrite = async (name, args) => {
    const step = { tool: name, label: codeToolLabel(name), detail: null, status: 'pending' };
    const prep = await prepareWriteTool(name, args);
    if (prep.error) {
      step.status = 'failed';
      step.label = prep.error.length <= 70 ? `\`${name}\` — ${prep.error}` : `\`${name}\` failed`;
      step.detail = prep.error.length > 70 ? prep.error : null;
      steps.push(step);
      flushSteps();
      return { error: prep.error };
    }

    // Per-turn image cap — a bounded, confused model shouldn't be able to
    // queue a hundred slow generations. Enforced here, not in the tool,
    // because "this turn" is the agent-loop's unit.
    if (name === 'generate_image') {
      const want = prep.payload?.count || 1;
      if (imagesThisTurn + want > maxImagesPerTurn) {
        const left = Math.max(0, maxImagesPerTurn - imagesThisTurn);
        step.status = 'failed';
        step.label = `\`generate_image\` — turn image limit reached`;
        steps.push(step);
        flushSteps();
        return {
          error: `only ${left} more image${left === 1 ? '' : 's'} can be generated this turn (limit ${maxImagesPerTurn}). Save what you have and continue; the user can ask for more.`,
        };
      }
    }

    step.label = prep.summary + (prep.stat ? `  (${prep.stat})` : '');
    if (prep.diff) { step.detail = prep.diff; step.kind = 'diff'; }

    // Per-command rules (Code parity roadmap 2b) — run_command only, both the
    // foreground and background paths. A deny is absolute (even in auto-all);
    // an allow skips the Confirm card (even in "ask"); anything else defers to
    // the approval mode below. `ruleNote` is re-appended wherever the
    // run_command label is later rebuilt from prep.summary + the result.
    let ruleVerdict = 'ask';
    let ruleNote = '';
    if (name === 'run_command') {
      ruleVerdict = classifyCommand(config.code.commandRules, prep.payload.command);
      if (ruleVerdict === 'deny') {
        step.status = 'failed';
        step.label = `${prep.summary} — blocked by a command rule`;
        steps.push(step);
        flushSteps();
        logActivity('code', `Code agent: "${prep.payload.command}" blocked by a command rule (session "${session.title}")`);
        return {
          error:
            'A command rule in Settings → Code blocks this command. Do not try to work around it (no rephrasing, no alternate tool). ' +
            'Tell the user it is blocked; if they want it run they can adjust the rules or run it themselves.',
        };
      }
      if (ruleVerdict === 'allow') {
        ruleNote = ' · allowed by rule';
        step.label += ruleNote;
      }
    }

    const auto =
      ruleVerdict === 'allow' ||
      mode === 'auto-all' ||
      (mode === 'auto-edit' && writeToolAutoInEditMode(name));
    if (!auto) {
      step.approvalId = `apr-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      steps.push(step);
      flushSteps();

      clearTimeout(turnTimer); // don't let the turn time out while the user reviews
      const decision = await waitForApproval(step.approvalId, sessionId, controller.signal);
      turnTimer = setTimeout(() => controller.abort(), timeoutMs);
      delete step.approvalId;

      if (decision === 'reject') {
        step.status = 'rejected';
        flushSteps();
        return { status: 'rejected', message: 'The user rejected this change. Do not retry it; ask them what they would prefer instead.' };
      }
      if (decision !== 'confirm') {
        step.status = decision === 'timeout' ? 'expired' : 'cancelled';
        flushSteps();
        return 'stop';
      }
    } else {
      steps.push(step);
    }

    // Checkpoint the pre-write state (Code parity 2c) — captured here, after
    // approval and immediately before the tool touches disk, so "↩ Revert this
    // turn" can roll it back. run_command's file effects can't be captured
    // (it can touch anything) — just note that a command ran.
    if (name === 'run_command') {
      if (!prep.payload.background) noteCommandRun(sessionId, pending.id);
    } else if (prep.payload?.path) {
      await captureBeforeWrite(config, sessionId, pending.id, prep.payload.path);
    }

    // run_command and generate_image can take minutes; the turn's own
    // timeout would kill a legitimate one. Both self-limit (commandTimeoutMs /
    // comfy.timeoutMs), and Stop still works via controller.signal, so it's
    // safe to pause the turn budget while the tool runs.
    clearTimeout(turnTimer);
    const onImageProgress = (p) => {
      const batch = p.count > 1 ? ` (${Math.min(p.index + 1, p.count)}/${p.count})` : '';
      const note =
        p.phase === 'sampling' && p.value != null ? `sampling ${p.value}/${p.max}${batch}…` : `generating${batch}…`;
      updateStepProgress(step, note);
    };
    const result = await executeWriteTool(name, prep.payload, {
      signal: controller.signal,
      sessionId,
      onProgress: name === 'generate_image' ? onImageProgress : undefined,
    });
    turnTimer = setTimeout(() => controller.abort(), timeoutMs);

    // A backgrounded run_command returns immediately — its own note tells the
    // model how to follow up (check_command / stop_command), so pass the
    // result straight through rather than the generic "already run" wrap.
    if (result.background) {
      step.status = 'applied';
      step.label = `${prep.summary} — ${result.detail}${ruleNote}`;
      applied.push(prep.summary);
      flushSteps();
      logActivity('code', `Code agent started background: ${prep.summary} (session "${session.title}")`);
      return { status: 'applied', applied: true, bgId: result.bgId, detail: result.detail, note: result.note };
    }

    if (name === 'generate_image' && Array.isArray(result.images)) {
      imagesThisTurn += result.images.length;
      step.images = result.images.map((im) => im.path);
      step.kind = 'image';
    }

    // run_command reports its outcome via exitCode/timedOut, not `error` — a
    // command that ran but exited non-zero is a failed step, and its output
    // matters to the model either way. Everything else: `error` = it failed.
    const cmdFailed = result.timedOut || (typeof result.exitCode === 'number' && result.exitCode !== 0);
    const failed = !!result.error || cmdFailed;
    if (result.output != null) { step.detail = String(result.output); step.kind = undefined; }
    delete step.progress;

    if (failed) {
      step.status = 'failed';
      if (!step.detail) step.detail = result.error || null;
      if (result.detail && name === 'run_command') step.label = `${prep.summary} — ${result.detail}${ruleNote}`;
      flushSteps();
      const why = result.timedOut ? 'TIMED OUT' : result.error || `exit ${result.exitCode}`;
      logActivity('code', `Code agent: ${prep.summary} — ${why} (session "${session.title}")`);
      return {
        error: result.error || (result.timedOut ? 'the command timed out' : `the command exited with code ${result.exitCode}`),
        ...(result.output != null && { output: String(result.output).slice(0, 8000) }),
      };
    }

    step.status = 'applied';
    if (result.detail && name === 'run_command') step.label = `${prep.summary} — ${result.detail}${ruleNote}`;
    applied.push(prep.summary);
    flushSteps();
    logActivity(
      'code',
      `Code agent ${ruleVerdict === 'allow' ? 'ran (rule-allowed)' : auto ? 'auto-applied' : 'applied'}: ${prep.summary} (session "${session.title}")`
    );
    return {
      status: 'applied',
      applied: true,
      detail: result.detail || `${prep.summary} — done.`,
      ...(result.output != null && { output: String(result.output).slice(0, 8000) }),
      note:
        name === 'run_command'
          ? 'The command has already run; its output is above. Do not run it again unless something changed.'
          : name === 'generate_image'
            ? 'The image is generated and saved at the path above. Do not regenerate it unless asked to change something.'
            : 'This change is saved to disk. Do not repeat it.',
    };
  };

  const finalize = (text, { error = false } = {}) => {
    let out = (text || '').trim();
    if (!out && applied.length) out = `Done. ${applied.join('; ')}.`;
    if (!out) out = error ? '⚠️ No reply.' : '(no reply)';
    return updateMessage(
      sessionId,
      pending.id,
      { text: out, steps: steps.length ? steps : undefined, pending: false, error: error && !applied.length },
      { persist: true }
    );
  };

  try {
    for (let round = 0; round <= maxRounds; round++) {
      let { content, toolCalls, thinking } = await chatStream(config.ollama.baseUrl, {
        model,
        messages: working,
        tools: round < maxRounds ? toolDefs : undefined,
        keepAlive: config.code.keepAlive,
        numPredict: config.code.numPredict,
        numCtx: config.code.contextTokens,
        signal: controller.signal,
        onDelta,
      });

      if (!toolCalls.length && round < maxRounds) {
        const recovered = recoverToolCalls(content, KNOWN_TOOLS);
        if (recovered.length) { toolCalls = recovered; content = ''; }
      }

      if (toolCalls.length) {
        working.push({ role: 'assistant', content, tool_calls: toolCalls });
        if (content.trim()) carried += `${content.trim()}\n\n`;
        let stopTurn = false;
        for (const call of toolCalls) {
          const name = call.function?.name;
          const args = parseArgs(call.function?.arguments);
          let result;
          if (name === 'update_tasks') {
            result = await handleUpdateTasks(args);
          } else if (name === 'ask_user') {
            result = await handleAskUser(args);
            if (result === 'stop') { stopTurn = true; break; }
          } else if (isWriteTool(name)) {
            result = await handleWrite(name, args);
            if (result === 'stop') { stopTurn = true; break; }
          } else {
            result = await executeCodeTool(name, args);
            const failed = !!result?.error || (name === 'run_checks' && result?.allPassed === false);
            steps.push({ tool: name, ...readStep(name, args, result), status: failed ? 'failed' : 'done' });
            flushSteps();
          }
          working.push({ role: 'tool', name, content: JSON.stringify(result).slice(0, 8000) });
        }
        if (stopTurn) {
          await finalize(carried || 'Stopped.');
          return;
        }

        // A background command started this round → check_command /
        // stop_command become available next round (Code parity 2a).
        toolDefs = buildToolDefs();

        // In-turn compaction (Code parity 1b): a long agentic turn's message
        // stack outgrows the window well before maxRounds. When it passes the
        // threshold, have the model summarise its older rounds so it can keep
        // going instead of Ollama silently dropping the start.
        const size = estTokens(working);
        if (size > compactAt && working.length > 4) {
          const fresh = await getSession(sessionId); // pick up any update_tasks
          clearTimeout(turnTimer); // the summariser call is a real generation
          try {
            working = await compactWorking(working, {
              baseUrl: config.ollama.baseUrl,
              model,
              keepAlive: config.code.keepAlive,
              turnSignal: controller.signal,
              tasks: fresh?.tasks,
            });
            const after = estTokens(working);
            steps.push({
              tool: 'compact',
              label: `⋯ Compacted earlier steps to stay in context — ~${fmtTok(size)} → ~${fmtTok(after)} tokens`,
              status: 'done',
            });
            flushSteps();
            logActivity('code', `Code agent compacted context (~${fmtTok(size)} → ~${fmtTok(after)}) — session "${session.title}"`);
          } catch (err) {
            console.error('[code] compaction failed:', err.message);
          }
          turnTimer = setTimeout(() => controller.abort(), timeoutMs);
        }
        continue;
      }

      const finalText = (carried + content).trim();
      if (finalText || applied.length) {
        await finalize(finalText);
        return;
      }
      if (thinking) {
        throw new Error(
          'used the whole reply budget on internal reasoning — raise the reply timeout / token limit, or use a model that does not "think"'
        );
      }
      throw new Error('the model returned an empty reply');
    }

    await finalize(carried, { error: true });
  } catch (err) {
    console.error('[code] turn failed:', err.message);
    if (latest.trim() && !looksLikeToolText(latest)) {
      await finalize(latest);
    } else if (applied.length) {
      await finalize('');
    } else {
      await updateMessage(
        sessionId,
        pending.id,
        { text: `⚠️ Couldn't get a reply — ${err.message}`, steps: steps.length ? steps : undefined, pending: false, error: true },
        { persist: true }
      );
    }
  } finally {
    clearTimeout(turnTimer);
    // Flush this turn's checkpoint and flag the message (Code parity 2c) while
    // the session still reads as busy, so "done" implies the revert button is
    // ready. Only turns that actually wrote a file get one.
    try {
      const cp = await finalizeCheckpoint(sessionId, pending.id);
      if (cp) await updateMessage(sessionId, pending.id, { checkpoint: cp }, { persist: true });
    } catch (err) {
      console.error('[code] checkpoint finalize failed:', err.message);
    }
    controllers.delete(sessionId);
    busySessions.delete(sessionId);
    appEvents.emit('code:turn', { sessionId, running: false });
  }
}

// The Stop button. Aborts the stream (or a held approval), which ends the
// turn keeping whatever steps/text got that far.
export function stopTurn(sessionId) {
  const controller = controllers.get(sessionId);
  if (!controller) return false;
  controller.abort();
  return true;
}

// ---------- Model warmth ----------

let warmTimer = null;
const WARM_REFRESH_MS = 20 * 60 * 1000;

async function preloadDefaultModel() {
  const { code, ollama } = await loadConfig();
  if (!code?.enabled || !code.defaultModel) return;
  try {
    await preloadModel(ollama.baseUrl, code.defaultModel, code.keepAlive);
  } catch (err) {
    console.error('[code] preload failed:', err.message);
  }
}

export function initCodeAgent() {
  preloadDefaultModel().catch(() => {});
  warmTimer = setInterval(() => preloadDefaultModel().catch(() => {}), WARM_REFRESH_MS);
  if (warmTimer.unref) warmTimer.unref();
  console.log('[code] agent ready');
}

export async function onCodeConfigChanged() {
  await preloadDefaultModel().catch(() => {});
}
