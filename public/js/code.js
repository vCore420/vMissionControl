import { api } from './api.js';
import { state, el, toast, escapeHtml, escapeAttr, timeAgo, formatBytes, setLocal } from './core.js';
import { renderMarkdown } from './markdown.js';
import { highlight, langFromPath } from './highlight.js';
import { avatarMarkup } from './avatar.js';

// The Code tab — a coding-agent conversation per session, saved on the host
// and synced to every device (server/codeStore.js). chat.js-shaped: the
// exported render functions are wired into core.js's `callbacks` by app.js so
// the WebSocket sync engine reaches this view without core.js importing it.
//
// This file owns the whole view: the session sidebar, the streamed transcript
// (agent steps, coloured diffs, Confirm/Reject and ask_user cards, the
// context meter, the task and running-processes panels, the revert button),
// the composer (text + 📎 file / 📷 image attachments, the @file and /command
// pickers), and the read-only workspace tree + file viewer.
//
// Assistant message bodies deliberately reuse chat's `.chat-message-text.md`
// styling (Markdown + code blocks) rather than duplicating ~40 lines of CSS —
// it's message text, not chat-specific behaviour.

let modelNames = [];
let modelsLoaded = false;

// Workspace tree state (per device): which folders are expanded, and a
// children cache keyed by folder rel-path. refreshWorkspaceTree() clears the
// cache but keeps the expansion set.
const wsExpanded = new Set(JSON.parse(localStorage.getItem('mc:codeWsExpanded') || '[]'));
let wsChildren = new Map();
let lastAppliedCount = 0; // agent changes seen — bumps trigger a tree refresh
const contextLenCache = new Map(); // model name -> Ollama's reported max context
// The two workspace docs read into the prompt every turn: the source-of-truth
// file (Phase 7) and the agent's memory file (Phase 8). Each is { name, rel,
// exists, bytes, truncated } from /workspace-info, or null when off. They feed
// the context-meter baseline, the tree markers, and (context file only) the
// "create one" prompt.
let contextFileInfo = null;
let memoryFileInfo = null;
const WORKSPACE_DOC_MAX_BYTES = 16 * 1024;

// ---------- The assistant's little face ----------
// A small SVG mascot with three moods. `idle` blinks and bobs; `thinking`
// scans its eyes and pulses its antenna; `error` frowns. All strokes/fills
// use currentColor so it picks up the surrounding text colour (accent on the
// author line, offline on an errored message).
function codeAvatar(mood = 'idle') {
  const mouth =
    mood === 'error'
      ? '<path class="ca-mouth" d="M8.5 16.5 Q12 14 15.5 16.5" />'
      : '<path class="ca-mouth" d="M9 15.5 H15" />';
  return (
    `<svg class="code-avatar mood-${mood}" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">` +
    '<path class="ca-antenna" d="M12 4.2 V1.4" />' +
    '<circle class="ca-antenna-tip" cx="12" cy="1" r="1.1" />' +
    '<rect class="ca-head" x="3.2" y="4" width="17.6" height="15.5" rx="5" />' +
    '<circle class="ca-eye ca-eye-l" cx="9" cy="11" r="1.7" />' +
    '<circle class="ca-eye ca-eye-r" cx="15" cy="11" r="1.7" />' +
    mouth +
    '</svg>'
  );
}

// ---------- Composer placeholder — varied but stable per session ----------
const COMPOSER_PROMPTS = [
  'What do you want to build or change?',
  'What are we working on?',
  "Paste an error and I'll dig in…",
  'Ask about the code, or ask for a change…',
  'Point me at a file or a bug…',
  "What's the goal for this one?",
  'Describe the feature — or the fix…',
  'Where should we start?',
];
function placeholderFor(sessionId) {
  if (!sessionId) return COMPOSER_PROMPTS[0];
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) | 0;
  return COMPOSER_PROMPTS[Math.abs(h) % COMPOSER_PROMPTS.length];
}

