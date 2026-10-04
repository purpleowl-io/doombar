'use strict';
// Main process entry. Order matters: env -> config -> db -> services -> window.
const path = require('node:path');
const fs = require('node:fs');
const { app, globalShortcut, Notification, session, desktopCapturer, nativeTheme } = require('electron');

const { projectRoot, ensureDataDir } = require('./paths');
require('./env').load(projectRoot);
require('./env').load(ensureDataDir());
const { scoped } = require('./log');
const { Config } = require('./config');
const { open: openDb } = require('./db');
const { createWindow, applyTheme } = require('./window');
const { ServiceHost } = require('./service-host');
const { DisplaySchedule } = require('./display-schedule');
const { sanitizeLayout } = require('./layout');
const { themePatch, themeInfo } = require('./themes');
const { sanitizeSettings } = require('./settings');

const log = scoped('main');
const APP_ID = 'io.purpleowl.doombar';
const SETUP = process.argv.includes('--setup');
// Set by main/watchdog.js on the dashboard it spawns; the watchdog owns restarts then.
const SUPERVISED = process.env.DOOMBAR_SUPERVISED === '1';

// --- crash handling: log, then relaunch, but never loop on a broken config ---
function relaunchWithRateLimit(reason) {
  if (SUPERVISED) {
    log.error(`exiting after crash, watchdog will restart: ${reason}`);
    app.exit(1);
    return;
  }
  const file = path.join(ensureDataDir(), 'relaunches.json');
  let stamps = [];
  try { stamps = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first time */ }
  const now = Date.now();
  stamps = stamps.filter((t) => now - t < 10 * 60 * 1000);
  stamps.push(now);
  fs.writeFileSync(file, JSON.stringify(stamps));
  if (stamps.length > 3) {
    log.error(`crashed again (${reason}); ${stamps.length} relaunches in 10 min, giving up`);
    app.exit(1);
    return;
  }
  log.error(`relaunching after crash: ${reason}`);
  app.relaunch();
  app.exit(1);
}

process.on('uncaughtException', (e) => {
  log.error('uncaughtException:', e && e.stack ? e.stack : e);
  relaunchWithRateLimit(e && e.message);
});
process.on('unhandledRejection', (e) => {
  log.warn('unhandledRejection:', e && e.stack ? e.stack : e);
});

// An installed, unsupervised launch (login item, shortcut) hands off to the
// watchdog and exits; the watchdog starts the real dashboard. Skipped for the
// portable build (its launcher deletes the extracted files once we exit), for
// screenshots, and with DOOMBAR_WATCHDOG=0.
function wantsWatchdog() {
  return app.isPackaged && !SUPERVISED && !SETUP
    && !process.env.PORTABLE_EXECUTABLE_DIR
    && !process.env.DOOMBAR_SCREENSHOT
    && process.env.DOOMBAR_WATCHDOG !== '0';
}

