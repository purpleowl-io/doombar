# Ultrawide Dashboard — Requirements and Design Notes

Target: a full-screen Electron app that owns a 2560×666 secondary display on Alex's Windows workstation. It shows a small number of live panels (Slack, calendar, email, timers, audio, system stats) and is meant to be glanced at, not worked in. Section 7 records the decisions already made; Appendix A is the Slack app setup.

## 1. Purpose and constraints

- The display is a strip: 2560 wide, 666 tall, roughly 3.85:1. Layout is columns, not rows. Nothing should need vertical scrolling.
- Viewing distance is normal desk distance but the user is usually looking at another monitor. Type must be large, contrast high, and state changes visible in peripheral vision (a color shift or a badge, not a small icon).
- The app is the only thing on that display. Kiosk window, no frame, always on top, launched at login, relaunches if it dies.
- The display is a touchscreen. Primary interaction is touch; mouse works too but nothing should depend on hover. A few global hotkeys for the timer.
- Runs alongside dev tooling, ComfyUI, and local inference. It should stay under ~300 MB RAM and near-zero idle CPU. Polling intervals should be conservative and every integration should back off when the machine is busy or the network is down.
- Secrets (Slack tokens, Google refresh tokens, API keys) stay on the machine, encrypted with Electron's `safeStorage`. Nothing goes in plain JSON.

## 2. Architecture

Electron with a strict split:

- **Main process** hosts every integration as an independent service module. Each service has the same shape: `start()`, `stop()`, `getState()`, an event emitter for changes, and a list of actions it accepts (`markRead`, `setVolume`, etc.). Services never touch the DOM.
- **Renderer** is a single page with a panel grid. Panels subscribe to service state over IPC and send actions back. Framework is Alex's call; plain modules or Svelte both fit. Keep it JavaScript, no TypeScript build step unless wanted.
- **Preload bridge** exposes exactly `dashboard.subscribe(service, cb)` and `dashboard.action(service, name, payload)`. `contextIsolation` on, `nodeIntegration` off.
- **Windows sidecar** for the parts Node cannot reach cleanly (per-app audio sessions, media transport control). See section 4.5. This is a small C# console app spawned by main and talked to over stdin/stdout JSON lines. Keep it optional: the dashboard runs without it, with those two panels disabled.
- **Persistence**: one SQLite file via `better-sqlite3` for read-state, seen-IDs, timer presets, and config. Settings that Alex edits by hand live in a `config.json` next to it.

Reason for the service pattern: the list of panels will grow ("other things I think of"). Adding a panel should mean adding one service file and one panel file, nothing else.

### Window placement

Find the display by resolution (2560×666), fall back to the primary if it is not connected. Set bounds first, then enable kiosk. Re-check on `screen.on('display-added' | 'display-removed')` so the app moves to the right place when the monitor sleeps and wakes or is unplugged.

### Startup and recovery

- `app.setLoginItemSettings({ openAtLogin: true })`.
- Main process wraps every service start in try/catch and shows an error tile instead of crashing the whole window.
- A `process.on('uncaughtException')` handler logs and relaunches (`app.relaunch(); app.exit()`), with a rate limit so a broken config does not loop.

## 3. Layout

Six columns is a reasonable starting split at 2560 wide. Suggested order, left to right:

| Column | Width | Content |
|---|---|---|
| Slack | ~560 | Channel list with unread counts, newest message preview |
| Calendar | ~440 | Today and tomorrow, next event highlighted |
| Email | ~560 | Client/prospect inbox, AI summaries on demand |
| Timers | ~360 | Running timers, presets |
| Audio | ~360 | Master volume, per-app sliders, transport |
| System | ~280 | CPU, RAM, GPU, disk, network |

Each panel has a header with a status dot (connected / stale / error) and a "last updated" timestamp. Stale means the service has not reported in longer than 3× its poll interval.

Column widths should be adjustable in `config.json` without touching code. A panel can be hidden by removing it from the layout array.

### Touch rules

