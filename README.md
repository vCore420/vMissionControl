# Mission Control

A self-hosted LAN dashboard for everything running on your own machine —
Jellyfin, Ollama, Open WebUI, ComfyUI, Tailscale, local game servers,
Docker containers, whatever's listening on `127.0.0.1` / `0.0.0.0` — and
just as easily a homepage for the websites you open daily. A card grid with
live health status, groups, pinned favorites, and visual connections between
related services, plus start/stop/restart and logs for Docker and host
services, a shared-folder file browser, real-time chat, a customisable board
of widgets, scheduled tasks, and a local-Ollama coding agent that reads and
edits files in a sandboxed workspace. Everything syncs in real time to every
device on your network.

Zero build step: plain ES modules, no framework, no bundler. Three runtime
dependencies (`express`, `multer`, `ws`). `npm install && npm start`.

## Run it

```bash
npm install
npm start
```

On Windows, [start.bat](start.bat) does both for you — double-click it (it
skips `npm install` if `node_modules` already exists, and skips starting a
second server if one's already running on port 5000).

To stop it, use [stop.bat](stop.bat) rather than just closing its console
window — closing the window doesn't always reliably kill the underlying
Node process on Windows, which can leave an invisible orphaned instance
running in the background indefinitely. stop.bat finds whatever's on port
5000, asks it to shut down cleanly, and force-closes it only if that
doesn't work. [restart.bat](restart.bat) does both start and stop in one
step, for the same reason.

On Ubuntu/Linux, [start.sh](start.sh), [stop.sh](stop.sh), and
[restart.sh](restart.sh) are the same three scripts, ported: same
install-if-needed and don't-double-start behavior, same graceful-then-forced
shutdown. The app itself needs no porting — it's plain Node/Express with no
native dependencies — only these launch scripts differ per OS. Make them
executable once (`chmod +x start.sh stop.sh restart.sh`), then run
`./start.sh`.

The server binds `0.0.0.0`, so it's reachable both at `http://localhost:5000`
and at your machine's LAN address (printed on startup, e.g.
`http://192.168.1.23:5000`) — open that from your phone or another computer
on the same network.

For auto-restart on file changes during development:

```bash
npm run dev
```

### Auto-start on boot (Windows)

For this to actually work as a "central hub," it needs to be running before
you think to check it, not just when you remember to double-click
`start.bat`. Double-click
[scripts/install-autostart.bat](scripts/install-autostart.bat) once to
register a Task Scheduler task that starts the server, hidden (no console
window, no browser tab popped open), the next time you log into Windows on
this account. It's a plain per-user logon task — no admin rights needed,
nothing runs before you sign in.

- **Uninstall**: double-click
  [scripts/uninstall-autostart.bat](scripts/uninstall-autostart.bat), or
  delete "MissionControlAutoStart" from Task Scheduler directly.
- **Start it right now** without logging out first:
  `schtasks /Run /TN "MissionControlAutoStart"`
- **Check it's registered**: `schtasks /Query /TN "MissionControlAutoStart"`,
  or open Task Scheduler → Task Scheduler Library.