// ---------- Context meter ----------
// A rough chars/4 estimate of what the next turn will send (system prompt +
// the workspace docs + the message history the server keeps). Not exact —
// deliberately "about this full", like Claude Code's.
const SYSTEM_PROMPT_TOKENS = 220;
function docTokens(info) {
  if (!info?.exists) return 0;
  return Math.round(Math.min(info.bytes || 0, WORKSPACE_DOC_MAX_BYTES) / 4);
}
function workspaceDocTokens() {
  return docTokens(contextFileInfo) + docTokens(memoryFileInfo);
}
function estimateSessionTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    if (m.pending || m.error || !(m.text || '').trim()) continue;
    chars += m.text.length + 8;
  }
  return SYSTEM_PROMPT_TOKENS + workspaceDocTokens() + Math.round(chars / 4);
}
function formatTokens(n) {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

async function ensureContextLen(model) {
  if (!model || contextLenCache.has(model)) return;
  try {
    const { contextLength } = await api.getCodeModelInfo(model);
    contextLenCache.set(model, contextLength || null);
  } catch {
    contextLenCache.set(model, null);
  }
}

function renderContextMeter() {
  const elMeter = el('codeContextMeter');
  if (!elMeter) return;
  const session = activeSession();
  const messages = session ? state.codeMessages.get(session.id) || [] : [];
  if (!session) { elMeter.classList.add('hidden'); return; }

  const used = estimateSessionTokens(messages);
  // The window the agent actually runs with, clamped to the model's real max.
  const configured = state.config?.code?.contextTokens || 16384;
  const modelMax = contextLenCache.get(session.model || state.config?.code?.defaultModel || '');
  const window = modelMax ? Math.min(configured, modelMax) : configured;
  const pct = Math.min(100, Math.round((used / window) * 100));

  elMeter.classList.remove('hidden');
  elMeter.classList.toggle('warn', pct >= 65 && pct < 85);
  elMeter.classList.toggle('danger', pct >= 85);
  elMeter.innerHTML =
    `<span class="code-context-bar"><span style="width:${pct}%"></span></span>` +
    `<span class="code-context-text">${formatTokens(used)} / ${formatTokens(window)}</span>`;
  elMeter.title = `~${used.toLocaleString()} of ${window.toLocaleString()} context tokens (${pct}%) — estimate`;
}

// The agent's task list (Code parity roadmap 1a) — lives on the session
// (state.codeSessions[i].tasks), kept current by update_tasks → the
// code:sessions broadcast. Re-rendered a lot during streaming, so the list
// DOM is only rebuilt when the tasks actually change.
let codeTasksCollapsed = localStorage.getItem('mc:codeTasksCollapsed') === 'true';
let lastTasksSig = null;

export function renderCodeTasks() {
  const box = el('codeTasks');
  if (!box) return;
  const tasks = activeSession()?.tasks || [];
  box.classList.toggle('hidden', tasks.length === 0);
  box.classList.toggle('collapsed', codeTasksCollapsed);
  if (!tasks.length) {
    if (lastTasksSig !== null) el('codeTasksList').innerHTML = '';
    lastTasksSig = null;
    return;
  }

  const done = tasks.filter((t) => t.status === 'done').length;
  const active = tasks.find((t) => t.status === 'active');
  el('codeTasksSummary').textContent = codeTasksCollapsed && active
    ? `Tasks · ${done}/${tasks.length} · ${active.text}`
    : `Tasks · ${done}/${tasks.length}`;

  const sig = JSON.stringify(tasks);
  if (sig === lastTasksSig) return;
  lastTasksSig = sig;
  const mark = { done: '✓', active: '▸', pending: '○' };
  el('codeTasksList').innerHTML = tasks
    .map((t) => `<li class="code-task ${escapeAttr(t.status)}"><span class="code-task-mark">${mark[t.status] || '○'}</span><span class="code-task-text">${escapeHtml(t.text)}</span></li>`)
    .join('');
}

function codeReady() {
  return !!(state.config?.code?.enabled && state.config?.auth?.enabled);
}

function activeSession() {
  return state.codeSessions.find((s) => s.id === state.activeCodeSessionId) || null;
}

function sortedSessions() {
  return [...state.codeSessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// ---------- View entry ----------

// Show the workspace or the "turn it on" message, per config. Also called
// from core.js when a config broadcast arrives while the Code view is open
// (someone toggled the feature from another device).
export function applyCodeGate() {
  const on = codeReady();
  el('codeLayout').classList.toggle('hidden', !on);
  el('codeDisabledState').classList.toggle('hidden', on);
  return on;
}

export async function enterCodeView() {
  if (!applyCodeGate()) return;

  applySidebarCollapsed();

  try {
    const { sessions, running } = await api.getCodeSessions();
    state.codeSessions = sessions;
    if (Array.isArray(running)) state.codeRunningSessions = new Set(running);
  } catch (err) {
    toast(err.message, true);
    return;
  }

  if (!activeSession()) {
    state.activeCodeSessionId = sortedSessions()[0]?.id || null;
    if (state.activeCodeSessionId) setLocal('mc:codeSession', state.activeCodeSessionId);
  }

  renderCodeSessions();
  if (!modelsLoaded) await loadModels();
  if (state.activeCodeSessionId) await ensureMessages(state.activeCodeSessionId);
  renderCodeMessages();
  renderCodeBackground();

  refreshWorkspaceTree(); // loads the doc info + the tree
}

async function ensureMessages(id) {
  if (state.codeMessages.has(id)) return;
  try {
    const { messages } = await api.getCodeMessages(id);
    state.codeMessages.set(id, messages);
  } catch (err) {
    toast(err.message, true);
    state.codeMessages.set(id, []);
  }
}

// ---------- Sessions ----------

export function renderCodeSessions() {
  const wrap = el('codeSessionList');
  if (!wrap) return;

  // Active session removed on another device — drop the stale pointer so the
  // guard below can pick a live one.
  if (state.activeCodeSessionId && !state.codeSessions.some((s) => s.id === state.activeCodeSessionId)) {
    state.activeCodeSessionId = null;
    localStorage.removeItem('mc:codeSession');
  }

  const sessions = sortedSessions();
  if (!state.activeCodeSessionId && sessions.length) {
    switchCodeSession(sessions[0].id); // re-renders
    return;
  }

  wrap.innerHTML =
    sessions
      .map((s) => {
        const running = state.codeRunningSessions.has(s.id);
        const unseen = !running && state.codeUnseenSessions.has(s.id) && s.id !== state.activeCodeSessionId;
        const cls = ['code-session'];
        if (s.id === state.activeCodeSessionId) cls.push('active');
        if (running) cls.push('running');
        if (unseen) cls.push('unseen');
        const marker = running
          ? '<span class="code-session-spinner" title="Working…"></span>'
          : unseen
            ? '<span class="code-session-dot" title="Reply finished while you were away"></span>'
            : '';
        return `
    <div class="${cls.join(' ')}" data-id="${escapeAttr(s.id)}">
      <button type="button" class="code-session-open">
        <span class="code-session-title">${marker}${escapeHtml(s.title)}</span>
        <span class="code-session-meta">${s.messageCount} msg · ${escapeHtml(timeAgo(s.updatedAt))}</span>
      </button>
      <button type="button" class="code-session-rename" title="Rename">✎</button>
      <button type="button" class="code-session-delete" title="Delete">✕</button>
    </div>`;
      })
      .join('') || '<p class="code-sidebar-empty">No sessions yet — press ＋.</p>';

  wrap.querySelectorAll('.code-session').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('.code-session-open').addEventListener('click', () => switchCodeSession(id));
    row.querySelector('.code-session-rename').addEventListener('click', async (e) => {
      e.stopPropagation();
      const s = state.codeSessions.find((x) => x.id === id);
      const next = prompt('Rename session:', s?.title || '');
      if (!next || !next.trim()) return;
      try {
        await api.updateCodeSession(id, { title: next.trim() });
      } catch (err) {
        toast(err.message, true);
      }
    });
    row.querySelector('.code-session-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      const s = state.codeSessions.find((x) => x.id === id);
      if (!confirm(`Delete "${s?.title || 'this session'}"? Its transcript goes with it.`)) return;
      try {
        await api.deleteCodeSession(id);
        state.codeMessages.delete(id);
        if (state.activeCodeSessionId === id) {
          state.activeCodeSessionId = null;
          localStorage.removeItem('mc:codeSession');
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  const s = activeSession();
  el('codeSessionTitle').textContent = s ? s.title : 'No session';
  syncModelSelect();
  syncApprovalSelect();
  updateSelectsEnabled();

  const curModel = s?.model || state.config?.code?.defaultModel || '';
  if (curModel && !contextLenCache.has(curModel)) ensureContextLen(curModel).then(renderContextMeter);

  // Keep the transcript in step with a (possibly externally changed) session
  // list — e.g. the active session deleted on another device. Skipped on a
  // first load where messages aren't fetched yet; enterCodeView renders them
  // itself once they arrive.
  if (!s || state.codeMessages.has(state.activeCodeSessionId)) renderCodeMessages();
}

export async function switchCodeSession(id) {
  state.activeCodeSessionId = id;
  state.codeUnseenSessions.delete(id); // opening it clears the "finished while away" dot
  setLocal('mc:codeSession', id);
  renderCodeSessions();
  await ensureMessages(id);
  renderCodeMessages();
  renderCodeBackground();
}

el('newCodeSessionBtn').addEventListener('click', async () => {
  try {
    const session = await api.createCodeSession({});
    // The `code:sessions` broadcast refreshes the list and may already have
    // landed during the await — only add it here if it hasn't, so the new
    // session is selectable now without racing a duplicate row in.
    if (!state.codeSessions.some((s) => s.id === session.id)) {
      state.codeSessions.push({ ...session, messageCount: 0 });
    }
    state.codeMessages.set(session.id, []);
    state.activeCodeSessionId = session.id;
    setLocal('mc:codeSession', session.id);
    renderCodeSessions();
    renderCodeMessages();
    el('codeTextInput').focus();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Messages ----------

// Turn `path/to/file.ext:42` tokens in already-rendered, already-escaped HTML
// into links that open the workspace viewer at that line (Code parity roadmap
// 3a). Only text between tags is touched — hrefs and attributes are left
// alone. The `:line` is required, which keeps the match unambiguous (no URLs,
// no `key: value`, no clock times). Paths aren't validated here — a click on a
// stale one just toasts "file not found".
const PATH_LINE_RE = /(?<![\w/:.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7}):(\d+)(?!\d)/g;
function linkifyPaths(html) {
  return String(html).replace(/<[^>]+>|[^<]+/g, (chunk) => {
    if (chunk[0] === '<') return chunk; // a tag — leave it
    return chunk.replace(PATH_LINE_RE, (m, p, line) =>
      `<a class="code-path-ref" role="button" tabindex="0" data-path="${escapeAttr(p)}" data-line="${line}">${m}</a>`
    );
  });
}

// The agent's tool calls this turn, shown above its reply. Read steps with
// output (a file listing, match lines) are collapsible; a write step carries
// a coloured diff. A write awaiting approval (mode = ask, or a delete in
// auto-edit) shows the diff open with Confirm / Reject. Labels carry
// `backtick` spans for paths/queries.
const STEP_MARK = { applied: '✓ ', failed: '✕ ', rejected: '⊘ ', expired: '⏱ ', cancelled: '⊘ ' };

function renderDiff(text) {
  return `<pre class="code-diff">${text
    .split('\n')
    .map((l) => {
      const cls = l.startsWith('@@') ? 'diff-hunk' : l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : 'diff-ctx';
      return `<span class="${cls}">${escapeHtml(l)}</span>`;
    })
    .join('\n')}</pre>`;
}

function renderStep(s) {
  const label = escapeHtml(s.label || s.tool || '').replace(/`([^`]+)`/g, '<code>$1</code>');
  const head = `${STEP_MARK[s.status] || ''}${label}`;
  const status = s.status || 'done';

  // Context compaction (Code parity 1b) — a divider, not a tool step.
  if (s.tool === 'compact') {
    return `<div class="code-step code-step-compact">${escapeHtml(s.label || 'compacted earlier steps')}</div>`;
  }

  if (status === 'pending' && s.approvalId) {
    return `
      <div class="code-step code-step-approval" data-approval="${escapeAttr(s.approvalId)}">
        <div class="code-step-head">${head}</div>
        ${s.detail ? renderDiff(s.detail) : ''}
        <div class="code-step-buttons">
          <button type="button" class="btn primary" data-decide="confirm">Confirm</button>
          <button type="button" class="btn ghost" data-decide="reject">Reject</button>
        </div>
      </div>`;
  }
  if (s.kind === 'question') {
    if (status === 'pending' && s.questionId) {
      const opts = (s.options || [])
        .map((o) => `<button type="button" class="btn ghost code-q-opt" data-answer="${escapeAttr(o)}">${escapeHtml(o)}</button>`)
        .join('');
      return `
        <div class="code-step code-step-question" data-question="${escapeAttr(s.questionId)}">
          <div class="code-step-head">❔ ${escapeHtml(s.label || 'The agent has a question')}</div>
          ${opts ? `<div class="code-step-buttons">${opts}</div>` : ''}
          <div class="code-q-row">
            <input type="text" class="code-q-input" placeholder="Type an answer…" />
            <button type="button" class="btn primary code-q-send">Send</button>
          </div>
        </div>`;
    }
    const answered = status === 'answered' && s.detail;
    return `<div class="code-step code-step-flat code-step-${status}">❔ ${escapeHtml(s.label || 'question')}${
      answered ? ` — <span class="code-q-answer">${escapeHtml(s.detail)}</span>` : ' — (unanswered)'
    }</div>`;
  }
  if (s.kind === 'image' && Array.isArray(s.images) && s.images.length) {
    const thumbs = s.images
      .map((p) => {
        const url = api.codeWorkspaceImageUrl(p);
        return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" title="${escapeAttr(p)}"><img class="code-step-image" src="${escapeAttr(url)}" alt="${escapeAttr(p)}" loading="lazy" /></a>`;
      })
      .join('');
    return `<div class="code-step code-step-${status}"><div class="code-step-head">${head}</div><div class="code-step-images">${thumbs}</div></div>`;
  }
  if (status === 'pending' && s.progress) {
    return `<div class="code-step code-step-flat code-step-pending">${head} <span class="code-step-progress">${escapeHtml(s.progress)}</span></div>`;
  }
  if (s.detail) {
    const inner = s.kind === 'diff' ? renderDiff(s.detail) : `<pre>${linkifyPaths(escapeHtml(s.detail))}</pre>`;
    return `<details class="code-step code-step-${status}"><summary>${head}</summary>${inner}</details>`;
  }
  return `<div class="code-step code-step-flat code-step-${status}">${head}</div>`;
}

function renderSteps(steps) {
  if (!steps || !steps.length) return '';
  return `<div class="code-steps">${steps.map(renderStep).join('')}</div>`;
}

export function renderCodeMessages() {
  const listEl = el('codeMessages');
  if (!listEl) return;
  const session = activeSession();
  const messages = session ? state.codeMessages.get(session.id) || [] : [];

  el('codeNoSessionState').classList.toggle('hidden', !!session);
  el('codeEmptyState').classList.toggle('hidden', !session || messages.length > 0);
  el('codeComposer').classList.toggle('hidden', !session);

  const running = messages.length > 0 && !!messages[messages.length - 1].pending;
  el('codeStopBtn').classList.toggle('hidden', !running);
  updateSelectsEnabled();

  el('codeTextInput').placeholder = placeholderFor(state.activeCodeSessionId);
  el('codeHeaderAvatar').innerHTML = session ? codeAvatar(running ? 'thinking' : 'idle') : '';
  renderContextMeter();
  renderCodeTasks();
  syncSendButton();

  // The agent applied a file change / ran a command since we last looked —
  // the workspace on disk may have moved, so re-read the tree (and the
  // source-of-truth file's state, in case that's what changed).
  const appliedNow = messages.reduce((n, m) => n + (m.steps || []).filter((s) => s.status === 'applied').length, 0);
  if (appliedNow !== lastAppliedCount) {
    lastAppliedCount = appliedNow;
    if (el('codeView').classList.contains('active')) refreshWorkspaceTree();
  }

  const wasNearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;

  // Only the most recent un-reverted checkpoint can be rolled back (2c) — it
  // walks backward as each one is reverted.
  let revertableId = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].checkpoint;
    if (c && !c.revertedAt) { revertableId = messages[i].id; break; }
  }

  listEl.innerHTML = messages
    .map((m) => {
      const cls = ['code-message', m.role === 'assistant' ? 'assistant' : 'user'];
      if (m.error) cls.push('error');
      if (m.pending) cls.push('pending');
      const who = escapeHtml(m.author || (m.role === 'assistant' ? 'assistant' : 'You'));
      // Assistant keeps its animated mascot; a human message shows its
      // sender's profile avatar (Phase 11), by deviceId.
      const avatar =
        m.role === 'assistant'
          ? codeAvatar(m.error ? 'error' : m.pending ? 'thinking' : 'idle')
          : avatarMarkup(m.deviceId ? state.profiles.get(m.deviceId) : null, m.author || 'You');

      const stepsHtml = renderSteps(m.steps);
      const attachHtml = (m.attachments || []).length
        ? `<div class="code-msg-attachments">${m.attachments
            .map(
              (a) =>
                `<span class="code-attach-chip${a.skipped ? ' skipped' : ''}"${
                  a.skipped ? ' title="couldn\'t be read as text"' : a.truncated ? ' title="shown truncated to the model"' : ''
                }><span class="code-attach-name">📄 ${escapeHtml(a.name)}</span>${
                  a.bytes ? `<span class="code-attach-size">${formatBytes(a.bytes)}</span>` : ''
                }${a.truncated ? '<span class="code-attach-size">· truncated</span>' : ''}</span>`
            )
            .join('')}</div>`
        : '';
      // @file mention chips (3a) — clickable, open the workspace viewer.
      const mentionHtml = (m.mentions || []).length
        ? `<div class="code-msg-attachments">${m.mentions
            .map((mn) => {
              const bad = mn.missing || mn.binary;
              return `<span class="code-attach-chip code-mention-chip${bad ? ' skipped' : ''}"${
                bad ? '' : ` role="button" tabindex="0" data-path="${escapeAttr(mn.path)}"`
              } title="${mn.missing ? 'not found in the workspace' : mn.binary ? 'looks binary — not shown' : 'open in the file viewer'}">` +
                `<span class="code-attach-name">🔗 ${escapeHtml(mn.path)}</span>${
                  mn.truncated ? '<span class="code-attach-size">· truncated</span>' : ''
                }${mn.missing ? '<span class="code-attach-size">· missing</span>' : ''}</span>`;
            })
            .join('')}</div>`
        : '';

      // /command marker (3b) — a small badge on the user message.
      const commandHtml = m.command?.name
        ? `<div class="code-msg-command" title="ran the ${
            m.command.source === 'workspace' ? '.mc/commands/' + m.command.name + '.md' : 'built-in'
          } command">⌘ /${escapeHtml(m.command.name)}</div>`
        : '';

      // Attached-image thumbnails (4b) — the vision model's description of each
      // shows in the turn's `vision` step; this is the picture itself.
      const imageHtml = (m.images || []).length
        ? `<div class="code-msg-images">${m.images
            .map((im) =>
              im.file
                ? `<a class="code-msg-image" href="${escapeAttr(
                    api.codeMessageImageUrl(state.activeCodeSessionId, im.file)
                  )}" target="_blank" rel="noopener" title="${escapeAttr(im.name)}"><img src="${escapeAttr(
                    api.codeMessageImageUrl(state.activeCodeSessionId, im.file)
                  )}" alt="${escapeAttr(im.name)}" loading="lazy" /></a>`
                : `<span class="code-attach-chip skipped" title="${escapeAttr(
                    im.error || 'not stored'
                  )}"><span class="code-attach-name">📷 ${escapeHtml(im.name)}</span>${
                    im.error ? `<span class="code-attach-size">· ${escapeHtml(im.error)}</span>` : ''
                  }</span>`
            )
            .join('')}</div>`
        : '';

      let body;
      const hasText = (m.text || '').trim();
      const awaitingApproval = m.pending && (m.steps || []).some((s) => s.status === 'pending' && s.approvalId);
      if (m.pending && !hasText && awaitingApproval) {
        body = '<div class="chat-thinking">waiting for your decision above</div>';
      } else if (m.pending && !hasText) {
        body = '<div class="chat-thinking">thinking<span class="thinking-dots"><i></i><i></i><i></i></span></div>';
      } else if (!hasText && (m.attachments || []).length) {
        body = ''; // an attachment-only message — the chips above say it all
      } else if (m.role === 'assistant' && !m.error) {
        body = `<div class="chat-message-text md">${linkifyPaths(renderMarkdown(m.text))}${m.pending ? '<span class="stream-cursor"></span>' : ''}</div>`;
      } else {
        body = `<div class="chat-message-text">${escapeHtml(m.text)}</div>`;
      }

      const planBtn =
        m.role === 'assistant' && m.planMode && !m.pending && !m.error && hasText
          ? `<button type="button" class="btn ghost code-save-plan" data-msg="${escapeAttr(m.id)}">Save plan → memory</button>`
          : '';

      // Per-turn revert (2c) — the button on the newest un-reverted checkpoint,
      // or a note once a turn has been rolled back.
      const cp = m.checkpoint;
      const revertBtn =
        m.role === 'assistant' && cp && !m.pending
          ? cp.revertedAt
            ? `<div class="code-revert-note">↩ Reverted${
                cp.result
                  ? ` — ${cp.result.restored} restored, ${cp.result.removed} removed${
                      cp.result.errors ? `, ${cp.result.errors} failed` : ''
                    }`
                  : ''
              }</div>`
            : m.id === revertableId
              ? `<button type="button" class="btn ghost code-revert-btn" data-msg="${escapeAttr(m.id)}"${
                  cp.commandsRun ? ' title="Shell commands this turn ran are not undone"' : ''
                }>↩ Revert this turn${cp.commandsRun ? ' ⚠' : ''}</button>`
              : ''
          : '';

      return `
      <div class="${cls.join(' ')}">
        <div class="code-message-meta">
          ${avatar}
          <span class="code-message-author">${who}</span>
          ${m.pending ? '' : `<span class="code-message-time">${escapeHtml(timeAgo(m.createdAt))}</span>`}
        </div>
        ${commandHtml}
        ${attachHtml}
        ${mentionHtml}
        ${imageHtml}
        ${stepsHtml}
        ${body}
        ${planBtn}
        ${revertBtn}
      </div>`;
    })
    .join('');

  listEl.querySelectorAll('.code-step-approval [data-decide]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const wrap = btn.closest('.code-step-approval');
      wrap.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        await api.decideCodeApproval(state.activeCodeSessionId, wrap.dataset.approval, btn.dataset.decide);
        // the step updates in place via the codeMessageUpdated broadcast
      } catch (err) {
        toast(err.message, true);
        renderCodeMessages();
      }
    });
  });

  listEl.querySelectorAll('.code-save-plan').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Saving…';
      try {
        const { rel, bytes } = await api.saveCodePlan(state.activeCodeSessionId, btn.dataset.msg);
        btn.textContent = `Saved to ${rel} ✓`;
        if (bytes > 14000) toast(`${rel} is getting large (${(bytes / 1024).toFixed(0)} KB) — prune old entries so new ones stay in context`);
        if (el('codeView').classList.contains('active')) refreshWorkspaceTree();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });

  listEl.querySelectorAll('.code-revert-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Revert every file this turn changed back to its state before the turn?\n\nShell commands the turn ran are not undone.')) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Reverting…';
      try {
        const r = await api.revertCodeTurn(state.activeCodeSessionId, btn.dataset.msg);
        toast(
          `Reverted — ${r.restored.length} restored, ${r.removed.length} removed${
            r.skipped.length ? `, ${r.skipped.length} skipped` : ''
          }${r.errors.length ? `, ${r.errors.length} failed` : ''}`
        );
        // the message flips to its "Reverted" note via the codeMessageUpdated
        // broadcast; the files on disk moved, so re-read the tree.
        if (el('codeView').classList.contains('active')) refreshWorkspaceTree();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });

  // ask_user question cards — an option button or the text box + Send.
  listEl.querySelectorAll('.code-step-question').forEach((wrap) => {
    const send = async (answer) => {
      if (!answer.trim()) return;
      wrap.querySelectorAll('button, input').forEach((e) => (e.disabled = true));
      try {
        await api.answerCodeQuestion(state.activeCodeSessionId, wrap.dataset.question, answer);
        // the step updates in place via the codeMessageUpdated broadcast
      } catch (err) {
        toast(err.message, true);
        renderCodeMessages();
      }
    };
    wrap.querySelectorAll('.code-q-opt').forEach((b) => b.addEventListener('click', () => send(b.dataset.answer)));
    const input = wrap.querySelector('.code-q-input');
    wrap.querySelector('.code-q-send')?.addEventListener('click', () => send(input.value));
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send(input.value); }
    });
  });

  if (wasNearBottom || running) listEl.scrollTop = listEl.scrollHeight;
}

// path:line links (3a) and workspace-mention chips both open the file viewer —
// one delegated listener, since #codeMessages is fully re-rendered each turn.
el('codeMessages').addEventListener('click', (e) => {
  const ref = e.target.closest('.code-path-ref, .code-mention-chip');
  if (!ref) return;
  e.preventDefault();
  openWorkspaceFile(ref.dataset.path, Number(ref.dataset.line) || 0);
});
el('codeMessages').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const ref = e.target.closest('.code-path-ref, .code-mention-chip[data-path]');
  if (!ref) return;
  e.preventDefault();
  openWorkspaceFile(ref.dataset.path, Number(ref.dataset.line) || 0);
});

// ---------- Message attachments (Phase 9) ----------
// Text files the user attaches to a message. Read client-side; the text rides
// along in the send POST and reaches the agent for that one turn only (the
// server never stores it). Non-text / oversized files are still shown as a
// chip so the pick is acknowledged, but contribute only a note to the turn.

let stagedAttachments = []; // { name, size, content, skipped, reason }
const ATTACH_READ_LIMIT = 400 * 1024; // don't read a file bigger than this client-side
const ATTACH_MAX_FILES = 5;
const TEXT_EXT_RE =
  /\.(txt|text|md|markdown|rst|log|json|jsonc|ndjson|ya?ml|toml|ini|cfg|conf|config|env|properties|csv|tsv|xml|html?|css|s[ac]ss|less|diff|patch|m?[cj]s|tsx?|jsx|vue|svelte|py|rb|go|rs|java|kt|swift|scala|clj|exs?|c|h|cpp|cc|hpp|cs|php|pl|pm|lua|r|sql|graphql|proto|sh|bash|zsh|fish|ps1|bat|cmd)$/i;
const TEXT_BASENAME_RE = /^(dockerfile|makefile|\.?gitignore|\.?editorconfig|\.?npmrc|\.env)/i;

function looksTextByName(name) {
  return TEXT_EXT_RE.test(name) || TEXT_BASENAME_RE.test(name) || !name.includes('.');
}

function readFileText(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => resolve('');
    r.readAsText(file);
  });
}

async function stageFiles(fileList) {
  const files = [...fileList];
  for (const file of files) {
    if (stagedAttachments.length >= ATTACH_MAX_FILES) {
      toast(`Up to ${ATTACH_MAX_FILES} files per message`, true);
      break;
    }
    if (stagedAttachments.some((a) => a.name === file.name && a.size === file.size)) continue;
    if (!looksTextByName(file.name)) {
      stagedAttachments.push({ name: file.name, size: file.size, content: '', skipped: true, reason: 'not a text file' });
      continue;
    }
    if (file.size > ATTACH_READ_LIMIT) {
      stagedAttachments.push({ name: file.name, size: file.size, content: '', skipped: true, reason: 'too big to attach' });
      continue;
    }
    const content = await readFileText(file);
    const binary = content.indexOf(String.fromCharCode(0)) !== -1; // NUL => binary read as text
    stagedAttachments.push({
      name: file.name,
      size: file.size,
      content: binary ? '' : content,
      skipped: binary,
      reason: 'looks binary',
    });
  }
  renderAttachRow();
  syncSendButton();
}

function renderAttachRow() {
  const row = el('codeAttachRow');
  if (!row) return;
  row.classList.toggle('hidden', stagedAttachments.length === 0);
  row.innerHTML = stagedAttachments
    .map(
      (a, i) =>
        `<span class="code-attach-chip${a.skipped ? ' skipped' : ''}" title="${a.skipped ? escapeAttr(a.reason) : 'sent to the model with this message'}">` +
        `<span class="code-attach-name">📄 ${escapeHtml(a.name)}</span>` +
        `<span class="code-attach-size">${formatBytes(a.size)}</span>` +
        `<button type="button" class="code-attach-x" data-i="${i}" aria-label="Remove">✕</button></span>`
    )
    .join('');
  row.querySelectorAll('.code-attach-x').forEach((btn) => {
    btn.addEventListener('click', () => {
      stagedAttachments.splice(Number(btn.dataset.i), 1);
      renderAttachRow();
      syncSendButton();
    });
  });
}

el('codeAttachBtn').addEventListener('click', () => el('codeFileInput').click());
el('codeFileInput').addEventListener('change', (e) => {
  stageFiles(e.target.files);
  e.target.value = '';
});

// Split a dropped/pasted file list — images go to the vision path (4b), the
// rest to the text-attachment path.
function routeFiles(fileList) {
  const files = [...fileList];
  const imgs = files.filter((f) => /^image\//i.test(f.type));
  const rest = files.filter((f) => !/^image\//i.test(f.type));
  if (imgs.length) stageImages(imgs);
  if (rest.length) stageFiles(rest);
}

// Drag a file onto the composer, or paste one.
const composerEl = el('codeComposer');
composerEl.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault();
    composerEl.classList.add('drag-over');
  }
});
composerEl.addEventListener('dragleave', (e) => {
  if (e.target === composerEl) composerEl.classList.remove('drag-over');
});
composerEl.addEventListener('drop', (e) => {
  composerEl.classList.remove('drag-over');
  if (e.dataTransfer?.files?.length) {
    e.preventDefault();
    routeFiles(e.dataTransfer.files);
  }
});
el('codeTextInput').addEventListener('paste', (e) => {
  if (e.clipboardData?.files?.length) {
    e.preventDefault();
    routeFiles(e.clipboardData.files);
  }
});

// ---------- Image attachments (Code parity roadmap 4b) ----------
// Attach a screenshot (📷 / paste / drag). Read to a data URL client-side and
// sent as `images` — the vision model in Settings → Code describes it and the
// coding model acts on that description (server/codeVision.js).

let stagedImages = []; // { name, dataUrl, size }
const IMG_READ_LIMIT = 4 * 1024 * 1024; // matches server/codeImages.js MAX_IMAGE_BYTES
const IMG_MAX = 4;
const IMG_TYPE_RE = /^image\/(png|jpe?g|webp|gif)$/i;

function readFileDataUrl(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => resolve('');
    r.readAsDataURL(file);
  });
}

async function stageImages(fileList) {
  for (const file of [...fileList]) {
    if (!IMG_TYPE_RE.test(file.type)) {
      toast(`${file.name || 'that image'} — only PNG / JPEG / WebP / GIF`, true);
      continue;
    }
    if (stagedImages.length >= IMG_MAX) {
      toast(`Up to ${IMG_MAX} images per message`, true);
      break;
    }
    if (file.size > IMG_READ_LIMIT) {
      toast(`${file.name || 'image'} is too large (max 4 MB)`, true);
      continue;
    }
    const dataUrl = await readFileDataUrl(file);
    if (!dataUrl) continue;
    stagedImages.push({
      name: file.name || `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`,
      dataUrl,
      size: file.size,
    });
  }
  renderImageRow();
  syncSendButton();
}

function renderImageRow() {
  const row = el('codeImageRow');
  if (!row) return;
  row.classList.toggle('hidden', stagedImages.length === 0);
  row.innerHTML = stagedImages
    .map(
      (im, i) =>
        `<span class="code-image-chip" title="${escapeAttr(im.name)} — the vision model will describe this">` +
        `<img class="code-image-thumb" src="${escapeAttr(im.dataUrl)}" alt="" />` +
        `<span class="code-attach-name">${escapeHtml(im.name)}</span>` +
        `<button type="button" class="code-image-x" data-i="${i}" aria-label="Remove">✕</button></span>`
    )
    .join('');
  row.querySelectorAll('.code-image-x').forEach((btn) => {
    btn.addEventListener('click', () => {
      stagedImages.splice(Number(btn.dataset.i), 1);
      renderImageRow();
      syncSendButton();
    });
  });
}

el('codeImageBtn').addEventListener('click', () => el('codeImageInput').click());
el('codeImageInput').addEventListener('change', (e) => {
  stageImages(e.target.files);
  e.target.value = '';
});

// ---------- @file mentions (Code parity roadmap 3a) ----------
// Typing `@` in the composer opens a fuzzy picker over every workspace file;
// choosing one stages it as a chip (the `@token` text is removed) and its
// current contents are read server-side onto that turn. Same "context for this
// turn only" model as an attachment — see server/codeMentions.js.

let stagedMentions = []; // workspace-relative paths
let wsFilesCache = null; // string[] — fetched once per Code-view entry
let mentionTokenStart = -1; // index of the `@` currently being completed, or -1
let mentionIndex = 0; // highlighted row in the open picker
const MENTION_MAX = 8;

async function ensureWsFiles() {
  if (wsFilesCache) return wsFilesCache;
  try {
    const { files } = await api.getCodeWorkspaceFiles();
    wsFilesCache = Array.isArray(files) ? files : [];
  } catch {
    wsFilesCache = [];
  }
  return wsFilesCache;
}

function renderMentionRow() {
  const row = el('codeMentionRow');
  if (!row) return;
  row.classList.toggle('hidden', stagedMentions.length === 0);
  row.innerHTML = stagedMentions
    .map(
      (p, i) =>
        `<span class="code-attach-chip" title="its current contents are sent with this message">` +
        `<span class="code-attach-name">🔗 ${escapeHtml(p)}</span>` +
        `<button type="button" class="code-mention-x" data-i="${i}" aria-label="Remove">✕</button></span>`
    )
    .join('');
  row.querySelectorAll('.code-mention-x').forEach((btn) => {
    btn.addEventListener('click', () => {
      stagedMentions.splice(Number(btn.dataset.i), 1);
      renderMentionRow();
      syncSendButton();
    });
  });
}

// Rank: basename starts with the query, then basename contains it, then the
// path contains it. Blank query → the first files as-is.
function rankFiles(files, q) {
  const needle = q.toLowerCase();
  if (!needle) return files.slice(0, MENTION_MAX);
  const scored = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = lower.split('/').pop();
    let score = -1;
    if (base.startsWith(needle)) score = 0;
    else if (base.includes(needle)) score = 1;
    else if (lower.includes(needle)) score = 2;
    if (score >= 0) scored.push({ f, score });
  }
  scored.sort((a, b) => a.score - b.score || a.f.length - b.f.length);
  return scored.slice(0, MENTION_MAX).map((s) => s.f);
}

// Shared close for both the @file and /command pickers (they share the DOM).
function closePicker() {
  mentionTokenStart = -1;
  commandPickerOpen = false;
  el('codeMentionPicker').classList.add('hidden');
  el('codeMentionPicker').innerHTML = '';
}

// Find an `@token` ending at the caret ("@" at string start or after a space).
function mentionQueryAtCaret() {
  const ta = el('codeTextInput');
  const upto = ta.value.slice(0, ta.selectionStart);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(upto);
  if (!m) return null;
  return { start: ta.selectionStart - m[1].length - 1, query: m[1] };
}

async function updateMentionPicker() {
  const hit = mentionQueryAtCaret();
  if (!hit) {
    if (mentionTokenStart !== -1) closePicker();
    return;
  }
  mentionTokenStart = hit.start;
  const files = rankFiles(await ensureWsFiles(), hit.query);
  const picker = el('codeMentionPicker');
  if (!files.length) {
    picker.innerHTML = `<div class="code-mention-empty">no workspace file matches "${escapeHtml(hit.query)}"</div>`;
    picker.classList.remove('hidden');
    return;
  }
  mentionIndex = Math.min(mentionIndex, files.length - 1);
  picker.innerHTML = files
    .map(
      (f, i) =>
        `<button type="button" class="code-mention-opt${i === mentionIndex ? ' active' : ''}" role="option" data-path="${escapeAttr(
          f
        )}">${escapeHtml(f)}</button>`
    )
    .join('');
  picker.classList.remove('hidden');
  picker.querySelectorAll('.code-mention-opt').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus in the textarea
      pickMention(btn.dataset.path);
    });
  });
}