- Minimum tap target 56×56 px; rows in lists at least 64 px tall. At 666 px that means roughly 8 rows per panel, which is the right density anyway.
- No hover-only affordances. Anything revealed on hover (action buttons, timestamps) is either always visible or revealed by a tap on the row.
- Sliders (volume) get a tall track and a large thumb; dragging anywhere on the track moves it.
- Swipe gestures on list rows for the one obvious action per panel: swipe a Slack channel or email row to mark read. Use pointer events, not a gesture library; a 40 px horizontal move with less than 15 px vertical is enough.
- Text entry (timer free-form, later search) uses preset chips rather than the Windows touch keyboard, which behaves unpredictably over a kiosk window on a secondary display. Timers are built from +5 / +10 / +60 / − chips, not a numpad. Build the small inputs the dashboard actually needs and leave the OS keyboard alone.
- A tap on the blanked screen wakes it; a second tap should not fire whatever was under the finger. Swallow the first pointer event after waking.
- Confirmations (delete timer) are a second tap on the same button that changes label to "Confirm", with a 3 s timeout, not a modal dialog.
- Chromium handles touch natively; no special Electron flags are needed. Set `touch-action: manipulation` on the body to remove the 300 ms tap delay and disable pinch zoom.

## 4. Panel requirements

### 4.1 Slack

Purpose: know at a glance whether any channel Alex cares about has something new, read the newest message without switching windows, and clear it.

Requirements:

- Watch a configured list of channels and DMs (by name or ID). Ignore everything else.
- Show per-channel unread count and the most recent message: author, time, text (Markdown/mrkdwn rendered to plain text with @mentions resolved to names).
- Highlight channels where Alex is @mentioned.
- Actions: mark channel read, open the channel in the Slack desktop app (`slack://channel?team=…&id=…`), expand to show the last 5 messages.
- Live updates, not polling. Use Socket Mode so no public URL or tunnel is needed.

Implementation notes:

- Single workspace. One Slack app, created from the manifest in Appendix A.
- `@slack/bolt` with Socket Mode. Needs an app-level token (`xapp-…`) for the socket plus a **user token** (`xoxp-…`) for API calls. The user token is what lets the app read Alex's unread state and mark channels read as him; `conversations.mark` sets the read cursor. Do not use the bot token for anything except the health check.
- Unread counts come from `conversations.info` with `unread_count_display`, which is the user's perspective when called with the user token.
- On start, seed each watched channel with `conversations.history` (limit 5) so the panel is populated before the first event arrives.
- Cache user ID → display name in SQLite; refresh daily.
- Watch for `message` events plus `message_changed` and `message_deleted` subtypes so the preview does not go stale.

### 4.2 Calendar

Purpose: see what is next and how long until it.

Requirements:

- Show today's remaining events and tomorrow's, in local time (America/Phoenix, which does not observe DST — do not let a library assume it does).
- The next event is visually dominant, with a countdown ("in 23 min"). At T-5 min the panel changes color.
- Show attendees count and the meeting link if there is one; clicking the link opens it in the default browser.
- Multiple calendars merged, with a per-calendar color from config.
- Actions: open event in browser, join meeting, snooze the alert.

Implementation notes:

- Google Calendar API v3 via `googleapis`, OAuth desktop flow with a loopback redirect. Store the refresh token with `safeStorage`.
- Poll every 2 minutes; use `syncToken` for incremental fetches so the request is cheap. Full resync once an hour.
- If Outlook calendars are in the mix later, the service interface stays the same and a second provider is added behind it.

### 4.3 Email

Purpose: surface mail from people who matter (current clients and prospects) and nothing else, with a short summary when the message is long.

Requirements:

- Filter by sender against a maintained list of client and prospect domains and addresses in `config.json`. Alex supplies the initial list of client labels (for example `acme`, `globex`). Match on the domain part of the sender address, case-insensitive, subdomains included. Later this can be fed from the CRM.
- Show sender, subject, time, first line, and an attachment indicator. Unread ones are emphasized.
- Actions: mark read, archive, open in Gmail (web link), generate summary.
- Summary is on demand, not automatic. Automatic summaries for every message cost more than they are worth and clutter the panel. Exception: messages over a configurable length from prospects can be summarized automatically because those are the ones that need a fast, informed reply.
- Summary output: two or three sentences — what they want, any deadline, what they are asking Alex to do. Show it inline under the message.

Implementation notes:

- Gmail API with `users.history.list` against a stored `historyId` so polling is incremental. Poll every 60 seconds. `users.watch` with Pub/Sub is the push alternative but needs a GCP project with Pub/Sub enabled; polling is fine for one inbox.
- Query filter at the API level: `from:(a.com OR b.com OR …) newer_than:7d` keeps the response small.
- Summaries use the Claude API (no local model). Use the `@anthropic-ai/sdk` package with the current Haiku-class model for cost; it is more than enough for three sentences. Key lives in `safeStorage`. Check the SDK docs for the current model string rather than hardcoding one from memory.
- Strip quoted replies and signatures before summarizing. Cap input at a few thousand tokens. Cache summaries by message ID so a message is never summarized twice.
- Email bodies never get logged.

### 4.4 Timers

Purpose: start a countdown in one click without leaving the current window.

Requirements:

- Preset buttons (e.g. 5, 15, 25, 50 min) defined in config, plus an in-panel numeric pad for arbitrary durations (tap digits, tap "min" or "hr", tap start). No text field.
- Multiple concurrent timers, each with a label.
- Large remaining-time display. At zero: the timer tile flashes, a sound plays through the default output, and a Windows toast fires (`new Notification()` from main works once the app has an AppUserModelID set).
- Actions: pause, add 5 min, dismiss.
- Optional global hotkey to start the default preset (`globalShortcut`, e.g. `Ctrl+Alt+T`).
- Timers survive an app restart (persist end timestamps in SQLite, not remaining seconds).

### 4.5 Audio

Purpose: see and set the master volume and control playback the way the keyboard media keys do.

v1 requirements:

- Master volume slider and mute, reflecting changes made elsewhere (keyboard, tray) within a second.
- Play/pause, next, previous buttons.
- Output device name shown (read-only in v1).

v1 implementation:

- `koffi` (maintained N-API FFI, no node-gyp) calling Win32 directly.
  - Transport: `user32.SendInput` with `VK_MEDIA_PLAY_PAUSE` (0xB3), `VK_MEDIA_NEXT_TRACK` (0xB0), `VK_MEDIA_PREV_TRACK` (0xB1). This is exactly what the keyboard does, so every app that responds to the keyboard responds to this.
  - Volume: `VK_VOLUME_UP` / `VK_VOLUME_DOWN` / `VK_VOLUME_MUTE` through the same path is the zero-COM option, but it steps in 2% increments and cannot read the current level. Reading and setting an absolute level needs `IAudioEndpointVolume`. Through koffi that is a COM vtable call chain (`CoCreateInstance` → `IMMDeviceEnumerator::GetDefaultAudioEndpoint` → `IMMDevice::Activate` → `GetMasterVolumeLevelScalar`). It is about 60 lines and worth doing once; if it fights back, fall back to a PowerShell one-liner using the same COM interfaces via `Add-Type`, spawned on demand.
- Poll the master level every second for the slider; no event subscription in v1.

Shipped through the PowerShell helper rather than a sidecar: output-device switching (`IPolicyConfig::SetDefaultEndpoint`), a peak meter (`IAudioMeterInformation`), now-playing metadata (`GlobalSystemMediaTransportControlsSessionManager` via WinRT projection), and a spectrum drawn in the renderer from a `getDisplayMedia` loopback capture. Still deferred to v2: per-app session volumes (`IAudioSessionManager2`). That one is cleaner from a small C# sidecar (`NAudio` + `Windows.Media.Control`) talking JSON lines over stdin/stdout. The service interface should be designed so the sidecar slots in behind it without changing the panel.

### 4.6 System

Purpose: notice when something is eating the machine.

Requirements:

- CPU total and per-core sparkline over the last 60 seconds.
- RAM used / total.
- GPU utilization, VRAM used, temperature (the 5090 matters when inference or ComfyUI is running).
- Disk free on the main drives.
- Network up/down rate.
- Top 3 processes by CPU, read-only, with a button to open Task Manager. (No kill: a mis-tap on a touch strip is too costly.)

Implementation notes:

- `systeminformation` package for CPU, RAM, disk, network, processes. Poll every 2 seconds for CPU/RAM, every 30 seconds for disk.
- GPU via `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader` spawned on the same 2-second cadence. `systeminformation`'s GPU support is inconsistent on newer cards; the CLI is reliable.
- Thresholds in config drive color: e.g. RAM > 85% turns amber, GPU > 80 °C turns red.

