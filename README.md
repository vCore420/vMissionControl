# Mission Control

A LAN dashboard for services running on your own machine — Jellyfin, Ollama,
Open WebUI, ComfyUI, Tailscale, local game dev servers, whatever you've got
listening on `127.0.0.1` / `0.0.0.0` — and just as easily a homepage for
ordinary websites (GitHub, Gmail, whatever you open daily). One card grid
with live health status, groups, pinned favorites, visual connections
between related services, real-time sync and chat between every connected
device, and a shared-folder file browser reachable from any device on your
network.

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
network request genuinely fails. (An earlier stale-while-revalidate
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
  tab to reorder it, ✕ to delete one (disabled once you're down to your
  last channel). Each device picks its own display name (Settings-free —
  click "You: Name ✎" in the chat header), stored per-browser, no account
  system. Message
  history is in-memory only per channel (last 200, same ephemeral choice
  as the health-status cache) and attachments live on disk under
  `server/data/chat-uploads/` (gitignored) — deleting a message or letting
  it age out of the 200-cap deletes its file too. Deliberately not a
  replacement for the shared folder below, which is what actually owns
  moving files that aren't part of a conversation.
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
    lines drawn between related ones, click a node to open it.
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
    buttons with no surrounding bar. Sidebar/Floating collapse back to a
    horizontal scrollable strip above the conversation on phone-width
    screens, the same graceful-degrade real chat apps use.

  Every one of these is saved to that browser's own `localStorage` — it's
  a per-device display preference, not part of `config.json`, so switching
  to Graph view on your desktop doesn't change what your phone sees.
- **Tabbed Settings** — Appearance, Services (groups + health-check
  interval), Notifications (in-page/desktop + external alerts), Sharing,
  Security (password protection + IP allowlist), Devices, and Backup each
  get their own tab instead of one long scrolling page. Which tab you were
  last on is remembered per-device (`localStorage`), same as the view
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
  dot catches up once the process has actually changed state.

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
  client). Passwords are hashed with `scrypt` — Node's own built-in, no
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
  file change, every discovery scan, and every auth event (sign-ins,
  failures, rate-limit hits, password changes) gets one line — printed to
  the server console as it happens and appended to a dated file under
  `server/data/logs/` (gitignored), pruned after 30 days. Each line names
  what happened and, where there's an acting device, its IP — e.g.
  `[2026-08-16T08:36:10Z] [service] Created "Jellyfin" (100.98.221.75)`.
  No frontend viewer for this (yet) — it's `tail`/`grep`-able text, not a
  UI feature.

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
- `services[].healthCheck` — set `false` to show a card without polling it
  (useful for services with no stable local HTTP port, like Tailscale, or
  for a public website bookmark you don't need uptime tracking for).
- `services[].healthCheckPath` — appended to the service URL for the ping
  (e.g. Jellyfin's `/health`).
- `services[].icon` — an emoji, or leave it `""` to render the site's
  favicon instead.
- `sharedFolder.path` — relative paths resolve against the project root; use
  an absolute path to point anywhere else on the host.
- `chatChannels` — `{id, name}` pairs; edited through the ＋ / ✕ controls in
  the Chat tab, not usually by hand. An install from before chat existed
  gets a default `General` channel written in automatically the first time
  the server starts.

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

**Service Control is the opposite — it *requires* the password gate.**
Every other feature in this app works the same whether or not auth is on;
Service Control is the one exception, refusing to even be turned on in
Settings until a password is set, because it's the one feature that runs
commands on the host rather than just reading/writing config. Commands
themselves are ones you write yourself (in each service's Edit screen),
not something a request can supply — so the risk it's guarding against
isn't injection, it's an unauthorized party on the network triggering a
command you already wrote.

**The IP allowlist and the activity log are both independent of the
password gate above** — the allowlist is a network-layer restriction
(reduces who can even reach the app), the log is a record of what
happened (helps you notice if something did), and neither requires a
password to be set. Worth knowing: the allowlist trusts whatever IP the
request arrives with, same as device tracking and the activity log's own
IP field — on a network with an untrustworthy DHCP server or where IP
spoofing is plausible, an IP is an identifier, not a proof of identity;
the password gate is what actually identifies who's asking. The activity
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
                            emits 'chat:message' / 'chat:messageDeleted'
  devices.js                In-memory device tracker (last 100 IPs): UA
                             parsing, request counts, live WS connection
                             count — no events, just read on request
  host.js                    Background CPU/memory/disk sampler (5s), also
                             just read on request, no events
  discovery.js                LAN subnet scanner: TCP-connect probes across
                               a curated port list + reverse DNS + arp -a for
                               MAC addresses, in-memory scan state
                               read/started/cancelled on request, no events
  wol.js                       Builds + sends a Wake-on-LAN magic packet
                                over UDP broadcast, no events
  serviceControl.js             Runs a service's saved start/stop/restart
                                 shell command (child_process.exec, timeout +
                                 truncated output), no events
  docker.js                      Minimal Docker Engine API client (named
                                  pipe on Windows, no client library) —
                                  container start/stop/restart, list, logs
  tailscale.js                    Runs `tailscale status --json`, read-only —
                                  backs the tailscaleHealthCheck service flag
  alerts.js                     Server-side online/offline transition
                                 tracker + outbound webhook sender (Discord/
                                 Slack/generic), independent of the
                                 frontend's own toast/notification tracker
                                 so it still fires with no browser open
  events.js                 The shared EventEmitter those two emit on —
                             the only thing ws.js listens to
  net.js                     clientIp(req) — shared by index.js, ws.js, auth.js
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
                                route below
  ws.js                     WebSocket server: broadcasts status/config/
                            chat events to every connected device, and
                            records each connect/disconnect into devices.js
  data/
    config.example.json     Committed template — the source of truth for
                             what a fresh install looks like
    config.json              Gitignored — your actual live config
    chat-uploads/             Gitignored — chat attachment files
  routes/
    services.js, groups.js, connections.js   CRUD over config.json,
                            plus services' /:id/check, /:id/wake,
                            /:id/start /:id/stop /:id/restart (gated on
                            security.serviceControl.enabled + auth.enabled,
                            dispatches to serviceControl.js or docker.js by
                            controller.type), and /:id/logs (Docker only,
                            read-only, just needs a session)
    docker.js               GET /containers — backs the container picker
                            in the Add/Edit Service modal
    settings.js            Health-check + shared-folder + alerts + IP
                            allowlist + service-control settings, plus
                            /test-alert
    files.js               Shared-folder browser: list/download/upload
                            (disk-streamed)/mkdir/delete/move (rename is
                            move-in-place)/recent (in-memory upload list)/
                            search (recursive, capped)
    chat.js                 Channel CRUD (via config.js), message
                            list/post(multipart)/delete, attachment serving
    devices.js               GET the tracked list, DELETE to clear history
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
    chat.js                  Channels, messages, attachments, layout modes
    settings.js              The Settings modal (theme, groups, devices,
                              security, backup) + the standalone Host
                              Health modal
    omnibox.js                The "/" quick-launch command palette
    app.js                  Entry point: boots the modules above, wires
                            core.js's sync-engine callbacks to their real
                            render functions, owns the top nav view switch
    connections.js           SVG line-drawing + hover-highlight for the connections view
scripts/
  install-autostart.bat, uninstall-autostart.bat   Register/remove the
                            Windows Task Scheduler auto-start task
  autostart-run.vbs, autostart-run.bat   The hidden, headless launcher the
                            scheduled task actually runs
```

No build step, no framework — vanilla ES modules on the frontend, Express
on the backend, plain JSON on disk.

## License

[MIT](LICENSE)