function pickMention(path) {
  const ta = el('codeTextInput');
  if (mentionTokenStart >= 0) {
    ta.value = ta.value.slice(0, mentionTokenStart) + ta.value.slice(ta.selectionStart);
    ta.selectionStart = ta.selectionEnd = mentionTokenStart;
  }
  if (!stagedMentions.includes(path)) {
    if (stagedMentions.length >= MENTION_MAX) toast(`Up to ${MENTION_MAX} @files per message`, true);
    else stagedMentions.push(path);
  }
  closePicker();
  renderMentionRow();
  syncSendButton();
  ta.focus();
}

el('codeMentionBtn').addEventListener('click', () => {
  const ta = el('codeTextInput');
  const at = ta.selectionStart;
  const before = ta.value.slice(0, at);
  const needsSpace = before && !before.endsWith(' ') && !before.endsWith('\n');
  ta.value = before + (needsSpace ? ' @' : '@') + ta.value.slice(at);
  ta.selectionStart = ta.selectionEnd = at + (needsSpace ? 2 : 1);
  ta.focus();
  mentionIndex = 0;
  updateMentionPicker();
});

// ---------- /command picker (Code parity roadmap 3b) ----------
// Typing `/name` at the very start of an empty-so-far message opens a picker
// of the built-in and workspace commands; choosing one fills `/name ` so the
// user types args. The server expands the template — see server/codeCommands.js.

