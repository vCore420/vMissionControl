// The Ollama chat assistant's runtime — everything that is *behaviour*
// rather than transport (transport is ollama.js):
//   - the on/off state (config.ollama.active) and keeping the model warm,
//   - the chat:message listener that routes a triggered message to the
//     model and posts its reply back into the channel.
//
// `config.ollama.active` is the single source of truth for on/off — it's in
// config.json, so it survives a restart and syncs to every device through
// the ordinary `config` WebSocket broadcast (no new event needed). This
// module reacts to it: turning it on preloads the model and starts the
// keep-warm loop; turning it off evicts the model and stops the loop; a
// restart with it already on preloads on boot.
//
// The trigger path deliberately hangs off the existing `chat:message`
// event rather than living inside routes/chat.js — the message is posted
// and broadcast to everyone exactly as normal first, and this reacts to it
// afterwards, so a phone that just POSTs a message needs no knowledge that
// an assistant exists. It's the same decoupled-listener shape alerts.js
// uses for the health sweep.

import { loadConfig, saveConfig } from './config.js';
import { appEvents } from './events.js';
import { preloadModel, unloadModel, listRunningModels, pingOllama, chatStream } from './ollama.js';
import { getMessages, addMessage, updateMessage, readAttachmentAsContext } from './chat.js';
import { getToolDefinitions, executeTool, toolLabel, isActionTool, allToolNames } from './ollamaTools.js';
import { recoverToolCalls } from './toolCalls.js';
import { prepareAction, linkMessage } from './ollamaActions.js';
import { logActivity } from './activityLog.js';

let keepWarmTimer = null;
let lastPreloadError = null;

// One generation per channel at a time — a second trigger while the model
// is still thinking is ignored rather than queued or run in parallel.
const thinkingChannels = new Set();

// Roughly how much conversation to hand the model, on top of the
// per-message count limit. A channel full of pasted logs shouldn't be able
// to blow the context window.
const CONTEXT_CHAR_BUDGET = 6000;

// Ollama's keep_alive accepts "30m" / "1h" / "45s" / a bare number of
// seconds / "-1" for "forever". We re-preload a bit before it would lapse,
// clamped so a tiny value can't spin the loop and a huge one still gets an
// occasional refresh.
function parseKeepAliveMs(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s === '-1') return null; // "forever" (or empty) — no refresh needed
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
  if (!m) return 5 * 60 * 1000;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const ms = unit === 'h' ? n * 3600e3 : unit === 'm' ? n * 60e3 : n * 1000;
  return ms > 0 ? ms : null; // "0" means "don't keep it loaded" — nothing to refresh
}

function stopKeepWarm() {
  if (keepWarmTimer) {
    clearInterval(keepWarmTimer);
    keepWarmTimer = null;
  }
}

async function preloadNow() {
  const { ollama } = await loadConfig();
  try {
    await preloadModel(ollama.baseUrl, ollama.model, ollama.keepAlive);
    lastPreloadError = null;
  } catch (err) {
    lastPreloadError = err.message;
    console.error('[ollama] preload failed:', err.message);
  }
}

function startKeepWarm(keepAliveRaw) {
  stopKeepWarm();
  const lapseMs = parseKeepAliveMs(keepAliveRaw);
  if (lapseMs === null) return; // keep_alive is "forever" — nothing to refresh
  const refreshMs = Math.min(30 * 60 * 1000, Math.max(60 * 1000, Math.round(lapseMs * 0.8)));
  keepWarmTimer = setInterval(() => { preloadNow().catch(() => {}); }, refreshMs);
  if (keepWarmTimer.unref) keepWarmTimer.unref();
}

// Called once from index.js after the other systems start. Registers the
// trigger listener unconditionally (it no-ops fast when the assistant is
// off) and warms the model if it was left on.
export async function initOllamaChat() {
  appEvents.on('chat:message', (payload) => {
    handleTriggeredMessage(payload).catch((err) => console.error('[ollama] trigger handler:', err.message));
  });

  const { ollama } = await loadConfig();
  if (ollama.active && ollama.model) {
    preloadNow().catch(() => {});
    startKeepWarm(ollama.keepAlive);
  }
}

// ---------- Trigger path ----------