## 5. Cross-cutting

**Configuration**: `config.json` with layout, Slack channel list, calendar IDs and colors, email sender list, timer presets, thresholds, poll intervals. Watched with `fs.watch` so edits apply without restart where the service supports it.

**Auth setup**: a one-time `npm run setup` script walks through Slack token entry and Google OAuth in the terminal and writes encrypted tokens. The dashboard itself never shows an auth UI beyond a "not connected — run setup" tile.

**Logging**: `electron-log` to a rotating file. Log service state transitions and errors. Never log message bodies, email contents, or tokens.

**Theme**: follows the Windows light/dark app mode (`config.display.theme`: `system` | `dark` | `light`), one accent color, large sans-serif. CSS variables for everything; the light palette is a `prefers-color-scheme` block. Panels are visually quiet until something needs attention.

**Display schedule**: two modes, driven by `config.json` business hours (default Mon–Fri 08:00–18:00 America/Phoenix).

- Inside business hours the app keeps the display awake and blanks the panel to black after 30 minutes of system idle (`powerMonitor.getSystemIdleTime()`, checked every 30 s). Any mouse, keyboard, or touch activity restores it immediately. Touch on the dashboard itself counts as system input on Windows, so no separate tracking is needed, but the renderer should also report its own pointer events to main in case the idle counter ever disagrees. Use `powerSaveBlocker.start('prevent-display-sleep')` only while unblanked so the OS is free to sleep the monitor once blanked.
- Outside business hours the app does nothing special: no power-save blocker, and the display follows Windows power settings. The app keeps running so it is current when the monitor wakes.
- Blanked is an app state, not a window change; services keep polling at a reduced rate (say 5×) so the first frame after wake is not stale.

**Testing**: each service can run standalone from the CLI (`node services/slack.js --dump`) printing its state as JSON. That makes integration debugging possible without launching the window.

**Packaging**: `electron-builder`, NSIS installer or just a portable build. Auto-update is unnecessary for a single machine.

## 6. Build order

1. Shell: kiosk window on the right display, panel grid, config loading, IPC bridge, relaunch-on-crash. One placeholder panel.
2. System panel (no auth, fast to verify the whole pipeline end to end).
3. Timers (local only, exercises persistence and notifications).
4. Calendar (first OAuth integration).
5. Email without summaries, then summaries via local llama.cpp, then Claude as an option.
6. Slack (most moving parts: Socket Mode, user token scopes, event subtypes).
7. Audio sidecar.

Each step should end with the app being usable, not just the code existing.

## 7. Decisions

| Question | Decision |
|---|---|
| Slack workspaces | One: the company workspace |
| Slack app with user token | Yes. Appendix A has the manifest and steps |
| Google account | Company Google Workspace account, one OAuth client |
| Client/prospect list | Hand-maintained in `config.json`; Alex supplies the domains |
| Email summaries | Claude API only, no local model |
| Audio v1 | Master volume plus transport; per-app and now-playing deferred |
| Extra panels | None yet; layout leaves the width configurable |
| Display schedule | Business hours: blank after 30 min idle, wake on input. Off hours: follow Windows power settings |
| Input | Touchscreen; see touch rules in section 3 |

Still open: the exact domains for the email filter, and whether the Google Workspace admin console needs the OAuth client added as trusted (it will if the Workspace has third-party app access restricted).

## Appendix A — Slack app setup

Slack lets an app be created from a manifest, which makes this mostly copy-paste. There is one manual step (creating the app and installing it) because Slack requires a browser click for OAuth consent. The rest can be scripted.

### A.1 Manifest

Save as `slack-manifest.json`:

```json
{
  "display_information": {
    "name": "Doombar",
    "description": "Desk dashboard on an ultrawide touch strip",
    "background_color": "#2b1d3a"
  },
  "features": {
    "bot_user": {
      "display_name": "Doombar",
      "always_online": false
    }
  },
  "oauth_config": {
    "scopes": {
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "users.profile:read"
      ],
      "bot": [
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "user_events": [
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim"
      ]
    },
    "socket_mode_enabled": true,
    "org_deploy_enabled": false,
    "token_rotation_enabled": false
  }
}
```