let wsCommandsCache = null;
let commandPickerOpen = false;

async function ensureCommands() {
  if (wsCommandsCache) return wsCommandsCache;
  try {
    const { commands } = await api.getCodeCommands();
    wsCommandsCache = Array.isArray(commands) ? commands : [];
  } catch {
    wsCommandsCache = [];
  }
  return wsCommandsCache;
}

// A bare `/` or `/name` occupying the whole input (no space yet) → { query }.
function slashQueryAtStart() {
  const ta = el('codeTextInput');
  if (ta.selectionStart !== ta.value.length) return null;
  const m = /^\/([\w-]*)$/.exec(ta.value);
  return m ? { query: m[1].toLowerCase() } : null;
}

// Returns true when it owns the picker this keystroke (so updateMentionPicker
// is skipped), false otherwise.
async function updateCommandPicker() {
  const hit = slashQueryAtStart();
  if (!hit) {
    if (commandPickerOpen) closePicker();
    return false;
  }
  commandPickerOpen = true;
  mentionTokenStart = -1;
  const cmds = (await ensureCommands()).filter((c) => c.name.startsWith(hit.query));
  const picker = el('codeMentionPicker');
  if (!cmds.length) {
    picker.innerHTML = `<div class="code-mention-empty">no /command matches "${escapeHtml(hit.query)}" — add one as .mc/commands/${escapeHtml(
      hit.query
    )}.md</div>`;
    picker.classList.remove('hidden');
    return true;
  }
  mentionIndex = Math.min(mentionIndex, cmds.length - 1);
  picker.innerHTML = cmds
    .map(
      (c, i) =>
        `<button type="button" class="code-mention-opt code-command-opt${i === mentionIndex ? ' active' : ''}" role="option" data-command="${escapeAttr(
          c.name
        )}"><span class="code-command-name">/${escapeHtml(c.name)}</span>${
          c.description ? `<span class="code-command-desc">${escapeHtml(c.description)}</span>` : ''
        }${c.source === 'workspace' ? '<span class="code-command-src">.mc</span>' : ''}</button>`
    )
    .join('');
  picker.classList.remove('hidden');
  picker.querySelectorAll('.code-mention-opt').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pickCommand(btn.dataset.command);
    });
  });
  return true;
}