function startWatchdog() {
  const { spawn } = require('node:child_process');
  const script = path.join(__dirname, 'watchdog.js');
  const child = spawn(process.execPath, [script, process.execPath, ensureDataDir(), ...process.argv.slice(1)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  log.info(`handed off to watchdog pid ${child.pid}`);
}

// Supervised: prove main's event loop is alive, and tell the watchdog when
// Windows ends the session so it doesn't restart us into a shutdown.
function startHeartbeat() {
  const file = path.join(ensureDataDir(), 'heartbeat');
  const beat = () => { try { fs.writeFileSync(file, String(Date.now())); } catch { /* next time */ } };
  beat();
  setInterval(beat, 10 * 1000);
}

function markSessionEnd() {
  try { fs.writeFileSync(path.join(ensureDataDir(), 'session-end'), String(Date.now())); } catch { /* best effort */ }
  log.info('windows session ending');
}

if (wantsWatchdog()) {
  // Already running (supervised or not): nothing to hand off.
  if (app.requestSingleInstanceLock()) {
    app.releaseSingleInstanceLock();
    startWatchdog();
  }
  app.exit(0);
} else if (SETUP) {
  // Doombar.exe --setup [--from-env|--google|--status]: run auth setup instead of the dashboard.
  const flags = process.argv.slice(1).filter((a) => a !== '--setup' && a.startsWith('--'));
  require('../scripts/setup').run(flags).catch((e) => { console.error(e.message); app.exit(1); });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  if (SUPERVISED) startHeartbeat();
  app.whenReady().then(boot).catch((e) => {
    log.error('boot failed:', e.stack || e);
    app.exit(1);
  });
}

let win = null;

async function boot() {
  const config = new Config();
  config.watch();
  const db = openDb();

  if (process.platform === 'win32' && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  }

  const host = new ServiceHost({ getWindow: () => win });
  const notify = (title, body) => {
    if (!Notification.isSupported()) return;
    new Notification({ title, body, silent: false }).show();
  };
  const openExternal = ServiceHost.openExternal;

  const { SystemService } = require('../services/system');
  const { TimersService } = require('../services/timers');
  const { CalendarService } = require('../services/calendar');
  const { EmailService } = require('../services/email');
  const { SlackService } = require('../services/slack');
  const { AudioService } = require('../services/audio');
  const { AceService } = require('../services/ace');

  const ctors = {
    ace: AceService,
    system: SystemService,
    timers: TimersService,
    calendar: CalendarService,
    email: EmailService,
    slack: SlackService,
    audio: AudioService,
  };
  const enabled = new Set((config.get('layout') || []).map((l) => l.panel));
  if (config.get('ace') && enabled.has('audio')) enabled.add('ace'); // the ACE face of the audio panel
  for (const [name, Ctor] of Object.entries(ctors)) {
    if (!enabled.has(name)) continue;
    try {
      host.add(new Ctor({ config: config.get(), db, notify, openExternal }));
    } catch (e) {
      log.error(`could not construct ${name}:`, e.message);
    }
  }

  // Pseudo-services so the bridge stays at exactly subscribe/action.
  // theme rides alongside data (not inside it) so panels see plain config.
  const configState = () => ({
    service: 'config', status: 'connected', lastUpdated: Date.now(), data: config.get(),
    theme: themeInfo(config.get('display'), nativeTheme.shouldUseDarkColors),
  });
  // Windows app mode flipped: in auto the active theme changes with it.
  nativeTheme.on('updated', () => host.send('config', configState()));
  host.addVirtual('config', configState,
    (name, payload) => {
      if (name === 'setLayout') {
        const layout = sanitizeLayout(payload && payload.layout, config.get('layout'));
        if (!layout) return { error: 'bad layout' };
        config.save({ layout });
        log.info('layout saved:', layout.map((l) => `${l.panel}:${l.width}`).join(' '));
        return { ok: true };
      }
      if (name === 'setTheme') {
        const patch = themePatch(payload, config.get('display'), nativeTheme.shouldUseDarkColors);
        if (!patch) return { error: 'bad theme' };
        config.save({ display: patch });
        log.info('theme saved:', JSON.stringify(patch));
        return { ok: true };
      }
      if (name === 'setAudio') {
        // Tap on the spectrum: switch colour mode. Only the audio section is writable here.
        const patch = sanitizeSettings({ audio: payload });
        if (!patch || !patch.audio) return { error: 'bad audio settings' };
        config.save({ audio: patch.audio });
        log.info('audio settings saved:', JSON.stringify(patch.audio));
        return { ok: true };
      }
      if (name === 'setView') {
        // Tap on a panel header: normal / focus / more for that panel.
        const patch = sanitizeSettings({ views: { [payload && payload.panel]: payload && payload.view } });
        if (!patch || !patch.views) return { error: 'bad view' };
        config.save({ views: patch.views });
        log.info('view saved:', JSON.stringify(patch.views));
        return { ok: true };
      }
      return { error: `unknown action ${name}` };
    });
  // Alert snooze (hotkey unreadAlert.snoozeHotkey): silences the unread tint and
  // header sweeps on every panel until snoozedUntil. Kept here so a renderer reload
  // does not drop it.
  alerts = {
    snoozedUntil: 0,
    timer: null,
    state: () => ({ service: 'alerts', status: 'connected', lastUpdated: Date.now(), data: { snoozedUntil: alerts.snoozedUntil > Date.now() ? alerts.snoozedUntil : 0 } }),
    set(until) {
      alerts.snoozedUntil = until;
      clearTimeout(alerts.timer);
      if (until) alerts.timer = setTimeout(() => alerts.set(0), Math.max(0, until - Date.now()));
      host.send('alerts', alerts.state());
      log.info(until ? `alerts snoozed until ${new Date(until).toLocaleTimeString()}` : 'alerts awake');
    },
    // Snoozed: wake. Awake: snooze for unreadAlert.snoozeMinutes (30).
    toggle() {
      if (alerts.snoozedUntil > Date.now()) return alerts.set(0);
      const mins = Math.max(1, Number((config.get('unreadAlert') || {}).snoozeMinutes) || 30);
      alerts.set(Date.now() + mins * 60000);
    },
  };
  host.addVirtual('alerts', alerts.state, (name, payload) => {
    if (name === 'toggle') alerts.toggle();
    else if (name === 'wake') alerts.set(0);
    else if (name === 'snooze') alerts.set(Date.now() + Math.max(1, Number(payload && payload.minutes) || 30) * 60000);
    else return { error: `unknown action ${name}` };
    return { ok: true };
  });

  const schedule = new DisplaySchedule(() => config.get());
  host.addVirtual('display',
    () => ({ service: 'display', status: 'connected', lastUpdated: Date.now(), data: schedule.getState() }),
    (name) => { if (name === 'activity') schedule.activity(); return null; });

  config.on('change', (data) => {
    applyTheme(data);
    host.send('config', configState());
    for (const s of host.services.values()) {
      s.config = data; s.cfg = data[s.name] || s.cfg;
      if (s.onConfig) Promise.resolve().then(() => s.onConfig(data)).catch((e) => s.log.warn('config apply failed:', e.message));
    }
    registerHotkeys(config, host);
  });
  schedule.on('state', (s) => host.send('display', { service: 'display', status: 'connected', lastUpdated: Date.now(), data: s }));
  schedule.on('blanked', (blanked) => host.setSlow(blanked ? (config.get('display').blankedPollFactor || 5) : 1));

  // The audio visualizer asks for getDisplayMedia; answer with system loopback audio
  // (Windows only) and a throwaway screen track the renderer stops immediately.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      callback({ video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined });
    } catch (e) {
      log.warn('display media request failed:', e.message);
      callback({});
    }
  }, { useSystemPicker: false });

  win = createWindow(config.get());
  win.on('closed', () => { win = null; });
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('renderer gone:', details.reason);
    if (details.reason !== 'clean-exit') win.reload();
  });
  // A renderer stuck for 30 s gets crashed, which the handler above turns into a reload.
  let hungTimer = null;
  win.on('unresponsive', () => {
    log.warn('renderer unresponsive');
    clearTimeout(hungTimer);
    hungTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      log.error('renderer still unresponsive after 30 s; restarting it');
      win.webContents.forcefullyCrashRenderer();
    }, 30 * 1000);
  });
  win.on('responsive', () => { clearTimeout(hungTimer); hungTimer = null; });
  win.on('session-end', markSessionEnd);

  await host.startAll();
  schedule.start();
  registerHotkeys(config, host);

  // Dev aid: DOOMBAR_SCREENSHOT=/path.png captures the window after 6 s and quits.
  // DOOMBAR_SCREENSHOT_JS runs in the renderer 2 s before the capture (e.g. to open a drawer).
  if (process.env.DOOMBAR_SCREENSHOT) {
    if (process.env.DOOMBAR_SCREENSHOT_JS) {
      setTimeout(() => win.webContents.executeJavaScript(process.env.DOOMBAR_SCREENSHOT_JS).catch((e) => log.warn('screenshot js failed:', e.message)), 4000);
    }
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.DOOMBAR_SCREENSHOT, img.toPNG());
        log.info('screenshot written to', process.env.DOOMBAR_SCREENSHOT);
      } catch (e) { log.error('screenshot failed:', e.message); }
      app.quit();
    }, 6000);
  }

  app.on('before-quit', async () => {
    globalShortcut.unregisterAll();
    schedule.stop();
    await host.stopAll();
    db.close();
  });
  app.on('window-all-closed', () => app.quit());
  log.info('ready');
}