Notes on the scopes:

- `*:history` on the user side is what makes `conversations.mark` work and what delivers message events from Alex's perspective (including private channels and DMs he is in).
- `users:read` and `users.profile:read` resolve user IDs to display names.
- `token_rotation_enabled` is left off so the user token does not expire every 12 hours. Turning it on is more secure but means the setup script has to handle refresh; not worth it for a single-machine app.
- No `chat:write`. The dashboard does not post.

### A.2 Manual steps (about five minutes)

1. Go to `https://api.slack.com/apps`, click **Create New App**, choose **From a manifest**, pick your workspace, paste the JSON above, create.
2. On the app's **Basic Information** page, under **App-Level Tokens**, click **Generate Token and Scopes**. Name it `socket`, add scope `connections:write`, generate. Copy the `xapp-…` token.
3. Go to **Install App** in the sidebar, click **Install to Workspace**, approve. Slack shows two tokens: **User OAuth Token** (`xoxp-…`) and **Bot User OAuth Token** (`xoxb-…`). Copy both.
4. Run the setup script (A.3) and paste the three tokens when asked.

If the workspace has app approval turned on, step 3 will submit a request to a workspace admin instead of installing directly. Alex is the admin, so this should just be an extra click.

### A.3 Setup script

`scripts/setup-slack.js` — run with `node scripts/setup-slack.js` from the project root. It validates each token against the API before storing it, then writes them encrypted.

```js
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { WebClient } = require('@slack/web-api');
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  await app.whenReady();
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const appToken  = (await rl.question('App-level token (xapp-…): ')).trim();
  const userToken = (await rl.question('User OAuth token (xoxp-…): ')).trim();
  const botToken  = (await rl.question('Bot OAuth token (xoxb-…): ')).trim();
  rl.close();

  // Validate
  const user = await new WebClient(userToken).auth.test();
  if (!user.ok) throw new Error('User token rejected: ' + user.error);
  const bot = await new WebClient(botToken).auth.test();
  if (!bot.ok) throw new Error('Bot token rejected: ' + bot.error);
  if (!appToken.startsWith('xapp-')) throw new Error('App token should start with xapp-');

  console.log(`User token OK for ${user.user} in ${user.team}`);
  console.log(`Bot token OK (${bot.user})`);

  // Store encrypted
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
  const secretsPath = path.join(app.getPath('userData'), 'secrets.json');
  const existing = fs.existsSync(secretsPath)
    ? JSON.parse(fs.readFileSync(secretsPath, 'utf8'))
    : {};
  const enc = (s) => safeStorage.encryptString(s).toString('base64');
  existing.slack = {
    appToken: enc(appToken),
    userToken: enc(userToken),
    botToken: enc(botToken),
    teamId: user.team_id,
    userId: user.user_id,
  };
  fs.writeFileSync(secretsPath, JSON.stringify(existing, null, 2));
  console.log('Saved to', secretsPath);
  app.exit(0);
}

main().catch((e) => { console.error(e.message); app.exit(1); });
```

Run it via Electron, not plain Node, so `safeStorage` is available: add `"setup:slack": "electron scripts/setup-slack.js"` to `package.json` scripts.

### A.4 Fully scripted alternative

If Alex would rather not click through the app creation, Slack's `apps.manifest.create` endpoint does it, but it needs a **configuration token** from `https://api.slack.com/reference/manifests#config-tokens` (generated per user, 12-hour lifetime). With one in hand:

```js
const res = await fetch('https://slack.com/api/apps.manifest.create', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${configToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ manifest: require('../slack-manifest.json') }),
});
const { ok, app_id, error } = await res.json();
```

That creates the app, but installing it to the workspace still requires the OAuth consent click in a browser, so it saves one step out of four. Not worth wiring up unless the app needs recreating often.

### A.5 First-run check

Once tokens are stored, `node services/slack.js --dump` should print the watched channels with unread counts. If it prints `missing_scope`, the manifest scopes did not take; reinstall the app from the **Install App** page after fixing them. If `not_allowed_token_type`, a bot token is being used where the user token is needed.