function pickCommand(name) {
  const ta = el('codeTextInput');
  ta.value = `/${name} `;
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  closePicker();
  syncSendButton();
  ta.focus();
}

el('codeCommandBtn').addEventListener('click', () => {
  const ta = el('codeTextInput');
  // Only meaningful at the start of an otherwise-empty message.
  if (ta.value.trim() && !ta.value.startsWith('/')) {
    toast('A /command has to be the whole message — clear the box first', true);
    return;
  }
  ta.value = '/' + ta.value.replace(/^\/+/, '').trimStart();
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  ta.focus();
  mentionIndex = 0;
  updateCommandPicker();
});

function syncSendButton() {
  const canSend =
    !!state.activeCodeSessionId &&
    (el('codeTextInput').value.trim() ||
      stagedAttachments.length > 0 ||
      stagedMentions.length > 0 ||
      stagedImages.length > 0);
  el('codeSendBtn').disabled = !canSend;
}

el('codeTextInput').addEventListener('input', async () => {
  mentionIndex = 0;
  // The /command picker gets first refusal (its token is `/name` at the very
  // start); if it doesn't own this keystroke, fall through to @file mentions.
  if (!(await updateCommandPicker())) updateMentionPicker();
  syncSendButton();
});
el('codeTextInput').addEventListener('blur', () => setTimeout(closePicker, 120));

