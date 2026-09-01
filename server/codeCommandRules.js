// Per-command permission rules for the Code agent (Code parity roadmap 2b).
//
// config.code.commandRules = { allow: [glob], deny: [glob] }. These are
// consulted only for run_command (foreground and background), in
// codeAgent.js's approval step:
//
//   - a deny match  → the command is refused outright, even in "Auto-apply
//                     all" — the agent is told it's blocked and not to route
//                     around it
//   - an allow match → it runs with no Confirm card, even in "Ask each
//                     change" — the label notes it was allowed by a rule
//   - no match       → the session's approval mode decides, exactly as before
//
// deny always beats allow. A rule is a shell-ish glob matched against the
// whole command string (leading/trailing space trimmed, internal runs of
// whitespace collapsed to one), case-insensitively: `*` matches any run of
// characters including none, `?` matches one character, everything else is
// literal. Anchored — use `*foo*` for "contains foo". No brace/class syntax.
//
// This is deliberately its own tiny module (not codeTools.js's path-oriented
// globToRegExp, whose `*` stops at `/` — wrong for a command line) so it can
// be unit-reasoned about and imported by config.js for the seeded defaults.

// Seeded into config.code.commandRules.deny on first migration — a starting
// point, fully editable in Settings → Code. Two kinds of entry: catastrophic
// (wipes a disk, powers the box off, pipes a download straight into a shell)
// and against this project's standing constraints (git push / publish are
// outbound and irreversible, and git here is driven by hand — see the Code
// parity roadmap). Broad-but-sometimes-legitimate commands (a plain
// `rm -rf build`, `git reset --hard`) are deliberately NOT here — they fall
// through to the normal Confirm card.
export const DEFAULT_DENY = [
  'sudo *',
  'su *',
  'doas *',
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf ~/*',
  'rm -rf $home*',
  'rm -fr /',
  'rm -fr /*',
  ':(){*:|:&*};:',
  'dd if=* of=/dev/*',
  'mkfs*',
  'mke2fs*',
  '* > /dev/sd*',
  '* > /dev/nvme*',
  '* of=/dev/sd*',
  'shutdown*',
  'reboot*',
  'halt',
  'poweroff',
  'init 0',
  'init 6',
  'del /f /s /q *',
  'rd /s /q *',
  'rmdir /s *',
  'format *',
  'diskpart*',
  'curl * | *sh',
  'curl * | *bash',
  'wget * | *sh',
  'wget * | *bash',
  'iwr * | *iex',
  'git push*',
  'git push -f*',
  'git remote add*',
  'npm publish*',
  'yarn publish*',
  'pnpm publish*',
];

// A shell-ish glob → RegExp. `*` → `.*`, `?` → `.`, everything else escaped.
export function commandGlobToRegExp(glob) {
  let out = '';
  for (const ch of String(glob)) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if ('.+^${}()|[]\\/'.includes(ch)) out += '\\' + ch;
    else out += ch;
  }
  return new RegExp(`^${out}$`, 'i');
}

function normalize(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

// 'deny' | 'allow' | 'ask'. Never throws — a malformed rules object or a
// blank command just yields 'ask' (defer to the approval mode).
export function classifyCommand(rules, command) {
  const c = normalize(command);
  if (!c) return 'ask';
  const deny = Array.isArray(rules?.deny) ? rules.deny : [];
  const allow = Array.isArray(rules?.allow) ? rules.allow : [];
  const hit = (list) =>
    list.some((g) => {
      const pat = String(g || '').trim();
      if (!pat) return false;
      try {
        return commandGlobToRegExp(pat).test(c);
      } catch {
        return false;
      }
    });
  if (hit(deny)) return 'deny';
  if (hit(allow)) return 'allow';
  return 'ask';
}

// Settings-route sanitiser: trim, drop blanks, de-dupe, length- and count-cap
// each list. Shape is always { allow: [...], deny: [...] }.
export function sanitizeCommandRules(raw) {
  const clean = (arr) =>
    Array.isArray(arr)
      ? [...new Set(arr.map((s) => String(s || '').trim()).filter(Boolean).map((s) => s.slice(0, 200)))].slice(0, 60)
      : [];
  return { allow: clean(raw?.allow), deny: clean(raw?.deny) };
}
