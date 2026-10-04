# Doombar

Electron kiosk dashboard for a 2560x666 touch strip on Windows. Spec: `ultrawide.md`. Deviations and feature notes: README "Notes and deviations".

## Working here (Windows)
- `npm start` runs it live (from a VS Code terminal, unset `ELECTRON_RUN_AS_NODE` first or Electron starts as plain Node); it finds the 2560x666 display and goes kiosk there. `DOOMBAR_KIOSK=0` keeps it windowed.
- `npm run deploy` builds `dist/win-unpacked/`, stops the running app, mirrors it to `%LOCALAPPDATA%\Programs\Doombar` (login item and Start menu shortcut point there) and starts it; `-- --no-build` skips the build.
- Installed launches run under `main/watchdog.js` (Node mode of the same exe): it restarts the dashboard on crash, kill, or hung main, but not on exit code 0 or during Windows shutdown/logoff. `taskkill /IM Doombar.exe /T /F` stops both; `DOOMBAR_WATCHDOG=0` runs unsupervised. Log: `logs\watchdog.log`.
- Logs: `%APPDATA%\doombar\logs\main.log`. Renderer console warnings/errors are forwarded there (no DevTools in kiosk). Hand-edited config: `%APPDATA%\doombar\config.json`, hot-reloaded.
- `DOOMBAR_SCREENSHOT=path.png` captures after 6 s and quits; `DOOMBAR_SCREENSHOT_JS` runs a snippet in the renderer first.
- `npm run setup` is `electron . --setup` so it shares the app's userData (safeStorage key); in a checkout add `DOOMBAR_CONFIG=%APPDATA%\doombar\config.json` to change the installed app's config instead of the repo's.
- Mail/calendar accounts: several Google and Microsoft 365 accounts in `config.accounts`, merged in the Email and Calendar panels (README "Mail and calendar accounts"). Per-provider code in `services/sources/`; `services/accounts.js` resolves accounts and clients; `main/account-setup.js` does sign-in for the setup window and the `--setup --add-microsoft|--add-google|--accounts` flags.
- Audio backends: `powershell` (default, `scripts/win-audio.ps1` as a JSON-lines child), `koffi` (opt-in, vtable COM, untested), `mock` (fake data for renderer work). Device switch, peak meter, now-playing exist on powershell/mock only.
- `doomgen/` is a separate npm project (ESM): the ACE-Step music server + Studio + `ace` CLI (spec `doomgen.md`, notes `doomgen/README.md`). Doombar's ACE panel talks to it only over HTTP/WS (`ace.url`). Its tests: `npm test` inside `doomgen/`.
- Tests: `npm test` (node:test). Keep them free of Electron requires; `main/layout.js` is split out for that reason.

## Design rules
- Touch-first, no hover, 56 px targets. No irreversible one-tap actions (e.g. no process kill).
- Theme follows the OS (`display.theme`), everything through CSS variables in `renderer/styles.css`.
- Long-press a header unlocks layout editing; saved layouts go through `config` `setLayout` and `main/layout.js` validation.