el('codeTextInput').addEventListener('keydown', (e) => {
  const pickerOpen = !el('codeMentionPicker').classList.contains('hidden');
  if (pickerOpen) {
    const opts = [...el('codeMentionPicker').querySelectorAll('.code-mention-opt')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!opts.length) return;
      mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length;
      opts.forEach((o, i) => o.classList.toggle('active', i === mentionIndex));
      opts[mentionIndex].scrollIntoView({ block: 'nearest' });
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && opts[mentionIndex]) {
      e.preventDefault();
      const opt = opts[mentionIndex];
      if (opt.dataset.command) pickCommand(opt.dataset.command);
      else pickMention(opt.dataset.path);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    el('codeComposer').requestSubmit();
  }
});

// The example chips in the empty state — fill the composer, don't send.
el('codeEmptyState').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-fill]');
  if (!chip) return;
  el('codeTextInput').value = chip.dataset.fill;
  syncSendButton();
  el('codeTextInput').focus();
});

el('codeComposer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = el('codeTextInput');
  const text = input.value.trim();
  if (
    (!text && !stagedAttachments.length && !stagedMentions.length && !stagedImages.length) ||
    !state.activeCodeSessionId
  ) {
    return;
  }
  const sending = stagedAttachments.map((a) => ({ name: a.name, content: a.content }));
  const mentions = [...stagedMentions];
  const images = stagedImages.map((im) => ({ name: im.name, dataUrl: im.dataUrl }));
  input.value = '';
  stagedAttachments = [];
  stagedMentions = [];
  stagedImages = [];
  closePicker();
  renderAttachRow();
  renderMentionRow();
  renderImageRow();
  syncSendButton();
  try {
    await api.sendCodeMessage(state.activeCodeSessionId, {
      author: state.deviceName,
      text,
      ...(sending.length ? { attachments: sending } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(images.length ? { images } : {}),
    });
    // The user message + the assistant's streaming reply both arrive over the
    // WebSocket (handleWsCodeMessage), same as chat — nothing added here.
  } catch (err) {
    toast(err.message, true);
    input.value = text;
    stagedAttachments = sending.map((a) => ({ ...a, size: a.content.length, skipped: false }));
    stagedMentions = mentions;
    stagedImages = images.map((im) => ({ ...im, size: 0 }));
    renderAttachRow();
    renderMentionRow();
    renderImageRow();
    syncSendButton();
  }
});

