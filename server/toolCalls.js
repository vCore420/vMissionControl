// Recovering a tool call a small model emitted as plain text instead of a
// structured call. llama3.2:3b does this once the tool count grows or the task
// is fiddly; qwen2.5-coder does it on *every* call under Ollama 0.33.x (its
// chat template never emits the tool-call tokens Ollama's parser looks for).
// Seen shapes, all handled here:
//   {"name":"list_dir","parameters":{"path":"src"}}
//   {"name":"list_services","parameters{"status":"offline"}}   (broken `"parameters{`)
//   {"type":"function","function":{"name":"search_text","parameters":{}}}
//   {"function":{"name":"read_file","arguments":{"path":"x"}}}
//   ```json\n{ ...one of the above... }\n```
//
// The args object is pulled out by walking braces with a string-aware scanner,
// not a regex. A lazy `\{[\s\S]*?\}` stopped at the first "}" it saw — which
// for a write_file/edit_file call is the one inside the code being written
// (`function f(){}`), truncating the JSON so it wouldn't parse and the call
// ran with empty args ("a file path is required"). The scanner skips braces
// that sit inside a string, so a `content` value full of code survives.
//
// Shared by ollamaChat.js (the chat assistant) and codeAgent.js (the Code
// tab). `knownNames` is a Set of the tool names valid for that caller — a
// {...} that doesn't name one of them is ignored.

const NAME_HINT = /"name"\s*:\s*"[a-z_]/i;
const NAME_RE = /"name"\s*:\s*"([a-z_][a-z0-9_]*)"/gi;
// Directly after a name, the start of its args object (comma optional — some
// broken emissions drop it). The repair pass below normalises the key first.
const ARGS_KEY_RE = /^\s*,?\s*"(?:parameters|arguments)"\s*:\s*\{/;
const MAX_ARGS_CHARS = 200_000; // a whole file can legitimately be in `content`

// s[start] must be "{". Returns s.slice(start, matching "}" + 1), or null if
// the braces never balance. Braces inside a "…" string don't count.
function balancedSlice(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  const end = Math.min(s.length, start + MAX_ARGS_CHARS);
  for (let i = start; i < end; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// JSON.parse, with one fallback for the common model slip of putting real
// newlines/tabs inside a string value (invalid JSON). Only control chars that
// are actually inside a string get escaped, so structure is untouched.
function looseParseObject(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  let out = '';
  let inStr = false;
  let esc = false;
  for (const c of raw) {
    if (inStr) {
      if (esc) {
        out += c;
        esc = false;
      } else if (c === '\\') {
        out += c;
        esc = true;
      } else if (c === '"') {
        out += c;
        inStr = false;
      } else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else out += c;
    } else {
      if (c === '"') inStr = true;
      out += c;
    }
  }
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

export function recoverToolCalls(text, knownNames) {
  if (!text || !NAME_HINT.test(text)) return [];
  const repaired = text
    .replace(/<\/?tool_call>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/"(parameters|arguments)"?\s*:?\s*\{/gi, '"$1":{');

  const calls = [];
  const seen = new Set();
  NAME_RE.lastIndex = 0;
  let m;
  while ((m = NAME_RE.exec(repaired))) {
    const name = m[1];
    if (!knownNames.has(name)) continue;

    const afterName = m.index + m[0].length;
    const argsKey = ARGS_KEY_RE.exec(repaired.slice(afterName, afterName + 48));
    let args = {};
    if (argsKey) {
      // argsKey[0] ends on the opening "{" — that's where the object starts.
      const slice = balancedSlice(repaired, afterName + argsKey[0].length - 1);
      if (slice) {
        const parsed = looseParseObject(slice);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
      }
    }

    const key = `${name}:${JSON.stringify(args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ function: { name, arguments: args } });
  }
  return calls;
}