- **Logs**: `scripts/autostart.log` — only written to when the hidden runner
  actually starts the server (e.g. `npm install` output on a fresh machine,
  or a crash's stack trace); nothing is written on a no-op run where a
  server was already up.
- It safely no-ops if a server is already listening on the port (e.g. you'd
  already started it by hand) instead of trying to start a second one.
- This registers an **at-logon** task, not an at-boot/before-login one — if
  you leave this PC sitting at the Windows lock screen without signing in,
  the dashboard won't be reachable until someone logs in. An at-boot task
  running as SYSTEM is possible instead if that matters for how you use this
  machine, just say so — it wasn't the default here since it's more opaque
  to debug (no interactive session, relies on `node` being on the
  machine-wide PATH rather than your user PATH).

### Auto-start on boot (Ubuntu/Linux)

Run [scripts/install-autostart.sh](scripts/install-autostart.sh) once. It
registers a `systemd --user` unit (`mission-control.service`) that starts
the server the next time this user's session starts — the same per-user,
no-`sudo` trust level as the Windows Task Scheduler task above, just
systemd's equivalent of it.

- **Uninstall**: run [scripts/uninstall-autostart.sh](scripts/uninstall-autostart.sh).
- **Start it right now**: `systemctl --user start mission-control`
- **Check it's registered**: `systemctl --user status mission-control`
- **Logs**: `mission-control.log` in the project root, or
  `journalctl --user -u mission-control`.
- Like the Windows task, this is an **at-login** trigger, not at-boot — on
  a headless box that should come up with nobody logged in, additionally
  run `sudo loginctl enable-linger $USER` once (the install script prints
  this reminder).

## Installing it as an app

Mission Control is a PWA — manifest, icons, and a service worker are all
wired up, so it can be "installed" (its own window, its own icon, no browser
chrome) instead of just bookmarked.

- **On this PC** — open `http://localhost:5000` in Chrome or Edge and use
  the install icon in the address bar (or the browser menu → "Install
  Mission Control…").
- **On a phone/tablet on your LAN** — open `http://<your-LAN-IP>:5000` and
  use "Add to Home Screen" from the browser menu.

**The catch:** browsers only offer the full automatic install prompt (and
some, like Android Chrome, only offer a real standalone-window install at
all) on a *secure context* — `https://` or `localhost`. A plain
`http://192.168.x.x:5000` LAN address doesn't qualify, so from another
device you'll typically get a bookmark-style shortcut rather than a fully
"installed" app experience. This is the same restriction the desktop
Notification feature hit earlier. iOS Safari's "Add to Home Screen" is the
exception — it works over plain HTTP and does respect the manifest/icons.
If you want genuine one-tap installs from every device, the real fix is
serving this over HTTPS (a self-signed cert + trusting it on each device,
or a reverse proxy that terminates TLS) — worth its own pass if you want it,
not done here since it's a meaningfully bigger chunk of setup than the
PWA groundwork itself.

The service worker caches the static app shell (HTML/CSS/JS/icons) purely
as an offline fallback — it deliberately never caches `/api/*`, since this
app only exists to show *live* status and serving stale health data back
from a cache would be actively misleading. Fetches are **network-first**:
every load tries the network before ever touching the cache, so an
installed/PWA'd device always gets the current version whenever it has
connectivity, and only falls back to whatever it has cached when the
network request genuinely fails. It never caches a *redirected* response
(with password protection on, a gated file requested without a session
302s to `/login.html`), and the shell gets fully cached on the first
signed-in load rather than up front — the only point an offline shell is
meaningful anyway. (An earlier stale-while-revalidate
version served the cached shell instantly and only refreshed it in the
background — which meant a device that cached the app mid-edit could get
stuck replaying that same frozen, half-updated snapshot indefinitely,
since it never had a reason to prefer the network. See
[.claude/DEV_NOTES.md](.claude/DEV_NOTES.md) for the incident that
prompted the change.) If you add a new stylesheet or script to
`index.html`, still add it to `SHELL_URLS` in
[service-worker.js](public/service-worker.js) and bump `CACHE_NAME` — that
part hasn't changed, it's what lets old cached files get cleaned up.

## What it does

- **Dashboard** — a card per entry: icon (or auto-fetched favicon), URL,
  live status dot, latency, group badge, tags, and an uptime sparkline.
  **Enter** jumps to it; the ✎ in the corner edits it. The URL itself is
  masked (`🔒 Tap to reveal URL`) until tapped, so a card grid full of
  internal addresses isn't legible at a glance over someone's shoulder or
  in a screen share.
- **Any URL, not just local services** — leave the icon field blank when
  adding an entry and it renders the site's real favicon instead of a
  picked emoji. Health-check monitoring auto-defaults on for local/private
  addresses and off for public websites (you can always override it) —
  there's no real reason to poll github.com every 15 seconds the way you'd
  poll a service you're actually operating.
- **Groups** — organize entries (e.g. "AI Tools", "Media", "Web") and
  filter the grid by group with the chips at the top.
- **Pinned favorites** — click the ☆ next to a card's title to float it
  into its own "Pinned" section above the grid, regardless of the active
  group filter.
- **Drag-to-reorder** — drag any card to rearrange it. The pinned section
  and the main grid reorder independently — dragging never moves a card
  between them, that's what the pin star is for.
- **Omnibox quick launcher** — press `/` anywhere on the dashboard to open
  a command-palette overlay; type to filter, arrow keys + Enter to jump
  straight to a service in a new tab. Meant to make this a real replacement
  for a browser new-tab page once your everyday sites are in here too.
- **Connections** — link related services, either as a plain undirected
  **Related** link or a directed **Depends on this** link (e.g. Open WebUI
  depends on Ollama). A service whose dependency is confirmed offline shows
  as **degraded**, not just online — a third status distinct from both
  online and offline, cascading through transitive dependencies too. The
  dependency side of a depends-on link is the only place that link can be
  edited or re-typed; the depended-on service just sees a read-only "depends
  on this" row it can remove but not re-type, so a relationship always has
  one owner. Hover a card to highlight its connections; click
  **Connections** in the top bar to draw lines between every connected pair
  (Graph view always draws them) — depends-on links get a solid line with
  an arrowhead pointing from the dependent service to the one it relies on,
  related links stay dashed and undirected.
- **Health checks + uptime history** — the backend pings each monitored
  entry's URL on an interval (default 15s, configurable in Settings),
  caches the result, and keeps a rolling history (6h / 2000 samples, in
  memory only) that renders as the sparkline strip and uptime % on each
  card. The frontend polls the cheap `/api/status` endpoint every 5s as a
  fallback, but normally hears about a change immediately over the
  real-time connection below. One exception: a service with **"Use the
  Tailscale CLI instead of an HTTP ping"** checked skips the URL fetch
  entirely and instead runs `tailscale status --json` on the host and
  reads `BackendState`/`Self.Online` — a real check of whether this
  machine's Tailscale connection is actually up, since Tailscale doesn't
  run an HTTP service worth pinging the normal way. Deliberately
  independent of that service's `url` field, which stays exactly what it
  already was (the Enter-button link to Tailscale's local dashboard, or
  wherever you've pointed it) — the check and the link were tangled
  together before this, now they aren't. When connected, the tailnet name
  is shown in place of the usual latency figure; when Tailscale reports
  its own health warnings while still connected, those show there too.
  Investigated deliberately: start/stop/restart for Tailscale itself was
  considered and intentionally left out — the Windows service requires
  admin rights this app doesn't run with, and even the CLI's own `down`
  command guards against exactly the risk that matters here (cutting the
  connection you might be using to reach this dashboard in the first
  place). Monitoring only.
- **Real-time sync across every connected device** — a WebSocket pushes
  status changes, edits, pins, reorders, and chat messages to every open
  dashboard the instant they happen, so pinning a service on your phone
  shows up on your desktop right away instead of within-5-seconds. The 5s
  REST poll stays as a fallback for a socket that never connects (a
  restrictive proxy) or is mid-reconnect.
- **Chat** — multiple named channels for talking between whatever devices
  currently have the dashboard open: text, links (auto-linkified), and an
  optional image or file attachment per message, all arriving live. Click
  ＋ for an inline-styled create (no browser prompt popup), drag a channel
  tab to reorder it, ✎ to rename it or give it its own assistant
  personality (see below), ✕ to delete one (disabled once you're down to
  your last channel). Each message shows its sender's **profile** avatar +
  name (Settings → Profile — see below). Message
  history is in-memory only per channel (last 200, same ephemeral choice
  as the health-status cache) and attachments live on disk under
  `server/data/chat-uploads/` (gitignored) — deleting a message or letting
  it age out of the 200-cap deletes its file too. Deliberately not a
  replacement for the shared folder below, which is what actually owns
  moving files that aren't part of a conversation.
- **Profile** — Settings → Profile: a **display name and avatar** per device
  (browser), saved on the host and synced, shown next to your messages in
  Chat and Code. The avatar is either a generated **SVG sprite** (a seeded
  identicon — shuffle for another) or an **uploaded image** (stored under
  `server/data/avatars/`, kept until removed or replaced). Each browser is
  keyed by a `mc:deviceId` it generates once into `localStorage` — still no
  account system, same trusted-LAN model; clearing storage starts a fresh
  profile. `data/profiles.json` holds the records.
- **Ollama assistant in chat** — an optional local LLM that answers in any
  channel. Configure it in Settings → Ollama (connection URL, model picked
  from a live list, a personality card = name + emoji + system prompt, and
  the trigger word, default `@ollama`), then flip the 🦙 toggle in the chat
  header. The toggle is one global on/off — it's stored in `config.json`,
  so it survives a restart (re-warming the model on boot) and syncs to
  every open device through the same config broadcast as everything else.
  While it's on, a message containing the trigger word posts to the channel
  as normal *and* is sent to the model: a "thinking…" bubble with moving
  dots appears under the assistant's name, then swaps in place for the
  reply (a WebSocket message-update, so no scroll jump). The model gets the
  recent channel history assembled fresh each time it's triggered — its own
  past replies as its turns, everyone else's messages prefixed with their
  name — so it follows the conversation without being a channel member;
  the last ~30 messages / ~6k characters, both adjustable. Each channel can
  override the assistant's name, emoji, and system prompt (the ✎ on its
  tab) — blank fields fall back to the Settings → Ollama default, so a
  `#pirate-talk` channel can have a pirate while `#ops` stays terse; the
  trigger word is always the global one. Attach a text-ish file (a config,
  a log, source — `text/*` or a known extension) to the message that
  triggers it and the file's contents go into the model's context too,
  capped at ~6k characters; anything binary or an image comes through as a
  short "can't read this" note instead of being silently dropped.

  With **live data lookups** on (Settings → Ollama, off by default) the
  assistant can call read-only tools to answer questions about the running
  system — service status, host CPU/memory/disk, connected devices, the
  dependency graph, container logs, the **activity log** (*"what happened
  overnight?"*), per-service **uptime history** (*"has X been flapping?"*),
  **shared-folder search**, recent uploads, a **network scan**, its own
  settings, **Docker** containers + per-container CPU/memory, **Tailscale**
  (who's on the tailnet, who's online), the **Ollama** model list /
  what's loaded, and — from the ops roadmap's Phase 3a — **game servers**
  (*"who's on the Minecraft server?"*), **Jellyfin now playing**
  (*"what's on the TV?"*), the **Board widgets**, and the **saved
  snippets**. It only reads what's already reachable through the
  dashboard. A reply that used a lookup carries a small "🔍 checked:
  service status, host health" footnote, and the use is recorded in the
  activity log. Needs a tool-capable model (llama3.1/3.2, mistral-nemo,
  granite, qwen3…); a model without tool support just ignores it, and
  "thinking" models like qwen3 work but are slower.

  Separately, with **actions** on (Settings → Ollama — off by default, and
  refused unless password protection is on, the same rule Service Control
  uses) the assistant can *propose* an action: `wake_device`,
  `control_service` (start/stop/restart — also needs Service Control on),
  `send_alert` (a one-off webhook message), `add_service`, `add_connection`,
  `generate_image` (when ComfyUI is set up — generates a picture and posts
  it into the channel; the card shows "sampling 12/20…" as it runs), and —
  from the ops roadmap's Phase 3b — `run_snippet` (needs the snippet runner
  on), `game_command` (a Minecraft RCON command — needs Service Control on),
  `jellyfin_control` (play / pause / stop / skip a Jellyfin session), and
  `add_widget` (add a note / links / clock / countdown / iframe / host-stats
  / jellyfin tile to the Board). It never runs any of them — a **Confirm /
  Cancel card** appears in chat,
  and only a Confirm from a signed-in device runs the tool. Every proposal,
  confirm, and cancel is activity-logged, and a pending card expires after
  five minutes. A small model that fumbles a tool call into plain text
  (llama3.2:3b does this) is recovered where possible rather than shown
  raw.

  One reply per channel at a time (a second trigger while it's thinking is
  ignored); a failed reply becomes an inline error, never a hung indicator
  (a reply that times out mid-stream keeps whatever text had arrived). The
  reply **streams in** — Ollama's tokens are read server-side and
  re-broadcast on a short debounce (a few updates a second, not one per
  token), so it reads as typing with a blinking cursor, then settles.
  Replies render a small safe subset of Markdown (fenced + inline code,
  bold/italic, lists, headings, blockquotes, links); human messages are
  unchanged. No image understanding — noted as later work. Everything is as
  ephemeral as the rest of chat; only the `config.ollama` settings persist.
- **Code** — a coding-assistant workspace, its own tab between Chat and
  Timesheets. Each **session** is a conversation saved on the host (not
  ephemeral like chat — a session is a piece of work) and synced to every
  device: the session list is shared, which one you have open is per-device.
  A session with a turn running shows a **spinner** in the list; one whose
  reply finished while you had a different session open gets a **dot** until
  you look. The **model is chosen per session** from a dropdown in the session header,
  seeded by a default in Settings → Code; the Ollama connection is the one
  from Settings → Ollama. A new session **titles itself** from your first
  message. Next to the model dropdown a small **context meter** shows roughly
  how full the model's window is — the estimate runs against
  `config.code.contextTokens` (the `num_ctx` handed to Ollama), and the pill
  turns amber then red as it fills. When a *single long turn* passes
  `config.code.compactAtPercent` of that window (default 75%, Code parity
  roadmap 1b), the agent pauses and has the model **summarise its own
  earlier steps** into a briefing, keeps the last few rounds verbatim, and
  carries on — a dashed "⋯ compacted" divider marks the spot in the
  transcript. The stored transcript is untouched; only what's sent to the
  model shrinks. The code model also has a small animated
  **SVG avatar** in the header and on each reply that blinks while idle and
  scans while it's working. Replies **stream in** with a blinking cursor and
  render Markdown / fenced code, reusing the same machinery as the chat
  assistant; **Stop** ends a turn and keeps whatever text (and steps) arrived.
  A read-only **workspace tree** shows the folder the agent works in —
  expand/collapse folders, click a file to view it (syntax-highlighted), and
  it re-reads itself whenever the agent applies a change; a **⬇ button**
  downloads the whole workspace as a `.zip` (`node_modules` and `.git` left
  out). The folder is configurable in Settings → Code, defaulting to a `code`
  subfolder of your shared folder (so the Files tab browses it too) or
  `./workspace` when sharing is off. An empty session offers a few
  **starter prompts** as chips.
  Both the tree and the session sidebar collapse to a toggle on narrow
  screens, where the whole tab reflows to one column — the conversation
  first, the session list a horizontal strip, the tree below it.

  Two **workspace docs** are read into the agent's system prompt at the
  **start of every turn**. The **source-of-truth file** — `AGENTS.md` by
  default, renamed or turned off in Settings → Code — is yours, and treated as
  authoritative: project conventions, architecture, things to know and avoid,
  the `CLAUDE.md` / `AGENTS.md` idea; the workspace panel offers to create one
  from a template when it's missing. The **memory file** — `AGENTS-memory.md`
  by default — is the agent's: it's told to add a short line whenever it works
  out something a future turn should start with, and you can prune it. It's
  created automatically on the first turn. Either file edited (by you or the
  agent) takes effect next turn; both are marked in the workspace tree, count
  toward the context meter, and are capped at 16 KB each (past that the tail
  is dropped and the agent is told so).

  The agent has **read tools** — `list_dir`, `read_file` (with line
  offset/limit), `search_text` (content grep, regex + glob + subdir scope),
  `find_files` (name or glob) — **write tools** — `write_file`, `edit_file`
  (exact-substring replace), `append_file` (add a line to the end of a file),
  `create_dir`, `delete_path` (files and empty directories only) —
  **`ask_user`** (pause and ask you a question, with option buttons or a
  free-text box, when a choice is genuinely yours to make — the turn waits for
  your answer) — **`run_checks`** (runs the verification commands you configure
  in Settings → Code — syntax, a linter, tests — and reports each result; it
  runs them after changes, and uses them when you ask it to review code; these
  are *your* commands, so this one needs no shell-commands switch) — and, when
  you turn each on, **`run_command`** (a shell command with the workspace as
  its working directory — set `background` for a long-running process like a
  dev server, which returns immediately and keeps running past the turn;
  **`check_command`** reads its output and **`stop_command`** ends it, and both
  only appear to the model once something is running) and **`generate_image`**
  (an image asset from ComfyUI, saved into the workspace — see the ComfyUI
  section). Any of the non-core tools can be switched off in Settings → Code
  ("tools the agent may use") — a lean list keeps a small model on track. It
  calls them
  in a loop before answering (capped by `config.code.maxSteps`), and each call
  shows up as a **step** in the transcript as it happens — "Read `app.js` —
  lines 1-400 of 812", "Overwrite `config.js`  (+4 -1)", "Run `npm test` —
  exit 0", "Generate image → `assets/crate.png`" with a thumbnail — reads with
  output, applied writes (coloured diff), command output, and generated images
  are click-to-expand. A small model that prints a tool call as text
  instead of making one is repaired the same way the chat assistant does it.

  You can **attach text files** to a message (📎, drag, or paste — up to 5).
  Their contents are read client-side and spliced onto that one turn so the
  agent sees them in place — handy for an error log or a config snippet that
  isn't in the workspace. Non-text or oversized files show as a chip but pass
  only a note. Nothing is stored: the attachment reaches the model for the
  triggering turn only (the transcript keeps just the filename chip).

  **`@file` mentions** (Code parity roadmap 3a) — type `@` in the composer for
  a fuzzy picker over every workspace file; the pick becomes a chip and its
  current contents are read *server-side* onto that turn (same "this turn
  only" model as an attachment, up to 8). And anywhere the transcript shows a
  `path/to/file.ext:42` — in the agent's reply or a search result — it's a
  link that opens the workspace file viewer at that line.

  **`/commands`** (Code parity roadmap 3b) — type `/` for a picker of prompt
  templates. Three are built in — **`/review`**, **`/test`**, **`/explain`** —
  and a workspace can add its own as `<workspace>/.mc/commands/<name>.md` (a
  file wins over a built-in of the same name). `$ARGUMENTS` in the body is
  replaced with whatever you type after the command; optional frontmatter
  (`description`, `model`, `approvalMode`) overrides the session's model /
  approval mode for that one turn. The transcript shows `/name` you typed with
  a `⌘` badge; the model gets the expanded template.

  **Images** (Code parity roadmap 4) — attach a screenshot (a broken UI, an
  error dialog, a design) with the 📷 button, paste, or drag; the model set as
  the **vision model** in Settings → Code describes it and that description is
  spliced onto the turn the same way an `@file` is. Your chosen coding model
  stays the driver — the vision model is just its eyes, so it doesn't have to
  be multimodal itself; the Settings picker shows a ✓ / ⚠ for whether the
  chosen one reports vision support. The picture renders inline in the
  transcript (kept until the session is deleted) and the vision model's
  description shows in a `👁` step. With no vision model set, an attached image
  just gets a "no vision model" note.

  **Approvals** are per session, picked in the session header (default in
  Settings → Code): **Ask each change** shows every write/edit/delete/command
  with Confirm / Reject in the transcript and pauses the agent until you
  decide; **Auto-apply edits** applies writes and edits on their own (still
  shown as diffs) but still asks before a delete or a command; **Auto-apply
  all** never asks. **Stop** cancels the whole turn, pending approval
  included. Every applied change and command run is written to the activity
  log (category `code`). Background commands the agent starts show in a
  **running-processes strip** above the composer, each with its own Stop
  button; they're also killed when their session is deleted or the server
  shuts down, and there's a 2-hour hard cap.

  **↩ Revert this turn** — a button on any assistant turn that changed files.
  Before the turn's first write touches disk, the pre-write state of every
  path it will change is snapshotted (a plain file copy, no git); the button
  restores all of them — rolling back an edit, deleting a file the turn
  created, undeleting one it removed. Only the most recent un-reverted turn is
  offered, walking backward as you revert; shell commands the turn ran are not
  undone (the button carries a ⚠ when it ran any). The last 10 turns per
  session are kept.

  **Command rules** (Settings → Code) sit in front of the approval mode for
  `run_command`: an *always-allow* pattern runs with no Confirm card even in
  "Ask each change", a *never-run* pattern is refused outright even in
  "Auto-apply all" (and the agent is told not to route around it), and
  anything matching neither falls through to the mode above. Never-run beats
  always-allow. Patterns are shell-ish globs (`*`, `?`) matched
  case-insensitively against the whole command; the never-run list ships
  seeded with catastrophic and outbound commands (`sudo *`, `rm -rf /*`,
  `git push*`, `curl … | sh`, …) and a button restores those defaults.

  **Plan mode** — a per-session toggle in the header. With it on, the agent
  can only look (read, search, `run_checks`, `ask_user`) — no writing,
  editing, commands or image generation — and its job is to produce a
  concrete implementation plan. When the plan is agreed, **Save plan →
  memory** on that reply appends it to the memory file under a dated
  `## Plan:` heading, so it's in the agent's context every turn; turn plan
  mode off and it executes against the saved plan. Turning it off leaves the
  session's approval mode as it was.

  The whole feature is **off by default and refuses to turn on without
  password protection** (Settings → Security). **Running shell commands is a
  second opt-in on top of that** (Settings → Code, off by default — the same
  layered gate Service Control uses): the `run_command` tool isn't even
  offered to the model until you enable it, and a command is not sandboxed
  beyond its working directory.
- **Timesheets** — a fortnightly hours tracker: day-by-day work/leave entries
  (Work, Annual Leave, Sick Leave, Public Holiday, Other — each with its own
  color, re-skinned per theme like everything else) across two week cards,
  live totals, and a canvas-rendered PNG snapshot per pay period. The
  fortnight rolls forward automatically (checked lazily on every load, so
  two devices open at once can't race each other into creating two
  different "next" periods) and the profile/entries are stored server-side
  (`server/data/timesheet.json`) rather than per-device — every device sees
  the same current fortnight, and edits sync live over the same WebSocket
  as everything else. Generated period-snapshot images save to
  `server/data/timesheets/` so they're never lost; a small IndexedDB cache
  on each device avoids re-fetching one already viewed, pruned against
  whatever periods the server still lists.
- **Status-change notifications** — an in-page toast fires on every
  online↔offline transition. Turn on "Notify me..." in Settings for
  desktop notifications too — these need browser permission and only work
  when opened at `localhost` (browsers block them on a plain-HTTP LAN
  address).
- **Quick actions** — 📋 copies a card's URL to the clipboard; ⟳ forces an
  immediate recheck of just that entry instead of waiting for the next
  scheduled sweep. Copy works even on a plain-HTTP LAN address — the modern
  Clipboard API is secure-context-only (see below), so this falls back to
  the older `execCommand` copy trick when `navigator.clipboard` isn't there
  at all.
- **File share** — point Settings → Shared folder at any directory on this
  host and browse/upload/download it from any device that can reach this
  app. Uploads and deletes are each toggleable independently. Drag-and-drop
  upload works anywhere in the Files view (List/Thumbnail/Tree alike,
  multi-file at once) since the drop zone wraps all three, not just one
  layout. **Rename** and **move** are the same server operation under the
  hood (just a relocate within vs. across folders) — rename via the ✎
  button in List view, move by dragging a row onto a folder row. A
  **Recent** button shows the last uploads this server has seen (name,
  folder, size, when), sourced from an in-memory list captured at upload
  time rather than a live filesystem walk — cheap, but it only knows about
  files uploaded through the app, not ones already sitting in the shared
  folder or added directly on disk, and resets on restart like the app's
  other ephemeral caches. Uploads stream straight to disk instead of
  buffering in memory first, so a large video/audio file doesn't sit in
  RAM mid-upload. **Search** looks across the whole shared tree, not just
  the open folder — a recursive walk capped at 200 results/20,000 entries
  scanned so a huge share can't hang a request, shown as a flat list of
  matches with each one's folder. **Preview** — clicking an image, video,
  or audio file opens it inline (native `<img>`/`<video>`/`<audio>`,
  Range-request seeking included) instead of downloading it, with
  Prev/Next cycling through whatever previewable files were in the same
  listing — a folder's contents or a set of search results either way.
- **Themes** — Dark, Light, Cyberpunk, Pride, Cute, Cozy, Her, Forest,
  Ocean, Matrix, Nord, Sunset, Vaporwave, Mono, Dracula, Solarized, and
  High Contrast, picked from a swatch grid in Settings → Appearance. Every
  color in the app is a CSS custom property, so a theme is just a full
  re-declaration of that token set — status colors (online/offline/
  unmonitored/checking) are re-tuned per theme but always keep their
  green/red/gray/amber meaning. Saved per-browser (`localStorage`),
  applied before first paint so there's no flash of the wrong palette on
  reload.
- **Custom theme** — a 15th-and-a-half option alongside the presets: pick
  your own Background, Text, Accent, Border, and the four status colors
  from a compact 8-swatch panel, and the rest of the token set (card/panel
  surfaces, hover states, dimmed text, accent-dim) is derived from those
  automatically, the same lighten/darken relationships the presets
  themselves use. Applies live as you pick and saves immediately — no
  separate save step — and sticks around as "Custom" until you edit it
  again. Same before-first-paint, no-flash treatment as the presets.
- **Generated images** (needs ComfyUI — see that section) — three places
  where MC shows an image can have ComfyUI make it, all through
  `server/artPrompts.js` (a prompt builder per target) + `server/artGen.js`
  (one small image, deliberately modest: 768×432/12 steps for wallpapers,
  512²/14 for the square ones — an abstract backdrop behind a scrim and a
  64px avatar don't need more, and this often runs on CPU at minutes each):
  - **Wallpaper** (Settings → Appearance) — a backdrop for the whole app,
    prompted from the current theme (a hand-written art-direction phrase per
    theme, plus anything you type). Two fixed layers paint in `<html>`'s
    negative-z band: the image, then a `--bg` veil that keeps cards and text
    readable and re-tints itself per theme for free. Like the theme,
    **which** wallpaper you use is per-device (`localStorage`, applied
    pre-paint so there's no flash); the pool is shared — every device sees
    the same gallery, kept live over the WebSocket, and deleting one
    anywhere drops it everywhere (a device showing a just-deleted one falls
    back to none). Capped at 24, oldest pruned.
  - **Profile picture** (Settings → Profile) — a third way to set your
    avatar next to sprite + upload: a description plus one optional preset
    style (pixel art, flat vector, oil painting, anime, 3D). The result goes
    through the same `{kind:'image', file}` path as an upload.
  - **Service icon** (the Add/Edit Service modal) — a custom icon prompted
    from the service's name + description (+ any extra words). Offered only
    on an already-saved service and only with ComfyUI on. It's stored as
    `data/service-icons/<id>.png` and the service gets an `iconImage`
    timestamp; the dashboard then renders it ahead of the emoji/favicon
    (precedence: generated icon → emoji → favicon → 🔗). "Remove" clears it;
    deleting the service deletes the icon.
  - `data/wallpapers/` (+ `wallpapers.json`) and `data/service-icons/` are
    gitignored; avatars reuse `data/avatars/`. Sampler progress streams over
    the socket as `art:progress` (per-device). One generation at a time
    across all three (a second request gets a clean 409).
- **Connected Devices** (Settings) — every device that's hit this server,
  by IP, a parsed browser/OS label, first/last seen, and a request count as
  a simple traffic indicator. The dot shows whether it's connected right
  now (has an open WebSocket). The IP is masked (`🔒 tap to reveal`) by
  default, same reasoning as the card URLs above. In-memory only, capped
  at the last 100 distinct IPs, refreshes every 5s while Settings is open.
  "Clear History" prunes everything *not* currently connected — an active
  device won't flicker offline just because you cleared the list.
- **Per-page view switching** — Dashboard, Files, and Chat each have a
  small layout switcher (top of the page) with their own alternate ways to
  browse the same data:
  - **Dashboard**: Cards (default) · **List** — one compact row per
    service · **Graph** — every service as a node on a circle, connection
    lines drawn between related ones, click a node to open it ·
    **Board** — not a view of the services at all, but a grid of your own
    **widgets** (creative roadmap Phase 3): an **embedded page** (any URL in
    a sandboxed iframe — `allow-scripts allow-same-origin allow-forms
    allow-popups`, `referrerpolicy="no-referrer"`; a site that sends
    `X-Frame-Options` still won't embed, that's its call), a **Markdown
    note**, a **link cluster**, a **live value** — the board asks the
    server to GET a JSON/text endpoint (CORS-free) on the widget's own
    interval and renders one value through a tiny `{{ path.to.field }}`
    template (`{{ items.0.name }}` for arrays; blank template shows the raw
    body; a bad endpoint shows the error on the tile), **Jellyfin now
    playing** (Phase 4): what's playing on each device, with a poster,
    progress bar, and ⏮ ⏯ ⏭ ⏹ controls, using the connection from Settings →
    Jellyfin — or, from the ops roadmap's Phase 2, tiles that read Mission
    Control's own data and its host: **host stats** (this machine's CPU,
    memory and disk, each with a live 10-minute sparkline), **service
    status** (a hand-picked subset of your services as status dots +
    latency, patched in place on every health tick), a **clock** (any IANA
    time zone, optional seconds and date), a **countdown** to a date/time
    (server wipe, a release, a deadline), a **photo frame** (rotates through
    the images in a shared-folder subdir — reuses the Files routes, no new
    serving path), and **Docker containers** (pick raw containers — not
    services — for a state dot plus start / stop / restart / logs; the
    controls are gated by Service Control the same as a service's, logs are
    read-only). The live-value and Jellyfin polls only run while you're
    actually looking at the board; the other timed tiles
    (clock / countdown / host-stats / photo / docker) stop when you leave it
    too. Each widget has a size
    (small / medium / wide) and drag-reorders like the cards. Widgets live in
    `config.widgets` and sync over the WebSocket like everything else; the
    board skips its rebuild when an unrelated config change comes in, so an
    embedded page isn't reloaded out from under you. Which view you're in is
    per-device (`localStorage`), same as the others.
    - **Kiosk mode** (ops roadmap Phase 2c) — a "⛶ Kiosk mode" button on
      the board, or `…/?kiosk=1` in the address you point a wall display's
      browser at. It full-screens the board with no header / nav / edit
      chrome, adds a large clock, and after a few idle minutes dims the
      screen right down (burn-in, and a dark room at night) — any tap or
      key wakes it. `&dim=<minutes>` sets the delay (`dim=0` never dims).
      The choice is remembered per-device so a reload or a browser crash
      stays in kiosk; `?kiosk=0`, the Esc key, or the on-screen ✕ leaves.
      Everything still live-updates — a kiosk is just a chrome-free window
      on the same board.
  - **Files**: List (default, the original table) · **Thumbnails** — a
    grid with real image previews for picture files · **Tree** — a
    collapsible folder tree, lazily fetching each folder's contents only
    when you expand it (no new backend endpoint, no walking the whole
    shared folder up front).
  - **Chat**: unlike the other two, this switches the whole interface
    layout, not just how messages render. **Tabs** (default) — channels
    as a row of tabs above the conversation, today's original layout.
    **Sidebar** — channels as a vertical list beside the conversation,
    AI-chat-app style; both this and Floating render messages as bubbles
    (your own align right in accent color, everyone else's align left).
    **Floating** — the same sidebar channel list, but the conversation
    itself has no card background or border at all — bubbles sit directly
    on the page background, and the composer is just the input pill and
    buttons with no surrounding bar. In Sidebar and Floating a ☰ button in
    the chat header collapses the channel column (remembered per-device);
    on phone-width screens the column becomes a horizontal scrollable strip
    above the conversation, the same graceful-degrade real chat apps use.

  Every one of these is saved to that browser's own `localStorage` — it's
  a per-device display preference, not part of `config.json`, so switching
  to Graph view on your desktop doesn't change what your phone sees.
- **Tabbed Settings** — Profile, Appearance, Services (groups + health-check
  interval), Notifications (in-page/desktop + external alerts), Ollama
  (local-LLM chat assistant), ComfyUI, Jellyfin, Code, Snippets, Scheduled,
  Sharing, Security (password protection + IP allowlist + service control),
  Devices, and Backup each get their own tab instead of one long scrolling page. Which tab you
  were last on is remembered per-device (`localStorage`), same as the view
  switchers above.
- **Host PC Health** — a small pill in the top-right corner (🖥️ + CPU %,
  color-coded green/amber/red) sits next to the online-services badge and
  the settings gear, visible on every page — Dashboard, Files, or Chat —
  not tucked away in Settings. Click it for the full breakdown: CPU,
  memory, disk usage, hostname/OS/CPU model/uptime. Sampled in the
  background every 5s (CPU % needs a delta between two `os.cpus()`
  readings, so it's cached rather than computed per-request); the pill
  itself polls every 10s regardless of which page is open or whether the
  full view is open, so it's never stale for long. No new dependency —
  just Node's built-in `os` and `fs.statfs`.
- **Network discovery** — click **🔍 Discover** to scan the local subnet(s)
  this host is on for open ports matching ~25 common self-hosted/admin
  services (Jellyfin, Ollama, ComfyUI, Portainer, Home Assistant, Plex,
  Sonarr/Radarr, SSH, RDP, SMB, generic web ports, and more), so devices
  already on your network show up without typing every address in by hand.
  Runs entirely server-side (TCP connect probes via Node's built-in `net`,
  reverse DNS via `dns.promises.reverse` — no new dependency) since a
  browser can't open raw sockets; the client just starts a scan and polls
  its progress once a second. Each open port found gets a **+ Add** button
  that opens the normal Add Service modal pre-filled with a guessed
  name/URL — nothing is added automatically, and a port that's already
  behind an existing service shows "Added" instead. Capped to subnets of
  roughly a /22 or smaller as a safety limit, and results reset on server
  restart (nothing about a scan is persisted).
- **Wake-on-LAN** — an optional MAC address field on any service unlocks a
  ⚡ button (on its card and its list row) that broadcasts a standard WOL
  magic packet on port 9. It's a one-way UDP broadcast — no auth, no
  response expected, no dependency beyond Node's built-in `dgram` — so
  "success" only means the packet went out, not that anything woke up
  (wrong MAC, WOL disabled in BIOS/NIC settings, or a device on a different
  VLAN than this server all fail silently the same way, with no way for
  this app to distinguish them). Network discovery autofills this when it
  can: a TCP probe to a same-subnet host populates this machine's own ARP
  cache as a side effect, so after a scan, `arp -a` usually already has the
  MAC for anything discovery found — no manual typing needed for most
  devices added that way.
- **Service Control** — an opt-in "advanced" section on any service's Edit
  screen lets you save a start/stop/restart shell command (e.g. `docker
  restart jellyfin`), each one independent — a service can have just a
  restart hook and no separate start/stop if that's all it needs. Websites
  are excluded by convention, not by code: the fields are just never filled
  in for them. Runs on the host, so it's off by default behind two
  independent switches: Settings → Security → Service Control (an explicit
  opt-in separate from just having a password set) *and* password
  protection itself — the toggle can't even be turned on until a password
  is set, since this is the one feature that runs commands on the host.
  Every attempt is written to the activity log (who, what, success/fail),
  each command gets a 20s timeout and its output is capped and shown back
  in a toast, and a short cooldown per service+action guards against an
  accidental double-click re-running something. Stop/restart ask for
  confirmation first; start doesn't, since there's nothing to lose. A
  successful call schedules a recheck a few seconds later so the status
  dot catches up once the process has actually changed state. The Board's
  **Docker widget** (ops roadmap Phase 2b) rides the same switch — its
  start/stop/restart buttons act on raw containers by name and are inert
  (and say so) until Service Control is on; its logs view is read-only and
  needs only a normal session.

- **Game servers** (Add/Edit Service → Game server, creative roadmap Phase 5)
  — give a service a `game` config and it stops being HTTP-pinged: it's
  checked over its own protocol, the card shows the **player count** instead
  of latency, and a **🎮 console** button appears.
  - **Minecraft** — RCON (`server/rcon.js`, a ~70-line Source-RCON client on
    `node:net`, no dependency). The health sweep runs `list` for the count;
    the 🎮 console runs any command you type and shows the reply, with the
    player list refreshing after each one. `enable-rcon=true` + `rcon.port` +
    `rcon.password` in `server.properties`. The RCON password is stored on the
    host and **stripped by `sanitizeConfig`** before config reaches a client
    (like the Jellyfin key and the password hash); the service-modal field is
    write-only. Running a command is gated behind **Service Control**
    (Settings → Security) *and* password auth — an RCON command can `stop` the
    server or `ban` a player, so it gets the same double lock as a shell hook.
    Every command run is activity-logged (`control`).
  - **FiveM** — read-only, via the FXServer's own `/dynamic.json` /
    `/players.json` / `/info.json` on the game port (no auth). The card shows
    the player count; the 🎮 panel shows the server name, gametype, map,
    build, resource count, and the player list with pings, and links out to
    txAdmin (`↗`) for restart and console — txAdmin's control API needs a full
    master-account login, which Mission Control deliberately doesn't hold. The
    FiveM `game` config is just `{ kind:'fivem', queryUrl, txAdminUrl? }`.
  - The player-list read only needs a normal session (like `/logs`).

  A second controller type, **Docker container**, talks to the Docker
  Engine API directly (over its local named pipe on Windows, no client
  library — just enough HTTP request-building for start/stop/restart, a
  container-list, and a log fetch) instead of running a shell command, so
  there's only one field to fill in: a container name or ID, with a
  "Browse…" button that lists your actually-running containers to pick
  from instead of typing one by hand. Docker-backed services also get a
  📜 Logs button — a snapshot of the container's recent stdout/stderr,
  refreshed automatically every few seconds while the modal is open. This
  is deliberately *not* a live stream (`docker logs -f`): it's a
  read-only poll of `docker logs`'s own tail, simpler and without holding
  a long-lived connection open per viewer. Unlike start/stop/restart,
  viewing logs only needs a normal signed-in session — it doesn't run
  anything, so it isn't gated behind the Service Control switch, though
  the button itself only appears once that switch is on (same as every
  other control button) to keep the feature discoverable as one thing.
- **Snippets** (Settings → Snippets, creative roadmap Phase 2) — a saved list
  of shell commands, each with a **Run** button that runs it on the host with
  the Code workspace as its working directory (or a folder you set, absolute
  or workspace-relative). Same double lock as Service Control: editing the
  list only needs the password, but *running* one also needs the "Allow
  snippets to run on this host" switch, and the run endpoint only ever
  executes a string that's already saved — never one from the request. Output
  (exit code, elapsed ms, stdout/stderr) shows inline under the row, green or
  red by exit status; each run is activity-logged. A **shipped catalog**
  (`server/data/snippets-catalog.json`) offers ready-made entries — "Checks"
  add to the coding agent's `run_checks` list (Settings → Code), "Snippets"
  add to the list here — all opt-in, nothing active until you click Add, with
  a note when an entry is for the other OS. The list lives in
  `config.snippets`, the switch + timeout in `config.security.snippetRunner`.
- **Scheduled tasks** (Settings → Scheduled, ops roadmap Phase 4) — a
  repeating **snippet**, **Minecraft RCON command**, **service restart**,
  **folder backup** (zip a directory, keep the last N — via the same
  hand-rolled `zip.js` as the Files download), **wallpaper generation**
  (a fresh ComfyUI wallpaper into the gallery), or **activity digest** (a
  summary of the last N hours' log, sent through the alert webhook).
  `when` is a short string — `every 30m`, `every 2 hours`, `daily at 03:00`,
  `weekly on monday at 09:30` (the host's local clock) — checked once a
  minute by `server/scheduler.js`; a task that came due while the host was
  off runs shortly after it's back. **No new privilege:** each action rides
  the switch its manual version needs — snippet runner, Service Control,
  password (for backup), ComfyUI, a configured webhook — checked at fire
  time, so a task whose switch is off is logged (category `schedule`) as
  *skipped*, not run. Editing the list needs only the normal session, like
  editing snippets; each task has an On toggle, a **Run now** button, and
  shows its last result inline. Lives in `config.schedules`.
- **Jellyfin** (Settings → Jellyfin, creative roadmap Phase 4) — point it at
  your Jellyfin server with a URL and an API key (made under Jellyfin's
  Dashboard → API Keys) and the Board view's **Jellyfin now-playing widget**
  shows what's playing on every device, with a poster, a progress bar, and
  play / pause / skip / stop. The key is stored on the host and **never sent
  to a browser** — `sanitizeConfig` strips it the same way it strips the
  password hash, the settings field is write-only (blank = keep the saved
  one), and the poster loads through a server proxy so an `<img>` tag never
  needs it. Sending a transport command is activity-logged (`control`) but
  not confirmed — it's just a media control, nothing to lose. The connection
  is `config.jellyfin` (`baseUrl` + `apiKey`).
- **External alerts** — Settings → External Alerts fires an outbound
  webhook on every online↔offline transition, in addition to (not instead
  of) the in-page toast and desktop notification — the difference is this
  one fires even when nobody has the dashboard open, since it's driven by
  the server's own health-check sweep rather than a browser polling it.
  Three payload shapes to match where it's going: **Discord** (`content`),
  **Slack** (`text`), or **Generic JSON** (`{event, service, status,
  timestamp}` for your own automation — Home Assistant, n8n, a script,
  whatever). "Send test alert" saves the form first, then fires one
  immediately so you can confirm the URL actually works without waiting for
  a real status change. The webhook URL field is masked
  (`type="password"`) the same as other secrets in this app, since a
  Discord/Slack webhook URL is a bearer credential — anyone with it can
  post to that channel. Same failure-isolation as everything else
  background here: a broken or rate-limited webhook is logged and skipped,
  never allowed to interrupt health checking itself.
- **Password protection** (Settings → Security) — optional, off by
  default. One shared passphrase for the whole app, not a per-person
  account system — set it once and every route (pages, API, WebSocket)
  requires a valid session, except the login page itself. Sessions are an
  `HttpOnly`, `SameSite=Strict` cookie with a sliding expiry (30 days by
  default, adjustable 1–365 in Settings — a change applies to every
  existing session immediately, not just new ones), checked against an
  in-memory server-side session map (nothing you can forge from the
  client — and, being in-memory, every session ends when the server
  restarts, so everyone signs in again after a restart). Passwords are hashed with `scrypt` — Node's own built-in, no
  new dependency — salted per-install, never sent to any client in any
  form (`GET /api/config` and every WebSocket `config` push run through
  `sanitizeConfig()`, which strips the salt/hash before the payload leaves
  the server). Five wrong attempts from one IP locks out further tries for
  5 minutes. Every mutating request also carries a custom header
  (`X-Mc-Request`) checked server-side once auth is on — a second,
  independent layer alongside the cookie's own `SameSite=Strict`, since a
  cross-origin page can't attach a custom header to a fetch against this
  server without a CORS preflight this server never grants. See the
  Security note below for the actual threat model this answers.
- **Config export/import** — Settings → Backup & Restore. Export downloads
  `config.json` as-is (services, groups, connections, chat channels,
  settings, alerts) with a dated filename. Import is a **wholesale
  replace**, not a merge — services, groups, and connections are fully
  swapped for whatever's in the file; chat channels/shared-folder/alerts
  settings only get replaced if the import actually includes them,
  otherwise your current ones are left alone. Connections referencing a
  service id the new roster doesn't have are dropped automatically rather
  than left dangling. The frontend gates this behind a `confirm()`, and the
  server also writes its own timestamped snapshot of whatever's about to be
  replaced to `server/data/backups/` (gitignored, last 5 kept) before every
  import — so even a mis-clicked or mistakenly-tested import has a
  server-side recovery path, not just the `confirm()` dialog standing
  between you and data loss. A password, if one is set, is never part of
  either direction — export strips it entirely, and import can never
  set/change/disable it, even from a malicious or stale file.
- **IP allowlist** (Settings → Security) — optional, off by default.
  Restricts the whole app (pages, API, WebSocket) to specific CIDR ranges
  (e.g. `100.64.0.0/10` for Tailscale, `192.168.1.0/24` for a LAN subnet) —
  a request from outside every configured range gets rejected before it's
  even offered the login page. `127.0.0.1` is always allowed regardless of
  the list, and saving a change that would exclude your own current IP is
  refused outright, so this can't lock out the machine running the server
  or the device configuring it. Independent of password protection — the
  two can be used together or separately.
- **Activity log** — every add/change/remove (services, groups,
  connections, chat channels, settings, config import/export), every
  service going online/offline, every new device seen, every shared-folder
  file change, every discovery scan, every game-server / Jellyfin / snippet
  command, and every auth event (sign-ins, failures, rate-limit hits,
  password changes) gets one line — printed to the server console as it
  happens and appended to a dated file under `server/data/logs/`
  (gitignored), pruned after 30 days. Each line names what happened and,
  where there's an acting device, its IP — e.g.
  `[2026-08-16T08:36:10Z] [service] Created "Jellyfin" (100.98.221.75)`.
  The **Activity** view (ops roadmap Phase 1) shows the whole stream: filter
  by category (16 of them, collapsed into 5 colour buckets), by time window
  (hour / day / week / month), or by a text search; "Load older" pages back
  through the retained files; and a WebSocket push appends each new line
  live. `GET /api/activity` (newest-first, `?category=&hours=&search=&before=`)
  is the one structured read over the log — it shares
  `activityLog.js#readRecentActivity` with the assistant's `get_activity_log`
  tool.

## Configuration

Everything lives in `server/data/config.json` — services, groups,
connections, and settings — and is the source of truth (there's no
database); edit it by hand or through the UI. That file is **gitignored**,
since it fills up with your actual LAN addresses and shared-folder path as
you use the app. [`config.example.json`](server/data/config.example.json)
is the committed template (the same starter services as the initial brief:
Ollama, Open WebUI, ComfyUI, Jellyfin, Tailscale, a local "Unclaimed" game
dev server) — `server/config.js` copies it to `config.json` automatically
the first time the server runs, or any time you delete `config.json` to
reset to defaults.

Notable fields:
- `settings.trustProxy` — `false` by default. Leave it off unless Mission
  Control sits behind a reverse proxy that sets `X-Forwarded-For` (nginx,
  Caddy, `tailscale serve`). With no proxy in front, that header is
  attacker-controlled, and trusting it would let any client spoof its IP
  past the login rate-limiter and the IP allowlist — so off, the client IP
  is always the real TCP peer address. Changing it takes effect on the next
  request (or set it through the settings API); a hand-edit needs a restart.
- `services[].healthCheck` — set `false` to show a card without polling it
  (useful for services with no stable local HTTP port, like Tailscale, or
  for a public website bookmark you don't need uptime tracking for).
- `services[].healthCheckPath` — appended to the service URL for the ping
  (e.g. Jellyfin's `/health`).
- `services[].game` — makes it a game server (see the Game servers section):
  `{ kind:'minecraft', rconHost, rconPort, rconPassword }` (rconPassword is
  stripped by `sanitizeConfig`; clients see `hasRconPassword`) or
  `{ kind:'fivem', queryUrl, txAdminUrl? }` (all read-only, nothing secret).
- `services[].icon` — an emoji, or leave it `""` to render the site's
  favicon instead. `services[].iconImage` (a timestamp, set by "Generate
  icon") overrides both with a ComfyUI-generated icon.
- `snippets` — `{id, label, command, cwd}` entries for the snippet runner,
  edited through Settings → Snippets. `security.snippetRunner.enabled`
  (default `false`, refused without `auth.enabled`) is the switch that lets
  them actually run; `security.snippetRunner.timeoutMs` bounds each run.
- `schedules` — `{id, label, when, action, enabled, lastRun, lastResult}`
  entries for the scheduler (ops roadmap Phase 4), edited through Settings →
  Scheduled. `action.type` is `snippet` / `command` / `restart` /
  `backup` (`{sourcePath, destPath, keep}`) / `wallpaper` (`{themeId,
  extraPrompt}`) / `digest` (`{hours}`); each still rides its feature's
  switch at fire time. `server/scheduler.js` owns the 60-second tick.
- `widgets` — `{id, type, title, size, …}` tiles for the dashboard's Board
  view (`type` is `iframe` / `note` / `links` / `fetch` / `jellyfin` /
  `host-stats` / `service-status` / `clock` / `countdown` / `photo` /
  `docker`), edited from that view. Display config only. A `fetch` widget's `url` is GET-ed
  server-side and can point at anything the host can reach (a LAN API,
  localhost) — any token in it is stored like the alert webhook URL, visible
  to signed-in devices.
- `jellyfin` — `{ baseUrl, apiKey }` for the now-playing widget. The `apiKey`
  is stripped by `sanitizeConfig` (clients see `hasApiKey` only) and the
  settings field only ever *sends* a key, never round-trips one.
- `sharedFolder.path` — relative paths resolve against the project root; use
  an absolute path to point anywhere else on the host.
- `chatChannels` — `{id, name}` pairs, optionally with an `ollama` object
  (`botName` / `botEmoji` / `systemPrompt`) that overrides the assistant's
  personality just in that channel. Edited through the ＋ / ✎ / ✕ controls
  in the Chat tab, not usually by hand. An install from before chat existed
  gets a default `General` channel written in automatically the first time
  the server starts.
- `ollama` — the local-LLM chat assistant's settings (`baseUrl`, `model`,
  `systemPrompt`, `botName`/`botEmoji`, `trigger`, context/keep-alive/token
  limits, `active`, `tools` (read-only lookups), and `actions` (proposes
  actions for you to confirm — needs `auth.enabled`). Edited through
  Settings → Ollama. New fields are added automatically to an older
  `config.json` on the next start. Every field here is sent to browsers as-is, so never put an API
  token in it — a local Ollama needs none.
- `code` — the Code tab's settings (`enabled`, `workspacePath`,
  `defaultModel`, `defaultApprovalMode` — `ask` / `auto-edit` / `auto-all`,
  the seed for a new session's own mode — `maxSteps`, `contextTokens` (the
  `num_ctx` handed to Ollama and the context meter's denominator),
  `compactAtPercent` (default 75 — the % of the window at which a long turn
  compacts its earlier steps; Code parity roadmap 1b),
  `contextFileName` / `memoryFileName` (the two workspace docs read into the
  prompt each turn — `AGENTS.md` source-of-truth and `AGENTS-memory.md` agent
  notes, either blank = off), `allowCommands` + `commandTimeoutMs` for the `run_command`
  tool, `commandRules` (`{allow, deny}` glob lists — deny refuses a command
  outright, allow skips its Confirm card, else the session mode; deny is
  seeded with dangerous/outbound patterns; Code parity roadmap 2b),
  `checks` (`[{label, command}]` — the verification commands `run_checks`
  runs) + `checkTimeoutMs`, `disabledTools` (names of non-core tools the agent
  is not offered — Code parity roadmap 2a), `visionModel` + `visionTimeoutMs`
  (the Ollama model that describes an attached image so a non-multimodal
  coding model can act on it — Code parity roadmap 4a), and the reply timeout).
  The Ollama connection is reused from `ollama.baseUrl`. `enabled` and
  `allowCommands` are both refused unless `auth.enabled` is also on. A blank
  `workspacePath` resolves to a `code` subfolder of the shared folder, or
  `./workspace` if sharing is off. Edited through Settings → Code; each
  session's `model` and `approvalMode` and the whole transcript live in
  `data/code-sessions.json`, not here.
- `comfy` — ComfyUI image generation for the Code agent and the `@cyn` chat
  assistant. `baseUrl` (default `http://127.0.0.1:8188`), `workflow` (an
  API-format ComfyUI graph you paste in Settings → ComfyUI), `mapping` (which
  node input holds the prompt / seed / size / checkpoint — auto-detected from
  the workflow, editable), `model` (default checkpoint), generation defaults
  (`defaultNegative` / `defaultWidth` / `defaultHeight` / `defaultSteps` /
  `defaultCfg`, plus `promptPrefix` / `promptSuffix` that wrap the agent's
  prompt), and behaviour (`timeoutMs` — raise it for CPU generation or a big
  workflow; `ejectAfterMin` for the idle VRAM release; `maxPerTurn`;
  `outputDir` for where images land in the workspace). `enabled` is refused
  unless `auth.enabled` is on. Edited through Settings → ComfyUI. Used by both
  the Code agent's `generate_image` tool and the `@cyn` chat assistant's
  `generate_image` action.

## Security note

**Authentication is optional and off by default.** With it off, this app
has the original trusted-LAN model: anyone who can reach the server's port
can view every service's status, browse/upload/delete the shared folder
(if enabled), read and post chat under any name, wake devices, trigger a
network scan, export/import the whole config, and see every connected
device's IP, browser/OS, and this machine's live host stats. That's still
a reasonable default on a LAN you fully trust and control.

**Turn on Settings → Security if your actual threat model includes "someone
gets onto my network who shouldn't be there"** — a breached Tailscale node
(stolen auth key, compromised device already in your tailnet) or a
compromised/rogue device on the LAN itself. Once a password is set, every
route above requires a valid session; see "Password protection" above for
exactly what that does and doesn't cover. Two things worth being explicit
about:

- **Plain HTTP, not HTTPS.** This app is normally reached over plain
  `http://` on a LAN or Tailscale address, not `https://`. Tailscale
  traffic is already encrypted at the WireGuard layer, so a Tailscale
  breach isn't affected by the app itself lacking TLS — the attacker looks
  like any other tailnet device either way, which is exactly what the
  password gate is for. Plain-LAN HTTP is different: something else *on
  the same LAN segment* (ARP spoofing, a compromised switch/AP) could in
  principle observe the password in transit. Real HTTPS (a reverse proxy
  or a self-signed cert trusted per-device) would close that specific gap
  but is a meaningfully bigger setup lift — not done here, worth it only
  if plain-LAN access (not just Tailscale) matters as much to you as the
  password itself.
- **One password, not per-device/per-person accounts.** There's no
  concept of "this device is read-only" or "revoke just this one login" —
  disabling protection or changing the password affects every session
  everywhere at once (changing it doesn't currently invalidate other
  active sessions; only "Disable password protection" does, by clearing
  every session outright). Proportionate to a personal single-operator
  hub; if you ever need finer-grained access, that's a bigger feature than
  what's here.

Everything the original no-auth model already documented still applies
underneath the password gate — it's a doorlock, not a rewrite of what's
behind it: the WebSocket carries the same real-time sync and chat data,
Connected Devices/Host PC Health still surface machine-level detail to
anyone with an authenticated session, network discovery still makes this
server open short-lived TCP connections to every address on its local
subnet(s) when triggered (which is exactly what a port scanner does, and
may get flagged by security software elsewhere on someone else's network —
fine on a home LAN you control, think twice on a shared/work one), and an
external-alerts webhook URL is still a bearer credential worth protecting
even from other people who do have a valid session. Don't port-forward
this to the public internet as-is — a shared password over plain HTTP is
not a substitute for real internet-facing hardening — and keep
`allowDelete` off unless you want any authenticated device to be able to
remove shared-folder files.

**Service Control, the Code tab, and the snippet runner all *require* the
password gate.** Every other feature in this app works the same whether or
not auth is on; these refuse to even be turned on in Settings until a
password is set, because they run commands and write files on the host
rather than just reading/writing config. For Service Control and the
snippet runner the commands are ones you write yourself (in a service's
Edit screen, or the Snippets tab), so the risk they guard against isn't
injection but an unauthorized party triggering a command you already
wrote — and both keep a second explicit switch on top of the password for
exactly that reason. **The Code tab is broader** — a local model proposes the
file writes and (if you turn on `run_command`, a second opt-in) the shell
commands. Its safeguards are the password gate, the per-session approval
mode (every change confirmed in the transcript unless you pick "auto-all"),
the workspace-folder confinement on all file paths, and the `code`-category
activity log. A confirmed `run_command` is still an arbitrary command run
as the Mission Control user — treat "enable commands + auto-all" the way
you'd treat handing someone a shell.

**The IP allowlist and the activity log are both independent of the
password gate above** — the allowlist is a network-layer restriction
(reduces who can even reach the app), the log is a record of what
happened (helps you notice if something did), and neither requires a
password to be set. Worth knowing: the client IP used by the allowlist,
the login rate-limiter, device tracking, and the activity log is the real
TCP peer address — not the `X-Forwarded-For` header, which is ignored
unless `settings.trustProxy` is turned on for a real reverse-proxy setup.
So an IP here can't be forged by a header, but on a network with an
untrustworthy DHCP server or where L2 spoofing is plausible it's still an
identifier, not a proof of identity; the password gate is what actually
identifies who's asking. If you *do* enable `trustProxy`, make sure the
proxy is the only way in — a direct connection that bypasses it can then
set the header freely. The activity
log's file only ever lives on this machine — anyone with authenticated
dashboard access still can't read it through the app, since there's no
in-app viewer for it, only the server's own console and its log files.

## Architecture

```
server/
  index.js               Express entrypoint: binds 0.0.0.0, mounts routes,
                          attaches the WebSocket server, graceful shutdown
  config.js               Reads/writes config.json, seeds it from
                           config.example.json on first run, migrates in
                           fields (like chatChannels) added after your
                           config.json already existed, emits 'config' on
                           every save
  healthChecker.js         Background polling loop, status cache, and the
                            per-service uptime history ring buffer; emits
                            'status' after every sweep or on-demand check
  chat.js                  In-memory chat message store (last 200 per
                            channel) + attachment file lifecycle on disk;
                            emits 'chat:message' / 'chat:messageUpdated'
                            (in-place edit, for the Ollama assistant's
                            thinking→reply swap) / 'chat:messageDeleted'.
                            readAttachmentAsContext() reads a text-ish
                            attachment (capped, binary-sniffed) for the
                            assistant, or returns a note about why it can't.
  devices.js                In-memory device tracker (last 100 IPs): UA
                             parsing, request counts, live WS connection
                             count — no events, just read on request
  profiles.js               Per-device profile store — data/profiles.json,
                             cache + write-queue like codeStore.js; keyed by
                             the client's `mc:deviceId`. name + avatar
                             ({kind:'sprite',seed} or {kind:'image',file} in
                             data/avatars/); emits 'profile:updated'.
  host.js                    Background CPU/memory/disk sampler (5s), also
                             just read on request, no events; keeps a
                             ~10-minute ring of samples (getHostHistory) for
                             the Board host-stats widget's sparkline, served
                             opt-in via GET /api/host?history=1
  discovery.js                LAN subnet scanner: TCP-connect probes across
                               a curated port list + reverse DNS + arp -a for
                               MAC addresses, in-memory scan state
                               read/started/cancelled on request, no events
  wol.js                       Builds + sends a Wake-on-LAN magic packet
                                over UDP broadcast, no events
  serviceControl.js             Runs a service's saved start/stop/restart
                                 shell command (child_process.exec, timeout +
                                 truncated output). controlService() is the
                                 full gated flow (both switches + dispatch +
                                 log + recheck) shared by the route and the
                                 assistant's control_service action
  docker.js                      Minimal Docker Engine API client (named
                                  pipe on Windows, no client library) —
                                  container start/stop/restart, list, logs,
                                  one-shot CPU/memory stats
  tailscale.js                    Runs `tailscale status --json` — the
                                  boiled-down check (backs the
                                  tailscaleHealthCheck flag) plus a fuller
                                  read (self + peers) for the assistant
  ollama.js                       Minimal Ollama REST client (node:http, same
                                  as docker.js — not fetch, whose undici
                                  headers timeout killed slow first-token
                                  generations; the caller's AbortController is
                                  now the only clock) — model list, ping,
                                  preload/unload, /api/ps, showModel (a model's
                                  real context_length for the Code tab's meter,
                                  plus its `capabilities` → `vision` / `tools`
                                  flags for Code parity 4a), and chat both
                                  one-shot (chat — the test button, the 1b
                                  compaction summary, the 4a vision describe;
                                  takes `think:false` to skip reasoning) and
                                  streaming (chatStream, NDJSON reader that also
                                  surfaces tool_calls, skips a "thinking"
                                  model's reasoning tokens, passes num_ctx
                                  through). `message.images:[b64]` rides the
                                  normal chat body for a multimodal model.
  ollamaTools.js                  Read-only lookups the assistant can call
                                  when config.ollama.tools is on — a small
                                  REGISTRY (name / label / description /
                                  params / handler per tool): list_services,
                                  get_host_health, list_devices,
                                  get_connections, get_service_logs,
                                  get_activity_log, get_uptime_history,
                                  search_shared_folder, get_recent_uploads,
                                  run_network_scan, get_settings,
                                  list_containers, get_container_stats,
                                  get_tailscale_status, list_ollama_models,
                                  get_loaded_models, get_game_servers,
                                  get_now_playing, list_widgets, list_snippets
                                  (last four: ops roadmap Phase 3a) — plus an
                                  ACTION_REGISTRY
                                  (wake_device, control_service, send_alert,
                                  add_service, add_connection, generate_image
                                  when ComfyUI is on, and — ops roadmap Phase
                                  3b — run_snippet, game_command,
                                  jellyfin_control, add_widget) whose
                                  entries have prepare()/execute() and only run
                                  after an in-chat confirmation. Adding a
                                  read tool = one READ_REGISTRY entry.
  widgetStore.js                  addWidget config-write helper (count cap,
                                  sanitizeWidget, activity log) — shared by
                                  routes/widgets.js and the assistant's
                                  add_widget action (ops roadmap Phase 3b)
  serviceStore.js                 addService / addConnection config-write
                                  helpers — shared by routes/services.js,
                                  routes/connections.js, and the assistant's
                                  add_service / add_connection actions
  widgets.js                      sanitizeWidget (creative roadmap Phase 3,
                                  ops roadmap Phase 2) — per-type validation
                                  for a config.widgets entry (iframe / note /
                                  links / fetch / jellyfin / host-stats /
                                  service-status / clock / countdown / photo /
                                  docker); the type is fixed once created.
  widgetFetch.js                  The 'fetch' widget's server side —
                                  fetchWidgetValue (GET the endpoint, 8s
                                  timeout, 256 KB cap) + applyTemplate (a
                                  {{ dotted.path }} → parsed-JSON resolver).
  jellyfin.js                     Thin Jellyfin client (creative roadmap
                                  Phase 4) — pingJellyfin, getNowPlaying
                                  (normalises /Sessions to just what's
                                  playing), sendCommand (POST /Playing/{cmd}),
                                  fetchImage (poster proxy). Auth is the
                                  X-Emby-Token header from config.jellyfin.apiKey,
                                  which never reaches a client.
  rcon.js                         Minimal Source-RCON client (creative roadmap
                                  Phase 5) — one command per connection, on
                                  node:net, no dependency.
  gameServers.js                  Game-server helpers — getMinecraftStatus
                                  (RCON `list` → parsed player list),
                                  getFivemStatus (the FXServer's dynamic/
                                  players/info JSON, no auth; `full` also
                                  pulls names + server info for the panel),
                                  runMinecraftCommand; getGameStatus /
                                  runGameCommand dispatch by service.game.kind.
                                  Feeds healthChecker's game branch.
  ollamaActions.js                In-memory store of assistant actions
                                  awaiting a Confirm/Cancel in chat —
                                  prepareAction (validate + build the card),
                                  decideAction (run the tool on confirm,
                                  patch the card, log it), a 5-min expiry
                                  sweep
  fileShare.js                    Recursive shared-folder filename search +
                                  the in-memory recent-uploads list —
                                  shared by routes/files.js and the
                                  search_shared_folder / get_recent_uploads
                                  tools
  ollamaChat.js                   The assistant's runtime: on/off state
                                  (config.ollama.active — persisted, so it
                                  survives a restart and syncs via the config
                                  broadcast), model preload + keep-warm loop,
                                  status, and the `chat:message` listener
                                  that detects the trigger word, posts a
                                  pending "thinking" bubble, builds the
                                  channel context, runs any read-only tools
                                  the model asks for (ollamaTools.js, up to
                                  4 rounds), and streams the reply into that
                                  bubble (debounced updateMessage calls).
                                  Boot-preloads if left on.
  comfy.js                        Minimal ComfyUI API client (global fetch, no
                                  client library) — ping/system_stats,
                                  checkpoint list, queue, submit a workflow
                                  (POST /prompt), poll /history, fetch an
                                  output image (/view), POST /free to release
                                  VRAM, and openProgress() (a ws client for
                                  ComfyUI's real sampler-step progress)
  comfyLifecycle.js               initComfy() — a slow timer that POSTs /free
                                  once nothing has generated for
                                  config.comfy.ejectAfterMin minutes and the
                                  queue is clear (0 = never). No preload half;
                                  ComfyUI loads a checkpoint on demand.
  comfyImage.js                   Image generation shared by the Code agent
                                  and the @cyn chat action — validateWorkflow
                                  (rejects the ComfyUI editor export),
                                  autodetectMapping (walks out from the
                                  KSampler to find the prompt / seed / size /
                                  checkpoint nodes), buildWorkflow (clone the
                                  graph, patch those inputs per generation),
                                  generate() (submit → poll → download, N
                                  prompts for N variations, live step progress
                                  from ComfyUI's ws, honours Stop).
                                  comfyLastActivity() feeds comfyLifecycle.js.
  artPrompts.js                    Prompt builders for the three generated-image
                                  targets — buildWallpaperPrompt (a hand-written
                                  art phrase per theme), buildAvatarPrompt
                                  (subject + optional preset style),
                                  buildServiceIconPrompt (name + description) —
                                  each with a suffix that pins the output shape.
  artGen.js                       Bridge from "picture for X" to comfyImage.js:
                                  assertComfyReady() + generateWallpaper /
                                  generateAvatar / generateServiceIcon —
                                  compose the prompt, force a modest size/steps
                                  (768×432/12 or 512²/14), return one buffer + seed.
                                  Also withArtLock / isArtGenerating — the
                                  one-at-a-time guard, shared by routes/art.js
                                  (→ 409) and scheduler.js (→ skip).
  wallpaperStore.js               The shared pool of generated wallpapers —
                                  data/wallpapers/ + wallpapers.json, cache +
                                  serialized write queue like profiles.js,
                                  capped at 24, emits 'art:wallpapers'.
  serviceIcons.js                 One generated icon file per service id
                                  (data/service-icons/<id>.png, no index —
                                  the service's own iconImage timestamp is the
                                  state). save/has/delete + id validation.
  codeWorkspace.js               The Code tab's sandbox — resolves the
                                  workspace folder (config.code.workspacePath,
                                  or a `code` subfolder of the shared folder,
                                  or ./workspace) and does path-guarded
                                  list/read against it, same safeResolve
                                  pattern as routes/files.js. Also the two
                                  prompt docs codeAgent.js folds into the
                                  system prompt (16 KB cap each): readContextFile
                                  / createContextFile for the source-of-truth
                                  file (config.code.contextFileName), readMemoryFile
                                  / ensureMemoryFile / appendToMemoryFile for the
                                  agent's memory file (config.code.memoryFileName,
                                  created on first run; appendToMemoryFile backs
                                  "Save plan → memory").
  codeStore.js                   Durable Code sessions — data/code-sessions.json,
                                  same cache + write-queue shape as timesheet.js;
                                  emits code:sessions / code:message /
                                  code:messageUpdated. Unlike chat these persist.
  codeTools.js                   The Code agent's tools, workspace-scoped via
                                  codeWorkspace.js#safeResolve. READ (run
                                  directly): list_dir, read_file (line
                                  offset/limit), search_text (content grep —
                                  regex/glob/scope; rejects a catastrophic-
                                  backtracking regex and caps pattern length +
                                  scan time so a bad pattern can't stall the
                                  event loop), find_files (name/glob) —
                                  4000-file scan cap, node_modules/.git/build
                                  ignored (the same walk backs the exported
                                  listWorkspaceFiles, for the composer's `@`
                                  picker) — plus run_checks (runs
                                  config.code.checks — the user's own syntax/
                                  lint/test commands — via codeExec; no
                                  approval, no allowCommands, offered only when
                                  a check is configured). WRITE ({prepare,execute} pairs,
                                  approval-gated): write_file, edit_file
                                  (exact-substring; rejects an empty old_string),
                                  append_file (add to a file's end — the notes
                                  primitive), create_dir, delete_path (files +
                                  empty dirs), run_command (shell, cwd =
                                  workspace — only when config.code.allowCommands
                                  is on), and generate_image (ComfyUI →
                                  writeBinaryFile into the workspace — only when
                                  config.comfy.enabled; autoInEditMode, per-turn
                                  count cap from config.comfy.maxPerTurn).
                                  run_command also takes background:true →
                                  codeBackground.js, and check_command /
                                  stop_command read + end one (offered only once
                                  a background command exists). getCodeToolDefinitions
                                  hides anything in config.code.disabledTools.
                                  prepare() builds a textDiff for a write, or
                                  checks the relevant switch. Plus two
                                  definition-only tools codeAgent.js intercepts:
                                  ASK_USER_TOOL — posts a question card and
                                  suspends the turn until the user answers
                                  (answerQuestion, POST /sessions/:id/answer/:qid);
                                  and UPDATE_TASKS_TOOL (Code parity roadmap 1a)
                                  — whole-list-replace of the session's task
                                  list, shown live in the Code view's task
                                  panel (withheld in plan mode).
  codeExec.js                    runInWorkspace(config, command, {cwdRel}) —
                                  child_process.exec with the workspace as
                                  cwd, config.code.commandTimeoutMs, captured
                                  + capped output. Same shape/trust model as
                                  serviceControl.js; backs a foreground run_command.
  codeBackground.js              Background shell commands (Code parity roadmap
                                  2a) — run_command({background:true}) spawns a
                                  detached process, buffers its output in a ring,
                                  and check_command / stop_command / the Code
                                  view's running-processes strip act on it.
                                  Capped at 4 live per session + a 2h age reaper;
                                  killed on session delete (stopSessionBackground)
                                  and server shutdown (stopAllBackground). Emits
                                  code:background.
  codeCheckpoints.js             Per-turn file checkpoints (Code parity roadmap
                                  2c). captureBeforeWrite copies a path's
                                  pre-write bytes into
                                  data/code-checkpoints/<session>/<message>/
                                  before a write tool touches it (first touch
                                  per turn wins; >8 MB recorded but not
                                  copied); finalizeCheckpoint writes meta.json
                                  + prunes to the last 10 turns;
                                  revertCheckpoint restores every captured path
                                  (undelete / un-create / roll back).
                                  dropSessionCheckpoints on session delete.
                                  run_command effects aren't captured — just
                                  flagged (noteCommandRun). No git.
  codeCommandRules.js            Per-command allow/deny rules (Code parity
                                  roadmap 2b). classifyCommand(rules, command)
                                  → 'deny' | 'allow' | 'ask' — a shell-ish glob
                                  (`*`/`?`, case-insensitive, whitespace-
                                  collapsed, anchored) matched against the whole
                                  command; deny beats allow. codeAgent.js's
                                  approval step calls it for run_command (fore-
                                  and background). DEFAULT_DENY (seeded into
                                  config.code.commandRules.deny on migration and
                                  served by GET /api/code/tools for the "restore
                                  defaults" button) is the catastrophic/outbound
                                  starter set. sanitizeCommandRules trims/caps.
  snippets.js                    The snippet runner (creative roadmap Phase 2):
                                  loadCatalog (the shipped
                                  data/snippets-catalog.json), sanitizeSnippets
                                  (trim/cap/id the config.snippets list), and
                                  runSnippet — exec with the snippet's cwd (or
                                  the workspace), config.security.snippetRunner
                                  .timeoutMs, same capped-output shape as codeExec.
  scheduler.js                   Scheduled tasks (ops roadmap Phase 4): a 60s
                                  tick that fires the due entries in
                                  config.schedules. parseWhen / describeWhen
                                  (every Nm|Nh · daily at HH:MM · weekly on DAY
                                  at HH:MM), sanitizeSchedules (keeps
                                  lastRun/lastResult by id), runScheduleNow.
                                  Each action re-uses runSnippet /
                                  runGameCommand / controlService (4a) or
                                  zip.js + generateWallpaper + sendCustomAlert
                                  (4b: backup / wallpaper / digest) and its
                                  gate.
  codeAttach.js                  Message attachments (Phase 9): processAttachments
                                  turns the POST body's [{name,content}] into
                                  chip metadata + per-file prompt text (text
                                  detection via textFiles.js, 24k-char cap,
                                  5-file cap); attachmentBlock fences it for the
                                  turn. Text only, never stored.
  codeMentions.js                `@file` mentions (Code parity roadmap 3a):
                                  processMentions(config, paths) reads each
                                  workspace-relative path (safeResolve-guarded,
                                  24k-char cap, 8 max, deduped) → chip metadata
                                  + prompt text; mentionBlock fences it as
                                  "[workspace file: <path>]". Read server-side,
                                  never stored — the model gets it for that turn.
  codeCommands.js                Custom /commands (Code parity roadmap 3b):
                                  built-in /review /test /explain, plus every
                                  <workspace>/.mc/commands/<name>.md (a file
                                  overrides a built-in). listCommands for the
                                  picker; resolveCommand(config, name, args)
                                  parses --- frontmatter (description / model /
                                  approvalMode), expands $ARGUMENTS, returns the
                                  prompt + any per-turn overrides. routes/code.js
                                  expands `/name args` here before runTurn.
  codeImages.js                  Attached-image handling (Code parity roadmap
                                  4a/4b). parseImageAttachments decodes the POST
                                  body's data URLs — png/jpeg/webp/gif only,
                                  4 MB / 4-image caps (index.js gives /api/code a
                                  24 MB body limit to fit) — into chip metadata +
                                  raw base64 for codeVision. saveImages writes
                                  the bytes to data/code-images/<session>/
                                  <message>-<i>.<ext> so the transcript can show
                                  them (imageFilePath guards the serving route,
                                  40-file-per-session prune); dropSessionImages
                                  on session delete.
  codeVision.js                  The agent's "eyes" (Code parity roadmap 4a).
                                  describeImages(config, images) runs each image
                                  through config.code.visionModel with think off
                                  (one bounded call apiece, config.code
                                  .visionTimeoutMs, chained to the turn's
                                  AbortController); visionBlock fences the result
                                  as "[image: <name> — described ...]" for
                                  buildMessages. The coding model never sees
                                  the pixels; whether a model *can* be the eyes
                                  is answered by ollama.js#showModel.
  textFiles.js                   isTextByName / looksBinary + the text-extension
                                  sets — shared by chat.js (attachment context),
                                  codeAttach.js, and codeTools.js.
  codeAgent.js                   The Code tab's runtime: a streamed agent
                                  loop — the model calls codeTools.js tools
                                  between rounds (cap config.code.maxSteps),
                                  each recorded as a "step" on the pending
                                  message (live). A write is prepared into a
                                  diff, then auto-applied or held for a
                                  Confirm/Reject step per the session's
                                  approval mode (ask | auto-edit | auto-all);
                                  a held write suspends the turn until
                                  decideApproval() resolves it. For run_command
                                  a codeCommandRules.js verdict comes first — a
                                  deny match is refused outright, an allow match
                                  skips the Confirm card (Code parity 2b). Just
                                  before a write executes its target's pre-write
                                  state is copied to a checkpoint
                                  (codeCheckpoints.js), flushed to the message's
                                  `checkpoint` flag at turn end for the "revert
                                  this turn" button (Code parity 2c). Every
                                  applied write is activity-logged (category `code`).
                                  Reuses ollama.js#chatStream +
                                  toolCalls.js#recoverToolCalls; keeps
                                  config.code.defaultModel warm and hands
                                  chatStream config.code.contextTokens as
                                  num_ctx (Ollama's ~4k default is too small
                                  for a coding turn). In-turn compaction
                                  (Code parity 1b): when the message stack
                                  passes compactAtPercent of the window
                                  (model max via showModel, cached), one
                                  ollama.js#chat call summarises everything
                                  since the system prompt into a recap (+ the
                                  current task list) and the turn continues
                                  from [system, recap]; a `compact` step marks
                                  it. buildMessages also re-states the task
                                  list each turn and drops the oldest turns
                                  past a 40%-of-window budget. Reads the two
                                  workspace docs (codeWorkspace.readContextFile +
                                  readMemoryFile) into the tail of the system
                                  prompt every turn, and ensures the memory
                                  file exists first. Any message attachments
                                  (codeAttach.js), `@file` mentions
                                  (codeMentions.js, Code parity 3a) and image
                                  descriptions (codeVision.js, Code parity 4a)
                                  are spliced onto the last user message for
                                  that turn; a /command (Code parity 3b)
                                  replaces it with the expanded template, and
                                  its frontmatter model / approvalMode override
                                  the session's for that one turn (runTurn
                                  `overrides`). An attached image is described
                                  by the vision model first, in a `vision` step.
  textDiff.js                    unifiedDiff(old, new) — LCS line diff to
                                  unified-diff text (hunks + context), plus
                                  diffStat. No deps. Feeds the write-tool
                                  review diffs.
  toolCalls.js                   recoverToolCalls(text, knownNames) — repairs
                                  a tool call a small model printed as plain
                                  text instead of making structurally (every
                                  call, for qwen2.5-coder under Ollama 0.33.x).
                                  Pulls the args object out with a string-aware
                                  brace scanner so code in a `content` value
                                  doesn't truncate it. Shared by ollamaChat.js
                                  and codeAgent.js.
  alerts.js                     Server-side online/offline transition
                                 tracker + outbound webhook sender (Discord/
                                 Slack/generic), independent of the
                                 frontend's own toast/notification tracker
                                 so it still fires with no browser open
  events.js                 The shared EventEmitter those two emit on —
                             the only thing ws.js listens to
  net.js                     clientIp(req) — the real TCP peer address, or
                              X-Forwarded-For only when settings.trustProxy is
                              on; shared by index.js, ws.js, auth.js, the log
  jsonStore.js               writeJsonAtomic() — temp-file + fsync + rename
                              (with a Windows rename-retry) so a killed or
                              power-lost write can't truncate config.json or
                              any of the sibling stores
  auth.js                    Optional password gate: scrypt hashing, an
                              in-memory session map with configurable
                              sliding expiry, login rate limiting, the
                              requireAuth/requireCsrfHeader middleware, a
                              manual cookie parser (no new dependency)
  ipAllowlist.js              Optional CIDR-based network gate, independent
                               of auth.js; isIpAllowed() shared by the
                               Express middleware and ws.js's upgrade check
  activityLog.js               Console + dated-file audit trail — every
                                add/change/remove, health transition, new
                                device, and auth event, called from every
                                route below. Emits 'activity' on appEvents for
                                the live timeline. readRecentActivity() parses
                                it back out (newest-first + search + a `before`
                                cursor for the Activity view; chronological for
                                the assistant's get_activity_log tool) — the
                                one structured read over an otherwise
                                write-only log.
  ws.js                     WebSocket server: broadcasts status/config/
                            chat/code/timesheet/art/activity events to every
                            connected device, and records each connect/
                            disconnect into devices.js
  data/
    config.example.json     Committed template — the source of truth for
                             what a fresh install looks like
    snippets-catalog.json   Committed — the shipped snippet/check catalog
    config.json              Gitignored — your actual live config
    chat-uploads/             Gitignored — chat attachment files
    code-sessions.json        Gitignored — Code tab session transcripts
    code-checkpoints/         Gitignored — per-turn file snapshots for the
                              agent's "revert this turn" button (2c)
    code-images/              Gitignored — images attached to Code messages,
                              kept for the transcript (4b)
    profiles.json             Gitignored — per-device name + avatar records
    avatars/                  Gitignored — uploaded profile pictures
    wallpapers/ + wallpapers.json   Gitignored — generated theme wallpapers
    service-icons/            Gitignored — generated per-service icons
  routes/
    services.js, groups.js, connections.js   CRUD over config.json,
                            plus services' /:id/check, /:id/wake,
                            /:id/start /:id/stop /:id/restart (gated on
                            security.serviceControl.enabled + auth.enabled,
                            dispatches to serviceControl.js or docker.js by
                            controller.type), /:id/logs (Docker only,
                            read-only, just needs a session), and (Phase 5)
                            /:id/game/status (player list, read-only) +
                            /:id/game/command (RCON, same double gate as
                            start/stop)
    snippets.js             GET / (list + runner switch + catalog +
                            hostPlatform), PUT / (save the list + switch +
                            timeout — switch refused without auth), POST
                            /:id/run (gated on security.snippetRunner.enabled
                            + auth.enabled; runs only the saved command).
    schedules.js            Scheduled tasks (ops roadmap Phase 4): GET / (the
                            list + the snippet/service options its dropdowns
                            need + which gates are on), PUT / (save the list),
                            POST /:id/run (Run now). Editing needs only a
                            session; scheduler.js gates each run at fire time.
    widgets.js              Board-view widget CRUD (creative roadmap Phase 3):
                            POST / PUT /:id / DELETE /:id + PUT /reorder over
                            config.widgets, saveConfig broadcasts it, plus
                            GET /:id/value (a 'fetch' widget's rendered value —
                            the server does the HTTP GET, errors come back 200
                            for the tile to show). Normal session — a widget
                            renders in the browser, nothing runs on the host.
    jellyfin.js             Jellyfin (creative roadmap Phase 4): GET /status
                            (the Settings test), GET /now-playing (the widget's
                            poll — 200 with a flag/message on failure), POST
                            /command (transport, activity-logged), GET
                            /image/:id (poster proxy, keeps the key server-side).
    docker.js               GET /containers — backs the container picker in
                            the Add/Edit Service modal and the Board's
                            'docker' widget; GET /containers/:name/logs
                            (read-only) and POST /containers/:name/:action
                            (start/stop/restart — Service-Control-gated) for
                            that widget's controls
    settings.js            Health-check + shared-folder + alerts + Ollama
                            + Code + ComfyUI + Jellyfin + IP allowlist + service-control
                            settings, plus /test-alert
    ollama.js               GET /models (installed-model list for the
                            Settings dropdown), GET /status (on? reachable?
                            model resident?), POST /active (the Chat-view
                            toggle — persists + preloads/evicts), POST /test
                            (one round-trip through the saved config). All
                            proxied from the saved Ollama URL; 502 if it's
                            unreachable.
    code.js                 The Code tab — session CRUD (GET /sessions also
                            returns the `running` id list), message list/post,
                            /stop, /approval/:id (Confirm or Reject a held
                            write), /answer/:qid (answer an ask_user question),
                            /save-plan (append a plan-mode reply to the memory
                            file), read-only workspace list/file,
                            /workspace/files (flat path list for the composer's
                            `@` picker — Code parity 3a), /commands (the
                            built-in + .mc/commands/*.md list for the `/`
                            picker — Code parity 3b),
                            /workspace-info (resolved path + both prompt docs'
                            state), POST /workspace/context-file (create the
                            source-of-truth file from a template),
                            /workspace/download-zip (the workspace as a .zip
                            via zip.js, minus node_modules/.git), and
                            /model-info?model= (a model's context_length and
                            its `vision` / `tools` capabilities, via
                            ollama.js#showModel), /workspace/raw?path=
                            (raw bytes of a workspace image, for the <img> on a
                            generate_image step — images only, nosniff), GET
                            /tools (the switchable tool list + the seeded
                            never-run command patterns, for Settings),
                            GET /sessions/:id/background (the running-processes
                            strip) and POST /background/:bgId/stop (Code parity
                            roadmap 2a), and POST /sessions/:id/revert/:messageId
                            (roll a turn's file changes back — only the most
                            recent un-reverted turn, 409 otherwise; Code parity
                            roadmap 2c).
                            POST /messages also takes
                            `attachments: [{name,content}]` (codeAttach.js),
                            `mentions: [path]` (codeMentions.js — read
                            server-side) and `images: [{name,dataUrl}]`
                            (codeImages.js — described by the vision model in
                            runTurn, and saved for the transcript; Code parity
                            4a/4b, served by GET /sessions/:id/image/:file);
                            a `text` of `/name args` is expanded via
                            codeCommands.js (400 if there's no such command).
                            Posting the first message
                            auto-titles a "New session" from its text. Every
                            route refused unless config.code.enabled AND
                            config.auth.enabled (same gate as service control).
                            Model list reuses GET /api/ollama/models.
    comfy.js               GET /status (reachable? GPU? VRAM? queue depth),
                            GET /checkpoints (the model dropdown), POST /detect
                            (paste a workflow → auto-detected node mapping).
                            All read whatever ComfyUI URL is saved; 502 if it's
                            unreachable. Generation itself runs through the
                            Code agent's generate_image tool, not a route.
    art.js                 Generated-image routes (creative roadmap Phase 1).
                            /wallpapers (GET/POST/DELETE + /:id/image),
                            POST /avatar (→ profiles.js image path),
                            /service-icon/:id (POST/GET/DELETE; POST sets the
                            service's iconImage + broadcasts config). Every POST
                            is a long synchronous call — one at a time across all
                            three (409 otherwise) — with sampler progress over
                            the socket as 'art:progress'. Image GETs are
                            nosniff + hard-cached. Behind the normal password
                            gate; needs config.comfy.enabled to do anything.
    files.js               Shared-folder browser: list/download/upload
                            (disk-streamed)/mkdir/delete/move (rename is
                            move-in-place)/recent/search — the last two
                            delegate to server/fileShare.js so the assistant
                            can reuse them
    chat.js                 Channel CRUD (via config.js) incl. PUT /:id
                            (rename + per-channel assistant persona),
                            message list/post(multipart)/delete, attachment
                            serving. A posted message is broadcast as
                            normal; the Ollama assistant (ollamaChat.js)
                            reacts to the broadcast separately if it carries
                            the trigger.
    profile.js               Per-device profile (profiles.js). GET / (mine,
                            by X-Mc-Device header), GET /all (everyone, for
                            message avatars), PUT / (name + sprite), POST
                            /avatar (multipart image, ≤4 MB), DELETE /avatar
                            (→ sprite), GET /avatar/:file (serves the image —
                            no header needed, it's an <img> src).
    devices.js               GET the tracked list, DELETE to clear history
    activity.js              GET / — the Activity view's data (ops roadmap
                              Phase 1): newest-first over readRecentActivity,
                              ?category=&hours=&search=&before=&limit=, normal
                              session (the log carries IPs + every action)
    discovery.js              GET scan state, POST to start a scan, DELETE
                               to cancel
    configTransfer.js          GET /export (download config.json), POST
                                /import (wholesale replace), auto-backup to
                                data/backups/ before every import
    auth.js                    POST /login, /logout, /password,
                                /session-length, /disable; GET /status
public/
  login.html, js/login.js     Standalone sign-in page — the only page
                               reachable with no session once a password
                               is set
  index.html, css/style.css   Markup + the full theme token system
  manifest.webmanifest, service-worker.js, icons/   PWA installability
  js/
    api.js                 Fetch wrapper for the REST API — also attaches
                            the CSRF header and redirects to /login.html
                            on a 401
    ws.js                   WebSocket client: connects, reconnects with
                            backoff, dispatches typed messages
    core.js                 Shared state, DOM/formatting helpers, the
                            WebSocket/poll sync engine, and drag-reorder —
                            imported by every module below; never imports
                            from one itself (see its own top comment for
                            why, and how `callbacks` avoids circular imports)
    dashboard.js             Cards/List/Graph views, the Add/Edit Service
                              modal (incl. the connections pill-toggle
                              checklist), start/stop/restart/logs controls,
                              network discovery
    files.js                 Shared-folder browser: List/Thumbnail/Tree,
                              rename/move, whole-share search, upload,
                              media preview, Recently Added
    chat.js                  Channels, messages (incl. the assistant's
                              live-streaming bubble), attachments, layout
                              modes + channel-column collapse, the Ollama
                              assistant on/off toggle + its status poll
    code.js                  The Code tab — session list (with per-session
                              working-spinner / finished-while-away dot, fed by
                              the codeTurn WS event), streamed transcript with
                              collapsible agent tool-call steps + coloured
                              diffs + Confirm/Reject approval cards, per-session
                              model + approval pickers, Stop, and the read-only
                              workspace tree (expand/collapse, auto-refreshes
                              after the agent writes, ⬇ zip download) +
                              line-numbered syntax-highlighted file viewer that
                              a `path:line` link (linkifyPaths, Code parity 3a)
                              opens at the flagged line. Also the header
                              context meter (chars/4
                              estimate vs. contextTokens, plus both prompt
                              docs' sizes, cached per model via /model-info),
                              the "source" / "memory" tree markers + the
                              source-of-truth file's "create one" prompt, the
                              animated code-model avatar (idle/thinking/error
                              SVG), the per-session composer placeholder, the
                              empty-session starter chips, message attachments
                              (📎 / drag / paste → staged chips, read
                              client-side, sent inline), image attachments
                              (Code parity 4b — 📷 / paste / drag → data-URL
                              chip with a thumbnail; rendered inline in the
                              transcript, the vision model's `👁` step alongside),
                              `@file` mentions
                              (Code parity 3a — `@` opens a fuzzy workspace-file
                              picker; the pick is a chip, read server-side;
                              clickable in the transcript), `/commands`
                              (Code parity 3b — `/` opens a picker of the
                              built-ins + .mc/commands/*.md; the transcript
                              shows a `⌘ /name` badge), the agent task
                              panel (Code parity roadmap 1a — the update_tasks
                              list, collapsible, live via code:sessions), and
                              the running-processes strip above the composer
                              (Code parity roadmap 2a — background commands,
                              per-row Stop, refetched on the code:background WS
                              event + a 4s poll while one is running), and the
                              per-turn "↩ Revert this turn" button on the newest
                              checkpointed message (Code parity roadmap 2c — ⚠
                              when the turn ran commands; leaves a muted
                              "Reverted" note, re-reads the tree after)
    markdown.js               ~110-line Markdown->HTML renderer (no
                              dependency) for assistant replies — escapes
                              first, safe-hrefs only; fenced code runs
                              through highlight.js
    highlight.js              ~150-line regex syntax highlighter (no
                              dependency) — js/json/py/sh/css/html/yaml/md
                              + a generic fallback. Used by markdown.js
                              (code fences) and code.js (file viewer).
                              Escapes token-by-token.
    avatar.js                 Profile avatars — spriteSvg(seed) (a seeded
                              identicon) + avatarMarkup(profile, fallbackName)
                              (uploaded image / chosen sprite / name-seeded
                              sprite). Used by settings.js, chat.js, code.js.
    settings.js              The Settings modal (theme, groups, devices,
                              Ollama, Code, security, backup) + the
                              standalone Host Health modal
    omnibox.js                The "/" quick-launch command palette
    kiosk.js                 Kiosk mode (ops roadmap Phase 2c) — ?kiosk=1 /
                              the board's ⛶ button; forces the chrome-free
                              full-screen board, the big clock, the idle
                              auto-dim, and the Esc / ✕ / ?kiosk=0 exits.
                              Remembered per-device in localStorage.
    app.js                  Entry point: boots the modules above, wires
                            core.js's sync-engine callbacks to their real
                            render functions, owns the top nav view switch
    connections.js           SVG line-drawing + hover-highlight for the connections view
scripts/
  install-autostart.bat, uninstall-autostart.bat   Register/remove the
                            Windows Task Scheduler auto-start task
  autostart-run.vbs, autostart-run.bat   The hidden, headless launcher the
                            scheduled task actually runs
  install-autostart.sh, uninstall-autostart.sh   Register/remove the
                            Ubuntu/Linux systemd --user auto-start unit
  mission-control.service.template   Filled in by install-autostart.sh
                            with this machine's node path and working dir
```

No build step, no framework — vanilla ES modules on the frontend, Express
on the backend, plain JSON on disk.

## License

[MIT](LICENSE)