function triggerRegex(trigger, flags) {
  const esc = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Bounded on both sides so "email@ollama.com" or "@ollamas" don't match
  // a trigger of "@ollama", but "hey @ollama!" does.
  return new RegExp(`(?<![\\w])${esc}(?![\\w])`, flags);
}

function triggerMatches(text, trigger) {
  return !!trigger && triggerRegex(trigger, 'i').test(text || '');
}

// The model shouldn't see the literal trigger token — strip it from every
// turn (old triggers scattered through the history are just noise too).
function stripTrigger(text, trigger) {
  if (!trigger) return text || '';
  return (text || '').replace(triggerRegex(trigger, 'ig'), '').replace(/\s{2,}/g, ' ').trim();
}

// A channel can override the assistant's name / face / system prompt
// (per-channel personality cards, PUT /api/chat/channels/:id). Each field
// falls back to the global Settings -> Ollama value, then a hard default.
// The trigger word is always the global one.
function personaFor(channelId, config) {
  const channel = (config.chatChannels || []).find((c) => c.id === channelId);
  const global = config.ollama || {};
  const override = channel?.ollama || {};
  return {
    botName: override.botName || global.botName || 'Ollama',
    botEmoji: override.botEmoji || global.botEmoji || '🦙',
    systemPrompt: override.systemPrompt || global.systemPrompt || '',
  };
}

// Flattens the recent channel history into Ollama chat turns. The model
// isn't a channel member, so this is assembled fresh each time it's
// triggered: its own past replies become assistant turns, everyone else's
// messages become user turns prefixed with the author's name (which is how
// "who said what" survives being collapsed into a single user role when
// several people are talking). The system message spells that format out,
// because otherwise the model copies it and prefixes its own replies with
// a name too.
// `trigger` is { id, attachment } for the message that fired this — the
// attachment (a file's text, or a note about why it can't be read) is
// spliced onto that message's turn so the model sees it in place.
function buildContext(channelId, ollama, persona, pendingId, trigger = {}) {
  const usable = getMessages(channelId).filter(
    (m) => m.id !== pendingId && !m.pending && !m.error && (m.text || '').trim()
  );
  const byCount = usable.slice(-Math.max(1, ollama.contextMessages || 30));

  // Then trim from the front to fit the character budget.
  const kept = [];
  let total = 0;
  for (let i = byCount.length - 1; i >= 0; i--) {
    total += byCount[i].text.length + 24;
    if (total > CONTEXT_CHAR_BUDGET && kept.length) break;
    kept.unshift(byCount[i]);
  }

  const botName = persona.botName;
  const formatNote =
    `You are ${botName}, taking part in a group chat. Each other participant's message is shown ` +
    `prefixed with their name and a colon (for example "Alex: hi"). Reply as ${botName} in a normal ` +
    `conversational voice — do NOT put your own name, or anyone else's, as a prefix on your reply.`;
  const systemContent = persona.systemPrompt ? `${persona.systemPrompt}\n\n${formatNote}` : formatNote;

  const messages = kept.map((m) => {
    if (m.bot) return { role: 'assistant', content: m.text };
    let content = `${m.author}: ${stripTrigger(m.text, ollama.trigger)}`;
    const att = m.id === trigger.id ? trigger.attachment : null;
    if (att?.text != null) {
      content += `\n\n[${m.author} attached "${att.name}"${att.truncated ? ' — shown truncated' : ''}]\n\`\`\`\n${att.text}\n\`\`\``;
    } else if (att?.note) {
      content += `\n\n[${att.note}]`;
    }
    return { role: 'user', content };
  });
  messages.unshift({ role: 'system', content: systemContent });

  const knownNames = new Set([botName.toLowerCase(), ...kept.filter((m) => !m.bot).map((m) => m.author.toLowerCase())]);
  return { messages, knownNames };
}

// Belt-and-braces for the format note: if the model still opens with
// "<participant>: " despite being told not to, drop that prefix — but only
// when the prefix is an actual chat participant's name, so a legitimate
// "Note:" / "Warning:" opening is left alone. If stripping would leave
// nothing (the model replied with only a name prefix), keep the original.
function stripLeadingNamePrefix(reply, knownNames) {
  const stripped = reply.replace(/^\s*([^\n:]{1,40}):\s+/, (whole, name) =>
    knownNames.has(name.trim().toLowerCase()) ? '' : whole
  );
  return stripped.trim() ? stripped : reply;
}