el('codeStopBtn').addEventListener('click', async () => {
  if (!state.activeCodeSessionId) return;
  try {
    await api.stopCodeTurn(state.activeCodeSessionId);
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Task list (Code parity roadmap 1a) ----------

el('codeTasksToggle').addEventListener('click', () => {
  codeTasksCollapsed = !codeTasksCollapsed;
  setLocal('mc:codeTasksCollapsed', String(codeTasksCollapsed));
  lastTasksSig = null; // the summary text depends on the collapsed state
  renderCodeTasks();
});

el('codeTasksClear').addEventListener('click', async () => {
  const s = activeSession();
  if (!s || !(s.tasks || []).length) return;
  s.tasks = []; // optimistic — the code:sessions broadcast confirms
  renderCodeTasks();
  try {
    await api.updateCodeSession(s.id, { tasks: [] });
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Running-processes strip (Code parity roadmap 2a) ----------
// Background shell commands the agent started with run_command({background}).
// The list isn't in `state` — it's fetched for the active session on view
// entry, on session switch, on the code:background WS event, and on a slow
// poll while something is still running (buffered output and the eventual
// exit arrive between events).

let bgList = [];
let bgPollTimer = null;

export async function renderCodeBackground() {
  const box = el('codeBackground');
  if (!box) return;
  const s = activeSession();
  if (!s || !codeReady()) {
    box.classList.add('hidden');
    bgList = [];
    stopBackgroundPoll();
    return;
  }
  try {
    const { background } = await api.getCodeBackground(s.id);
    bgList = Array.isArray(background) ? background : [];
  } catch {
    // A transient fetch error shouldn't blank a strip that's showing real
    // processes — keep the last-known list up and try again on the next tick.
  }
  paintCodeBackground();
  if (bgList.some((b) => b.running)) startBackgroundPoll();
  else stopBackgroundPoll();
}

function paintCodeBackground() {
  const box = el('codeBackground');
  box.classList.toggle('hidden', bgList.length === 0);
  if (!bgList.length) return;
  const running = bgList.filter((b) => b.running).length;
  el('codeBackgroundSummary').textContent = running
    ? `Running process${running === 1 ? '' : 'es'} · ${running}`
    : `Background process${bgList.length === 1 ? '' : 'es'} · ${bgList.length} stopped`;
  el('codeBackgroundList').innerHTML = bgList
    .map((b) => {
      const stateHtml = b.running
        ? '<span class="code-bg-state running">running</span>'
        : `<span class="code-bg-state">exit ${b.exitCode ?? '?'}</span>`;
      return `<li class="code-bg-row" data-bg="${escapeAttr(b.bgId)}">
        <span class="code-bg-cmd" title="${escapeAttr(b.tail || b.command)}">${escapeHtml(b.command)}</span>
        ${stateHtml}
        ${b.running ? '<button type="button" class="code-bg-stop icon-btn" title="Stop this process">✕</button>' : ''}
      </li>`;
    })
    .join('');
  el('codeBackgroundList').querySelectorAll('.code-bg-stop').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-bg]')?.dataset.bg;
      if (!id) return;
      btn.disabled = true;
      try {
        await api.stopCodeBackground(id);
        renderCodeBackground();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    });
  });
}

function startBackgroundPoll() {
  if (bgPollTimer) return;
  bgPollTimer = setInterval(() => {
    if (el('codeView').classList.contains('active')) renderCodeBackground();
    else stopBackgroundPoll();
  }, 4000);
}
function stopBackgroundPoll() {
  if (bgPollTimer) {
    clearInterval(bgPollTimer);
    bgPollTimer = null;
  }
}

// ---------- Model picker (per session) ----------

async function loadModels() {
  try {
    const { models } = await api.getOllamaModels();
    modelNames = models.map((m) => m.name);
    modelsLoaded = true;
  } catch {
    modelNames = [];
  }
  syncModelSelect();
}

function syncModelSelect() {
  const sel = el('codeModelSelect');
  if (!sel) return;
  const session = activeSession();
  const current = session?.model || state.config?.code?.defaultModel || '';
  const options = [...modelNames];
  if (current && !options.includes(current)) options.unshift(current);
  sel.innerHTML = options.length
    ? options
        .map(
          (n) =>
            `<option value="${escapeAttr(n)}"${n === current ? ' selected' : ''}>${escapeHtml(n)}${
              modelNames.includes(n) ? '' : ' — not installed'
            }</option>`
        )
        .join('')
    : '<option value="">No models — pull one in Ollama</option>';
}

function syncApprovalSelect() {
  const sel = el('codeApprovalSelect');
  if (!sel) return;
  const session = activeSession();
  sel.value = session?.approvalMode || state.config?.code?.defaultApprovalMode || 'ask';
  const plan = el('codePlanMode');
  if (plan) {
    plan.checked = !!session?.planMode;
    plan.closest('.code-plan-toggle')?.classList.toggle('on', !!session?.planMode);
  }
}

// The header selects are read-only while a turn (or a held approval) is
// running — changing them then would be confusing since the current turn
// already read its model + mode at the start.
function isTurnRunning() {
  const msgs = state.codeMessages.get(state.activeCodeSessionId) || [];
  return msgs.length > 0 && !!msgs[msgs.length - 1].pending;
}
function updateSelectsEnabled() {
  const on = !!activeSession() && !isTurnRunning();
  el('codeModelSelect').disabled = !on;
  el('codeApprovalSelect').disabled = !on;
  if (el('codePlanMode')) el('codePlanMode').disabled = !on;
}

el('codeModelSelect').addEventListener('change', async (e) => {
  const session = activeSession();
  if (!session) return;
  ensureContextLen(e.target.value).then(renderContextMeter);
  try {
    await api.updateCodeSession(session.id, { model: e.target.value });
  } catch (err) {
    toast(err.message, true);
  }
});

el('codeApprovalSelect').addEventListener('change', async (e) => {
  const session = activeSession();
  if (!session) return;
  try {
    await api.updateCodeSession(session.id, { approvalMode: e.target.value });
  } catch (err) {
    toast(err.message, true);
  }
});

el('codePlanMode').addEventListener('change', async (e) => {
  const session = activeSession();
  if (!session) return;
  e.target.closest('.code-plan-toggle')?.classList.toggle('on', e.target.checked);
  try {
    await api.updateCodeSession(session.id, { planMode: e.target.checked });
  } catch (err) {
    toast(err.message, true);
    e.target.checked = !e.target.checked;
  }
});

// ---------- Workspace tree (read-only) ----------

function joinRel(a, b) {
  return a ? `${a}/${b}` : b;
}

async function loadWorkspaceInfo() {
  try {
    const { path, contextFile, memoryFile } = await api.getCodeWorkspaceInfo();
    const label = el('codeWorkspacePath');
    label.textContent = path;
    label.title = path;
    contextFileInfo = contextFile;
    memoryFileInfo = memoryFile;
    renderContextFilePrompt();
    renderContextMeter();
  } catch {
    /* the tree below will show its own error */
  }
}

// "No <source-of-truth file> yet — create one" above the tree, when a name is
// configured but the file doesn't exist. Once it's there the tree marker
// carries it. (The name is dynamic — AGENTS.md by default.)
function renderContextFilePrompt() {
  const box = el('codeContextFilePrompt');
  if (!box) return;
  if (!contextFileInfo || contextFileInfo.exists) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML =
    `<span>No <code>${escapeHtml(contextFileInfo.name)}</code> yet — the agent's source-of-truth file.</span>` +
    `<button type="button" id="codeCreateContextFile">Create one</button>`;
  el('codeCreateContextFile').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api.createCodeContextFile();
      await refreshWorkspaceTree();
      renderCodeMessages();
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
    }
  });
}

