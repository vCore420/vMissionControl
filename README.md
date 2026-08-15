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

The server binds `0.0.0.0`, so it's reachable both at `http://localhost:5000`
and at your machine's LAN address (printed on startup, e.g.
`http://192.168.1.23:5000`) — open that from your phone or another computer
on the same network.

For auto-restart on file changes during development:

```bash
npm run dev
```

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

The service worker only caches the static app shell (HTML/CSS/JS/icons) for
fast, resilient loading — it deliberately never caches `/api/*`, since this
app only exists to show *live* status and serving stale health data back
from a cache would be actively misleading. If you add a new stylesheet or
script to `index.html`, add it to `SHELL_URLS` in
[service-worker.js](public/service-worker.js) and bump `CACHE_NAME`, or the
installed app will keep serving the old version until the cache expires on
its own.

## What it does

- **Dashboard** — a card per entry: icon (or auto-fetched favicon), URL,
  live status dot, latency, group badge, tags, and an uptime sparkline.
  **Enter** jumps to it; the ✎ in the corner edits it.
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
- **Connections** — link related services (e.g. Open WebUI → Ollama). Hover
  a card to highlight its connections; click **Connections** in the top bar
  to draw lines between every connected pair.
- **Health checks + uptime history** — the backend pings each monitored
  entry's URL on an interval (default 15s, configurable in Settings),
  caches the result, and keeps a rolling history (6h / 2000 samples, in
  memory only) that renders as the sparkline strip and uptime % on each
  card. The frontend polls the cheap `/api/status` endpoint every 5s as a
  fallback, but normally hears about a change immediately over the
  real-time connection below.
- **Real-time sync across every connected device** — a WebSocket pushes
  status changes, edits, pins, reorders, and chat messages to every open
  dashboard the instant they happen, so pinning a service on your phone
  shows up on your desktop right away instead of within-5-seconds. The 5s
  REST poll stays as a fallback for a socket that never connects (a
  restrictive proxy) or is mid-reconnect.
- **Chat** — multiple named channels for talking between whatever devices
  currently have the dashboard open: text, links (auto-linkified), and an
  optional image or file attachment per message, all arriving live. Each
  device picks its own display name (Settings-free — click "You: Name ✎"
  in the chat header), stored per-browser, no account system. Message
  history is in-memory only per channel (last 200, same ephemeral choice
  as the health-status cache) and attachments live on disk under
  `server/data/chat-uploads/` (gitignored) — deleting a message or letting
  it age out of the 200-cap deletes its file too. Deliberately not a
  replacement for the shared folder below, which is what actually owns
  moving files that aren't part of a conversation.
- **Status-change notifications** — an in-page toast fires on every
  online↔offline transition. Turn on "Notify me..." in Settings for
  desktop notifications too — these need browser permission and only work
  when opened at `localhost` (browsers block them on a plain-HTTP LAN
  address).
- **Quick actions** — 📋 copies a card's URL to the clipboard; ⟳ forces an
  immediate recheck of just that entry instead of waiting for the next
  scheduled sweep.
- **File share** — point Settings → Shared folder at any directory on this
  host and browse/upload/download it from any device that can reach this
  app. Uploads and deletes are each toggleable independently.
- **Themes** — Dark, Light, Cyberpunk, Pride, Cute, Cozy, and Her, picked
  from a swatch grid in Settings → Appearance. Every color in the app is a
  CSS custom property, so a theme is just a full re-declaration of that
  token set — status colors (online/offline/unmonitored/checking) are
  re-tuned per theme but always keep their green/red/gray/amber meaning.
  Saved per-browser (`localStorage`), applied before first paint so there's
  no flash of the wrong palette on reload.

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

This app currently has **no authentication** — that was a deliberate
tradeoff for a trusted home LAN, but it means anyone who can reach the
server's port can view every service's status and, if enabled, browse,
upload to, or delete from the shared folder. The WebSocket (real-time sync
and chat) sits behind the same trust boundary — same tradeoff, no new
exposure, but worth knowing it means anyone on your LAN can read every
chat channel, post messages under any display name they like (there's no
verification, just a name someone typed into their own browser), and
upload attachments up to 15MB each. Don't port-forward this to the public
internet as-is, and keep `allowDelete` off unless you want any device on
your network to be able to remove files.

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
  events.js                 The shared EventEmitter those two emit on —
                             the only thing ws.js listens to
  ws.js                     WebSocket server: broadcasts status/config/
                            chat events to every connected device
  data/
    config.example.json     Committed template — the source of truth for
                             what a fresh install looks like
    config.json              Gitignored — your actual live config
    chat-uploads/             Gitignored — chat attachment files
  routes/
    services.js, groups.js, connections.js   CRUD over config.json
    settings.js            Health-check + shared-folder settings
    files.js               Shared-folder browser (list/download/upload/mkdir/delete)
    chat.js                 Channel CRUD (via config.js), message
                            list/post(multipart)/delete, attachment serving
public/
  index.html, css/style.css   Markup + the full theme token system
  manifest.webmanifest, service-worker.js, icons/   PWA installability
  js/
    api.js                 Fetch wrapper for the REST API
    ws.js                   WebSocket client: connects, reconnects with
                            backoff, dispatches typed messages
    app.js                  All UI state, rendering, and event wiring
    connections.js           SVG line-drawing + hover-highlight for the connections view
```

No build step, no framework — vanilla ES modules on the frontend, Express
on the backend, plain JSON on disk.

## License

[MIT](LICENSE)