const MAX_TOOL_ROUNDS = 4;
const KNOWN_TOOL_NAMES = allToolNames();

// Streams a reply, running the read-only tools (ollamaTools.js) in between
// if the model asks for data and `config.ollama.tools` is on. `onDelta`
// gets the running reply text across all rounds; content the model emits
// before a tool call is carried forward so nothing it says is lost. On the
// final allowed round tools are withheld so it has to answer. Returns
// { text, toolsUsed } — toolsUsed is the de-duplicated set of tool names
// that actually ran, for the "checked ..." footnote and the activity log.
async function generateReply({ ollama, messages, signal, onDelta, channelId, requestedBy }) {
  const tools = ollama.tools
    ? getToolDefinitions({
        includeActions: ollama.actions,
        comfyEnabled: (await loadConfig()).comfy?.enabled,
      })
    : undefined;
  const working = [...messages];
  const toolsUsed = new Set();
  const pendingActions = []; // action calls that now need in-chat confirmation
  let carried = '';

  // When an action is queued, the model's prose is unreliable — small models
  // routinely say "done!" despite being told not to. The card carries the
  // real information, so replace the reply with a neutral line (kept as a
  // trailer if the model also answered something from a read tool).
  const finish = (text) => {
    let out = text;
    if (pendingActions.length) {
      const usedReadTool = [...toolsUsed].some((n) => !isActionTool(n));
      const note = pendingActions.length === 1 ? 'Confirm below to run it.' : 'Confirm each action below to run it.';
      out = usedReadTool && text.trim() ? `${text}\n\n_${note}_` : note;
    }
    return { text: out, toolsUsed: [...toolsUsed], pendingActions };
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let { content, toolCalls, thinking } = await chatStream(ollama.baseUrl, {
      model: ollama.model,
      messages: working,
      tools: round < MAX_TOOL_ROUNDS ? tools : undefined,
      keepAlive: ollama.keepAlive,
      numPredict: ollama.numPredict,
      signal,
      onDelta: (t) => onDelta(carried + t),
    });

    // A small model that "said" a tool call instead of making one.
    if (!toolCalls.length && tools && round < MAX_TOOL_ROUNDS) {
      const recovered = recoverToolCalls(content, KNOWN_TOOL_NAMES);
      if (recovered.length) {
        toolCalls = recovered;
        content = '';
      }
    }

    if (toolCalls.length) {
      working.push({ role: 'assistant', content, tool_calls: toolCalls });
      if (content.trim()) carried += `${content.trim()}\n\n`;
      for (const call of toolCalls) {
        const name = call.function?.name;
        toolsUsed.add(name);
        let result;
        if (isActionTool(name)) {
          // Actions never run here — validate and queue for the user to confirm.
          const prep = await prepareAction({ channelId, tool: name, args: call.function?.arguments, requestedBy });
          if (prep.error) {
            result = { error: prep.error };
          } else {
            pendingActions.push(prep.action);
            result = {
              status: 'awaiting_user_confirmation',
              action: prep.action.summary,
              instruction: 'A Confirm button has been shown to the user. Tell them what you are about to do; do NOT say it is done.',
            };
          }
        } else {
          result = await executeTool(name, call.function?.arguments);
        }
        working.push({ role: 'tool', name, content: JSON.stringify(result).slice(0, 8000) });
      }
      continue;
    }

    const final = (carried + content).trim();
    if (final) return finish(final);
    if (pendingActions.length) return finish(`Ready when you are — confirm below.`);
    // Nothing usable: a "thinking" model that spent its whole token budget
    // reasoning is the usual cause — say so rather than a bare "empty reply".
    if (thinking) {
      throw new Error("used the whole reply budget on internal reasoning — raise Max reply length in Settings, or use a model that doesn't \"think\"");
    }
    throw new Error('the model returned an empty reply');
  }
  return finish(carried.trim() || "(couldn't produce an answer)");
}