async function ensureChildren(rel) {
  if (wsChildren.has(rel)) return;
  try {
    const { items } = await api.getCodeWorkspace(rel);
    wsChildren.set(rel, items);
  } catch {
    wsChildren.set(rel, null); // null = failed to load
  }
}

// Re-fetch the workspace from scratch — the prompt docs' state (for the tree
// markers, meter, and "create one" prompt) and the visible tree, keeping
// folders expanded.
async function refreshWorkspaceTree() {
  wsChildren = new Map();
  wsFilesCache = null; // the @-mention picker's flat list is stale too
  wsCommandsCache = null; // and the /command picker (.mc/commands/*.md may have changed)
  await loadWorkspaceInfo();
  await renderWorkspaceTree();
}

async function renderWorkspaceTree() {
  const treeEl = el('codeWorkspaceList');
  if (!treeEl) return;
  await ensureChildren('');
  // Load every expanded folder so the recursive render has its children.
  for (const rel of wsExpanded) await ensureChildren(rel);

  const root = wsChildren.get('');
  if (root === null) {
    treeEl.innerHTML = '<p class="code-ws-empty">couldn\'t read the workspace</p>';
    return;
  }
  treeEl.innerHTML = root.length ? renderWsLevel('', 0) : '<p class="code-ws-empty">empty</p>';

  treeEl.querySelectorAll('.code-ws-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rel = btn.dataset.rel;
      if (btn.dataset.type === 'dir') {
        if (wsExpanded.has(rel)) wsExpanded.delete(rel);
        else wsExpanded.add(rel);
        setLocal('mc:codeWsExpanded', JSON.stringify([...wsExpanded]));
        renderWorkspaceTree();
      } else {
        openWorkspaceFile(rel);
      }
    });
  });
}

function renderWsLevel(rel, depth) {
  const items = wsChildren.get(rel) || [];
  return items
    .map((it) => {
      const childRel = joinRel(rel, it.name);
      const pad = `style="--depth:${depth}"`;
      if (it.type === 'dir') {
        const open = wsExpanded.has(childRel);
        return `
          <div class="code-ws-node">
            <button type="button" class="code-ws-item" data-rel="${escapeAttr(childRel)}" data-type="dir" ${pad}>
              <span class="code-ws-caret">${open ? '▾' : '▸'}</span>
              <span class="code-ws-name">${escapeHtml(it.name)}</span>
            </button>
            ${open ? `<div class="code-ws-children">${renderWsLevel(childRel, depth + 1)}</div>` : ''}
          </div>`;
      }
      // The two prompt docs get a badge — they're read every turn, like an
      // overridden chat channel's persona dot.
      let badge = '';
      let markClass = '';
      let title = '';
      if (contextFileInfo?.exists && childRel === contextFileInfo.rel) {
        badge = '<span class="code-ws-doc">source</span>';
        markClass = ' is-prompt-doc';
        title = ` title="Source-of-truth file — the agent reads this every turn${contextFileInfo.truncated ? ' (over 16 KB — the tail is dropped)' : ''}"`;
      } else if (memoryFileInfo?.exists && childRel === memoryFileInfo.rel) {
        badge = '<span class="code-ws-doc memory">memory</span>';
        markClass = ' is-prompt-doc';
        title = ` title="The agent's memory file — read every turn, appended to as it learns${memoryFileInfo.truncated ? ' (over 16 KB — the tail is dropped)' : ''}"`;
      }
      return `
        <div class="code-ws-node">
          <button type="button" class="code-ws-item${markClass}" data-rel="${escapeAttr(childRel)}" data-type="file" ${pad}${title}>
            <span class="code-ws-caret"></span>
            <span class="code-ws-name">${escapeHtml(it.name)}</span>
            ${badge}
          </button>
        </div>`;
    })
    .join('');
}

// `line` (3a) — jump the viewer to a 1-based line and flag it. The content is
// rendered a line at a time with a number gutter so a line is addressable;
// each line is highlighted on its own (a block comment loses its cross-line
// colour — a fair trade for a lightweight viewer).
async function openWorkspaceFile(rel, line = 0) {
  try {
    const { text, truncated } = await api.getCodeWorkspaceFile(rel);
    const lang = langFromPath(rel);
    el('codeFileModalTitle').textContent = line ? `${rel}:${line}` : rel;
    el('codeFileContent').innerHTML = String(text)
      .split('\n')
      .map(
        (ln, i) =>
          `<span class="code-file-line${i + 1 === line ? ' hl' : ''}"><span class="code-file-ln">${
            i + 1
          }</span><span class="code-file-src">${highlight(ln, lang) || ' '}</span></span>`
      )
      .join('');
    el('codeFileTruncated').classList.toggle('hidden', !truncated);
    el('codeFileModal').classList.remove('hidden');
    if (line) {
      requestAnimationFrame(() => {
        el('codeFileContent').querySelector('.code-file-line.hl')?.scrollIntoView({ block: 'center' });
      });
    } else {
      el('codeFileContent').scrollTop = 0;
    }
  } catch (err) {
    toast(err.message, true);
  }
}

el('codeWorkspaceRefresh').addEventListener('click', refreshWorkspaceTree);
el('closeCodeFileBtn').addEventListener('click', () => el('codeFileModal').classList.add('hidden'));
el('codeFileModal').addEventListener('click', (e) => {
  if (e.target === el('codeFileModal')) el('codeFileModal').classList.add('hidden');
});

// ---------- Panel collapse toggles (per device) ----------

function applySidebarCollapsed() {
  el('codeLayout').classList.toggle('sidebar-collapsed', state.codeSidebarCollapsed);
  el('codeLayout').classList.toggle('workspace-collapsed', state.codeWorkspaceCollapsed);
}

el('codeSidebarToggle').addEventListener('click', () => {
  state.codeSidebarCollapsed = !state.codeSidebarCollapsed;
  setLocal('mc:codeSidebarCollapsed', String(state.codeSidebarCollapsed));
  applySidebarCollapsed();
});

el('codeWorkspaceToggle').addEventListener('click', () => {
  state.codeWorkspaceCollapsed = !state.codeWorkspaceCollapsed;
  setLocal('mc:codeWorkspaceCollapsed', String(state.codeWorkspaceCollapsed));
  applySidebarCollapsed();
  if (!state.codeWorkspaceCollapsed) refreshWorkspaceTree();
});
