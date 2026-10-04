'use strict';
// Setup window: paste tokens, test them, connect Google with a visible consent
// link, then pick what the panels show (Slack channels, email senders, calendars,
// theme, visualizer). Opened by `Doombar.exe --setup` or `npm run setup`.
// Separate from the dashboard window, which never shows auth UI. Settings go
// into the user config.json; a running dashboard hot-reloads them.
const path = require('node:path');
const { BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const { themeBg } = require('./window');
const secrets = require('./secrets');
const env = require('./env');
const { projectRoot, ensureDataDir } = require('./paths');
const { scoped } = require('./log');
const { Config } = require('./config');
const { sanitizeSettings } = require('./settings');
const { THEMES } = require('./themes');

const log = scoped('setup');
let registered = false;
let win = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function registerHandlers() {
  if (registered) return;
  registered = true;

  ipcMain.handle('setup:status', () => ({
    dataDir: ensureDataDir(),
    storageProblem: secrets.unavailableReason(),
    names: secrets.status(),
    platform: process.platform,
  }));

  ipcMain.handle('setup:save', (_e, name, value) => {
    if (!secrets.NAMES.includes(name)) return { error: `unknown secret ${name}` };
    try { secrets.set(name, String(value).trim()); return { ok: true }; }
    catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('setup:remove', (_e, name) => {
    if (!secrets.NAMES.includes(name)) return { error: `unknown secret ${name}` };
    secrets.remove(name);
    return { ok: true };
  });

  ipcMain.handle('setup:testAnthropic', async (_e, key) => {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: String(key).trim(), maxRetries: 0, timeout: 15000 });
      const models = await client.models.list({ limit: 5 });
      return { ok: true, detail: `key accepted (${models.data.length}+ models visible)` };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('setup:testSlack', async (_e, { appToken, userToken, botToken }) => {
    const { WebClient, LogLevel } = require('@slack/web-api');
    const out = {};
    try {
      if (appToken && !String(appToken).trim().startsWith('xapp-')) throw new Error('app-level token should start with xapp-');
      if (userToken) {
        const u = await new WebClient(String(userToken).trim(), { logLevel: LogLevel.ERROR }).auth.test();
        out.user = `user token OK: ${u.user} in ${u.team}`;
      }
      if (botToken) {
        const b = await new WebClient(String(botToken).trim(), { logLevel: LogLevel.ERROR }).auth.test();
        out.bot = `bot token OK: ${b.user}`;
      }
      return { ok: true, detail: Object.values(out).join('; ') || 'nothing to test' };
    } catch (e) { return { error: e.data?.error || e.message }; }
  });

  ipcMain.handle('setup:google', async (_e, { clientId, clientSecret }) => {
    clientId = String(clientId || '').trim(); clientSecret = String(clientSecret || '').trim();
    if (!clientId || !clientSecret) return { error: 'client ID and client secret are both required' };
    const { authorizeInteractive } = require('../services/google');
    try {
      const refresh = await authorizeInteractive({
        clientId, clientSecret,
        openUrl: async (url) => {
          send('setup:googleUrl', url);
          try { await shell.openExternal(url); } catch (e) { log.warn('could not open browser:', e.message); }
        },
      });
      const stored = [];
      try {
        secrets.set('GOOGLE_CLIENT_ID', clientId);
        secrets.set('GOOGLE_CLIENT_SECRET', clientSecret);
        secrets.set('GOOGLE_REFRESH_TOKEN', refresh);
        stored.push('stored encrypted');
      } catch (e) {
        return { ok: true, refreshToken: refresh, detail: `Google approved, but could not store: ${e.message}. Copy the refresh token into .env.local as GOOGLE_REFRESH_TOKEN.` };
      }
      return { ok: true, detail: `Google connected and ${stored.join(', ')}` };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('setup:importEnv', () => {
    const vars = { ...env.parseFile(path.join(projectRoot, '.env.local')), ...env.parseFile(path.join(ensureDataDir(), '.env.local')) };
    const stored = []; const errors = [];
    for (const name of secrets.NAMES) {
      if (!vars[name]) continue;
      try { secrets.set(name, vars[name]); stored.push(name); } catch (e) { errors.push(`${name}: ${e.message}`); }
    }
    return { ok: !errors.length, stored, errors };
  });

  // --- dashboard settings ---------------------------------------------------
  let config = null;
  const cfg = () => (config ||= new Config());

  ipcMain.handle('setup:settings', () => {
    const c = cfg(); c.reload();
    const { slack, email, calendar, audio, display, unreadAlert } = c.get();
    return { slack, email, calendar, audio, display, unreadAlert, themes: THEMES.map(({ id, name, mode }) => ({ id, name, mode })) };
  });

  ipcMain.handle('setup:saveSettings', (_e, patch) => {
    const clean = sanitizeSettings(patch);
    if (!clean) return { error: 'nothing valid to save' };
    try { cfg().save(clean); log.info('settings saved:', Object.keys(clean).join(', ')); return { ok: true }; }
    catch (e) { return { error: e.message }; }
  });

  // Conversations the user is in, with the string the Slack service resolves:
  // channel name, "@display name" for DMs, mpdm-… name for group DMs.
  ipcMain.handle('setup:slackChannels', async () => {
    const token = secrets.get('SLACK_USER_TOKEN');
    if (!token) return { error: 'save the Slack tokens above first' };
    const { WebClient, LogLevel } = require('@slack/web-api');
    const web = new WebClient(token, { logLevel: LogLevel.ERROR });
    try {
      const users = new Map();
      for await (const page of web.paginate('users.list', { limit: 200 })) {
        for (const u of page.members || []) users.set(u.id, { name: u.profile?.display_name || u.real_name || u.name || u.id, deleted: u.deleted, bot: u.is_bot });
      }
      const out = [];
      for await (const page of web.paginate('users.conversations', { types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 200 })) {
        for (const c of page.channels || []) {
          if (c.is_im) {
            const u = users.get(c.user);
            if (!u || u.deleted || u.bot || c.user === 'USLACKBOT') continue;
            out.push({ id: c.id, type: 'im', label: u.name, key: '@' + u.name });
          } else if (c.is_mpim) {
            const who = (c.purpose?.value || c.name).replace(/^Group messaging with:\s*/i, '');
            out.push({ id: c.id, type: 'mpim', label: who, key: c.name });
          } else {
            out.push({ id: c.id, type: c.is_private ? 'private' : 'public', label: c.name, key: c.name });
          }
        }
      }
      out.sort((a, b) => a.label.localeCompare(b.label));
      return { ok: true, channels: out };
    } catch (e) { return { error: e.data?.error || e.message }; }
  });

  ipcMain.handle('setup:googleCalendars', async () => {
    const { authClient } = require('../services/google');
    const auth = authClient();
    if (!auth) return { error: 'connect Google above first' };
    try {
      const { calendar } = require('@googleapis/calendar');
      const res = await calendar({ version: 'v3', auth }).calendarList.list({ maxResults: 250 });
      const calendars = (res.data.items || []).map((c) => ({ id: c.primary ? 'primary' : c.id, altId: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || null, primary: !!c.primary }));
      return { ok: true, calendars };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('setup:open', (_e, url) => {
    if (!/^https?:\/\//.test(url)) return { error: 'refusing to open ' + url };
    return shell.openExternal(url).then(() => ({ ok: true }));
  });
  ipcMain.handle('setup:openDataDir', () => shell.openPath(ensureDataDir()).then((err) => (err ? { error: err } : { ok: true })));
  ipcMain.handle('setup:copy', (_e, text) => { clipboard.writeText(String(text)); return { ok: true }; });
}

function openSetupWindow() {
  registerHandlers();
  win = new BrowserWindow({
    width: 980, height: 820, minWidth: 720, minHeight: 600,
    title: 'Doombar setup',
    backgroundColor: themeBg(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload-setup.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'setup', 'index.html'));
  win.on('closed', () => { win = null; });
  if (process.env.DOOMBAR_SCREENSHOT) {
    if (process.env.DOOMBAR_SCREENSHOT_JS) {
      setTimeout(() => win.webContents.executeJavaScript(process.env.DOOMBAR_SCREENSHOT_JS).catch((e) => log.warn('screenshot js failed:', e.message)), 2500);
    }
    setTimeout(async () => {
      try { require('node:fs').writeFileSync(process.env.DOOMBAR_SCREENSHOT, (await win.webContents.capturePage()).toPNG()); } catch (e) { log.error('screenshot failed:', e.message); }
      win.close();
    }, 4000);
  }
  return win;
}

module.exports = { openSetupWindow };