async function handleTriggeredMessage({ channelId, message }) {
  if (message.bot) return; // the assistant's own messages (incl. the pending bubble)
  const config = await loadConfig();
  const ollama = config.ollama;
  if (!ollama.active || !ollama.model) return;
  if (!triggerMatches(message.text, ollama.trigger)) return;
  if (thinkingChannels.has(channelId)) return;

  thinkingChannels.add(channelId);
  const persona = personaFor(channelId, config);
  const botName = persona.botName;
  const attachment = await readAttachmentAsContext(message.attachment); // text | note | null
  const pending = addMessage(channelId, { author: botName, text: '', bot: true, pending: true });

  const controller = new AbortController();
  const timeoutMs = ollama.requestTimeoutMs || 120000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // The stream arrives token by token; broadcasting every token would be one
  // WebSocket message per token to every device. Debounce to a few updates a
  // second — enough to read as "typing", cheap enough to not matter.
  let latest = '';
  let lastFlushAt = 0;
  const FLUSH_MS = 400;
  const flush = () => {
    lastFlushAt = Date.now();
    updateMessage(channelId, pending.id, { text: latest, pending: true });
  };

  const onDelta = (full) => {
    latest = full;
    if (Date.now() - lastFlushAt >= FLUSH_MS) flush();
  };

  try {
    const { messages, knownNames } = buildContext(channelId, ollama, persona, pending.id, {
      id: message.id,
      attachment,
    });
    const { text, toolsUsed, pendingActions } = await generateReply({
      ollama,
      messages,
      signal: controller.signal,
      onDelta,
      channelId,
      requestedBy: message.author,
    });
    const labels = toolsUsed.map(toolLabel);
    updateMessage(channelId, pending.id, {
      text: stripLeadingNamePrefix(text, knownNames),
      pending: false,
      toolsUsed: labels.length ? labels : undefined,
    });
    if (labels.length) {
      logActivity('chat', `Assistant used live lookups (${labels.join(', ')}) answering ${message.author}`);
    }
    // Post a Confirm/Cancel card for each action the model proposed.
    for (const action of pendingActions) {
      const card = addMessage(channelId, {
        author: botName,
        text: '',
        bot: true,
        action: { id: action.id, tool: action.tool, summary: action.summary, status: 'pending' },
      });
      linkMessage(action.id, card.id);
    }
  } catch (err) {
    console.error('[ollama] reply failed:', err.message);
    // If tokens were already streaming when it broke (usually the timeout),
    // keep what we got rather than throwing it away for an error bubble.
    if (latest.trim()) {
      updateMessage(channelId, pending.id, { text: stripLeadingNamePrefix(latest, new Set()), pending: false });
    } else {
      updateMessage(channelId, pending.id, {
        text: `⚠️ ${botName} couldn't reply — ${err.message}`,
        pending: false,
        error: true,
      });
    }
  } finally {
    clearTimeout(timer);
    thinkingChannels.delete(channelId);
  }
}

// The Chat-view toggle. Persists the flag (→ config broadcast → every
// device's switch updates) and then makes the model state match: load +
// keep warm, or evict + stop. Returns the fresh status for the caller.
export async function setActive(active, ip) {
  const config = await loadConfig();
  const wasActive = !!config.ollama.active;
  config.ollama = { ...config.ollama, active: !!active };
  await saveConfig(config);

  if (active) {
    startKeepWarm(config.ollama.keepAlive);
    // Not awaited — a cold load of a large model can take 20-30s and the
    // route returns status right away; the client polls /status for "ready".
    preloadNow().catch(() => {});
  } else {
    stopKeepWarm();
    lastPreloadError = null;
    unloadModel(config.ollama.baseUrl, config.ollama.model).catch(() => {});
  }

  if (wasActive !== !!active) {
    logActivity('settings', `Ollama assistant turned ${active ? 'on' : 'off'}`, ip);
  }
  return getStatus();
}

// If the model or URL changed in Settings while the assistant is on, point
// the keep-warm loop at the new target and preload it. The old model just
// times out on its own.
export async function onConfigChanged() {
  const { ollama } = await loadConfig();
  if (!ollama.active) return;
  startKeepWarm(ollama.keepAlive);
  preloadNow().catch(() => {});
}

export async function getStatus() {
  const { ollama } = await loadConfig();
  const status = {
    active: !!ollama.active,
    model: ollama.model || null,
    reachable: false,
    loaded: false,
    error: lastPreloadError,
  };
  try {
    await pingOllama(ollama.baseUrl);
    status.reachable = true;
    if (ollama.model) {
      const running = await listRunningModels(ollama.baseUrl);
      status.loaded = running.includes(ollama.model);
    }
  } catch (err) {
    status.error = status.error || err.message;
  }
  return status;
}