let alerts = null;

// Global hotkeys: timers.hotkey starts the default timer, unreadAlert.snoozeHotkey
// (Ctrl+Alt+S unless set; "" turns it off) toggles the alert snooze.
const currentHotkeys = new Map(); // id -> accelerator
function registerHotkeys(config, host) {
  const snooze = (config.get('unreadAlert') || {}).snoozeHotkey;
  const wanted = {
    timer: [(config.get('timers') || {}).hotkey, () => host.action('timers', 'startDefault')],
    snooze: [snooze === undefined ? 'Ctrl+Alt+S' : snooze, () => alerts && alerts.toggle()],
  };
  // ACE player: like / dislike / broken (hiss, noise, garble) on the current track.
  if (host.services.has('ace')) {
    const keys = { like: 'Ctrl+Alt+L', dislike: 'Ctrl+Alt+D', broken: 'Ctrl+Alt+B', ...((config.get('ace') || {}).hotkeys || {}) };
    for (const name of ['like', 'dislike', 'broken']) wanted[`ace-${name}`] = [keys[name], () => host.action('ace', 'hotkey', { name })];
  }
  for (const [id, [key, fn]] of Object.entries(wanted)) {
    if (key === currentHotkeys.get(id)) continue;
    if (currentHotkeys.has(id)) globalShortcut.unregister(currentHotkeys.get(id));
    currentHotkeys.delete(id);
    if (!key) continue;
    try {
      const ok = globalShortcut.register(key, fn);
      if (ok) { currentHotkeys.set(id, key); log.info(`${id} hotkey registered:`, key); }
      else log.warn(`${id} hotkey registration refused (taken by another app?):`, key);
    } catch (e) {
      log.warn(`bad ${id} hotkey`, key, e.message);
    }
  }
}
