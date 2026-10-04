'use strict';
// Setup window: paste tokens, test them, sign in Google and Microsoft 365 accounts
// with a visible consent link, then pick what the panels show (Slack channels, email senders, calendars,
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

  // --- mail/calendar accounts (main/account-setup.js) ---------------------
  const accountSetup = require('./account-setup');
  // Browser consent: the URL also goes to the window in case the browser did not open.
  const openUrl = async (url) => {
    send('setup:authUrl', url);
    try { await shell.openExternal(url); } catch (e) { log.warn('could not open browser:', e.message); }
  };
  const wrap = (fn) => async (...args) => { try { return { ok: true, ...(await fn(...args)) }; } catch (e) { return { error: e.message }; } };

  ipcMain.handle('setup:accounts', wrap(() => ({ accounts: accountSetup.listWithStatus(), microsoftApp: !!secrets.get('MICROSOFT_CLIENT_ID'), googleClient: !!(secrets.get('GOOGLE_CLIENT_ID') && secrets.get('GOOGLE_CLIENT_SECRET')) })));
  ipcMain.handle('setup:addGoogle', wrap((_e, { clientId, clientSecret } = {}) =>
    accountSetup.addGoogleAccount({ openUrl, clientId: String(clientId || '').trim(), clientSecret: String(clientSecret || '').trim() })));
  ipcMain.handle('setup:registerMicrosoft', wrap(() => accountSetup.registerMicrosoftApp({ openUrl })));
  ipcMain.handle('setup:addMicrosoft', wrap((_e, { loginHint } = {}) => accountSetup.addMicrosoftAccount({ openUrl, loginHint: String(loginHint || '').trim() || undefined })));
  ipcMain.handle('setup:removeAccount', wrap((_e, id) => accountSetup.removeAccount(String(id))));
  ipcMain.handle('setup:accountFlags', wrap((_e, id, flags) => accountSetup.setAccountFlags(String(id), flags || {})));

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

  ipcMain.handle('setup:calendars', wrap(() => accountSetup.allCalendars()));

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
