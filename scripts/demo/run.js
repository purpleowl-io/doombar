'use strict';
// Screenshots and a screen recording with made-up data, for the README and posts.
//
//   electron scripts/demo/run.js dashboard <outDir>   strip stills + calendar flip frames
//   electron scripts/demo/run.js setup <outDir>       setup window: accounts, sign-in, calendars
//
// The dashboard run boots the real app (main/index.js) with the Slack, Email and
// Calendar services swapped for scripts/demo/fixtures.js, audio on the mock
// backend, and its own throwaway data folder and config, so it runs beside an
// installed Doombar and never touches its accounts, database or settings. On the
// strip it covers the real dashboard for about 20 s, then quits.
// The setup run loads the real setup page against fake IPC handlers.
// scripts/demo/encode.js turns the recorded frames into MP4 and GIF.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');
const { app, BrowserWindow, ipcMain } = require('electron');

const repo = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('run.js')) + 1);
const mode = args[0] || 'dashboard';
const outDir = path.resolve(args[1] || path.join(repo, 'docs', 'media'));
fs.mkdirSync(outDir, { recursive: true });

const dataDir = path.join(os.tmpdir(), `doombar-demo-${mode}`);
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir); // own single-instance lock, so an installed Doombar can keep running
process.env.DOOMBAR_DATA = dataDir;
process.env.DOOMBAR_CONFIG = path.join(dataDir, 'config.json');
process.env.DOOMBAR_AUDIO_BACKEND = 'mock';
process.env.DOOMBAR_WATCHDOG = '0';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[demo]', ...a);

// The config the demo runs on: always business hours (no after-hours dim, no
// blanking), every panel in its normal view, no ACE face on the audio panel.
const demoConfig = {
  display: {
    theme: 'oled', darkTheme: 'oled', lightTheme: 'daylight',
    businessHours: { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' },
    blankAfterIdleMinutes: 100000,
  },
  layout: [
    { panel: 'calendar', width: 478 }, { panel: 'slack', width: 497 }, { panel: 'email', width: 483 },
    { panel: 'timers', width: 407 }, { panel: 'audio', width: 520 }, { panel: 'system', width: 280 },
  ],
  slack: { channels: ['ext-northwind', 'ext-fabrikam', 'eng-platform', 'releases', 'ext-contoso', '@Dana Whitfield'] },
  calendar: { calendars: [
    { account: 'g1', id: 'primary', name: 'Work', color: '#7c9cff' },
    { account: 'm1', id: 'AAMkAD-calendar', name: 'Contoso tenant', color: '#4fc3a1' },
    { account: 'g2', id: 'primary', name: 'Personal', color: '#ff7aa2' },
  ], alertMinutes: 5 },
  email: { senders: ['northwind', 'fabrikam.com', 'contoso', 'tailspintoys.com'], prospects: ['lakeshorehealth.org', 'wingtip'], groupBy: 'client' },
  unreadAlert: { enabled: true, sweep: true, sweepSeconds: 3, sweepEverySeconds: 10, sweepEveryBreathingSeconds: 4, redAfterMinutes: 10, pulseAfterMinutes: 20 },
  views: { calendar: 'normal', slack: 'normal', email: 'normal', audio: 'normal' },
  audio: { visual: 'spectrum', vizColor: 'sustain' },
  accounts: [],
  ace: null,
};
fs.writeFileSync(process.env.DOOMBAR_CONFIG, JSON.stringify(demoConfig, null, 2));

if (mode === 'setup') runSetup();
else runDashboard();

// --- dashboard ---------------------------------------------------------------

function runDashboard() {
  // Swap the three account-backed services before main/index.js requires them.
  const fixtures = require('./fixtures');
  for (const [file, cls] of [['slack', 'SlackService'], ['email', 'EmailService'], ['calendar', 'CalendarService']]) {
    const p = require.resolve(path.join(repo, 'services', file));
    const m = new Module(p);
    m.filename = p; m.loaded = true; m.exports = { [cls]: fixtures[cls] };
    require.cache[p] = m;
  }
  app.on('browser-window-created', (_e, win) => {
    win.webContents.once('did-finish-load', () => script(win).catch((e) => { console.error(e); app.exit(1); }));
  });
  require(path.join(repo, 'main', 'index.js'));
}

const js = (win, code) => win.webContents.executeJavaScript(code);

async function shot(win, name, rect) {
  const img = await win.webContents.capturePage(rect);
  fs.writeFileSync(path.join(outDir, name), img.toPNG());
  log(name, img.getSize());
}

// A finger-tap ring where the header is tapped, so the recording shows the cause.
const TAP = `(() => {
  const h = document.querySelector('.panel-calendar .panel-head');
  const r = h.getBoundingClientRect();
  const dot = document.createElement('div');
  Object.assign(dot.style, { position: 'fixed', left: (r.left + r.width / 2 - 34) + 'px', top: (r.top + r.height / 2 - 34) + 'px',
    width: '68px', height: '68px', borderRadius: '50%', background: 'rgba(255,255,255,.35)', border: '3px solid rgba(255,255,255,.85)',
    pointerEvents: 'none', zIndex: 9999 });
  document.body.appendChild(dot);
  dot.animate([{ transform: 'scale(.6)', opacity: 1 }, { transform: 'scale(1.25)', opacity: 0 }], { duration: 650, easing: 'ease-out', fill: 'forwards' })
    .finished.then(() => dot.remove());
  h.click();
})()`;

// Every painted frame (the spectrum keeps the page painting), timestamped.
async function record(win, ms, cues) {
  const frames = [];
  const t0 = Date.now();
  win.webContents.beginFrameSubscription(false, (img) => { frames.push({ t: Date.now() - t0, jpg: img.toJPEG(92) }); });
  for (const [at, fn] of cues) setTimeout(fn, at);
  await wait(ms);
  win.webContents.endFrameSubscription();
  return frames;
}

async function script(win) {
  await wait(4500); // services publish, spectrum settles, first header sweeps play
  await js(win, `document.body.style.cursor = 'none'`);
  // A running timer, as on a normal workday.
  await js(win, `window.dashboard.action('timers', 'start', { minutes: 25, label: 'Focus' })`);
  await wait(2500);
  await shot(win, 'dashboard.png');

  // The calendar rect, for a cropped version of the recording.
  const crop = await js(win, `(() => { const r = document.querySelector('.panel-calendar').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: devicePixelRatio }; })()`);

  // Calendar header taps: normal -> focus (Next) -> more (Week) -> normal.
  const frames = await record(win, 11000, [[1200, () => js(win, TAP)], [4400, () => js(win, TAP)], [7600, () => js(win, TAP)]]);
  const dir = path.join(outDir, 'frames');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  frames.forEach((f, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(5, '0')}.jpg`), f.jpg));
  fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({ times: frames.map((f) => f.t), crop }));
  log(`${frames.length} frames over ${frames[frames.length - 1].t} ms (${(frames.length / (frames[frames.length - 1].t / 1000)).toFixed(1)} fps)`);

  // Every panel in its focus view, then the light theme.
  for (const p of ['calendar', 'slack', 'email']) await js(win, `window.dashboard.action('config', 'setView', { panel: '${p}', view: 'focus' })`);
  await wait(1500);
  await shot(win, 'dashboard-focus.png');
  for (const p of ['calendar', 'slack', 'email']) await js(win, `window.dashboard.action('config', 'setView', { panel: '${p}', view: 'normal' })`);
  await js(win, `window.dashboard.action('config', 'setTheme', { theme: 'daylight' })`);
  await wait(1800);
  await shot(win, 'dashboard-light.png');
  app.quit();
}

// --- setup window --------------------------------------------------------------

function runSetup() {
  const accounts = [
    { id: 'g1', provider: 'google', email: 'alex@example.com', label: 'Work', mail: true, calendar: true, signedIn: true },
    { id: 'm1', provider: 'microsoft', email: 'alex@contoso.example', label: 'M365', mail: true, calendar: true, signedIn: true },
    { id: 'g2', provider: 'google', email: 'alex.personal@example.net', label: 'Personal', mail: false, calendar: true, signedIn: true },
  ];
  const calendars = [
    { account: 'g1', accountLabel: 'Work', id: 'primary', name: 'alex@example.com', color: '#7c9cff', primary: true },
    { account: 'g1', accountLabel: 'Work', id: 'team-ooo@group.calendar.example', name: 'Team out of office', color: '#f5b950' },
    { account: 'g1', accountLabel: 'Work', id: 'en.usa#holiday@group.v.calendar.example', name: 'Holidays in United States', color: '#16a765' },
    { account: 'm1', accountLabel: 'M365', id: 'AAMkAD-calendar', name: 'Calendar', color: '#4fc3a1', primary: true },
    { account: 'm1', accountLabel: 'M365', id: 'AAMkAD-birthdays', name: 'Birthdays', color: '#b388ff' },
    { account: 'g2', accountLabel: 'Personal', id: 'primary', name: 'alex.personal@example.net', color: '#ff7aa2', primary: true },
    { account: 'g2', accountLabel: 'Personal', id: 'family@group.calendar.example', name: 'Family', color: '#9fe1e7' },
  ];
  const { THEMES } = require(path.join(repo, 'main', 'themes'));
  const ok = (x = {}) => async () => ({ ok: true, ...x });
  let win;
  const handlers = {
    'setup:status': async () => ({ dataDir: 'C:\\Users\\you\\AppData\\Roaming\\doombar', storageProblem: null, platform: 'win32',
      names: { ANTHROPIC_API_KEY: 'safeStorage', SLACK_APP_TOKEN: 'safeStorage', SLACK_USER_TOKEN: 'safeStorage', SLACK_BOT_TOKEN: null, MICROSOFT_CLIENT_ID: 'safeStorage', GOOGLE_CLIENT_ID: 'safeStorage', GOOGLE_CLIENT_SECRET: 'safeStorage' } }),
    'setup:accounts': ok({ accounts, microsoftApp: true, googleClient: true }),
    'setup:calendars': ok({ calendars, errors: [] }),
    'setup:settings': async () => {
      const { slack, email, calendar, audio, display, unreadAlert } = demoConfig;
      return { slack, email, calendar: { ...calendar, calendars: calendar.calendars.filter((c) => c.account !== 'm1') }, audio, display: { ...display, theme: 'system' }, unreadAlert, themes: THEMES.map(({ id, name, mode }) => ({ id, name, mode })) };
    },
    // Sign-in: show the consent link and stay "waiting for you to approve".
    'setup:addMicrosoft': () => {
      win.webContents.send('setup:authUrl', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=00000000-0000-0000-0000-000000000000&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A53682&scope=offline_access%20Mail.ReadWrite%20Calendars.Read%20User.Read&code_challenge=…&code_challenge_method=S256&login_hint=alex%40contoso.example');
      return new Promise(() => {});
    },
    'setup:addGoogle': () => new Promise(() => {}),
    'setup:registerMicrosoft': () => new Promise(() => {}),
  };
  for (const ch of ['save', 'remove', 'testAnthropic', 'testSlack', 'removeAccount', 'accountFlags', 'importEnv', 'open', 'openDataDir', 'copy', 'saveSettings', 'slackChannels']) {
    handlers[`setup:${ch}`] ||= ok({ stored: [], errors: [], channels: [] });
  }
  for (const [ch, fn] of Object.entries(handlers)) ipcMain.handle(ch, fn);

  app.whenReady().then(async () => {
    win = new BrowserWindow({
      width: 980, height: 1100, show: true, backgroundColor: '#000000', autoHideMenuBar: true, title: 'Doombar setup',
      webPreferences: { preload: path.join(repo, 'preload-setup.js'), contextIsolation: true, sandbox: true, spellcheck: false },
    });
    require('electron').nativeTheme.themeSource = 'dark';
    await win.loadFile(path.join(repo, 'renderer', 'setup', 'index.html'));
    await wait(1200);
    // Crop to one section (its top through `until`, if given), scrolled into view.
    const section = async (name, h2, until) => {
      const rect = await js(win, `(() => {
        const s = [...document.querySelectorAll('section')].find((x) => x.querySelector('h2').textContent.includes(${JSON.stringify(h2)}));
        s.scrollIntoView({ block: 'start' });
        const r = s.getBoundingClientRect();
        const end = ${until ? `document.querySelector(${JSON.stringify(until)}).getBoundingClientRect().bottom + 2` : 'r.bottom'};
        return { x: Math.floor(r.x) - 8, y: Math.max(0, Math.floor(r.y) - 8), width: Math.ceil(r.width) + 16, height: Math.ceil(Math.min(end, innerHeight) - r.y) + 16 };
      })()`);
      await wait(300);
      await shot(win, name, rect);
    };
    await section('setup-accounts.png', 'Mail & calendar');
    await js(win, `document.getElementById('msLogin').value = 'alex@contoso.example'; document.getElementById('addMicrosoft').click();`);
    await wait(600);
    await section('setup-signin.png', 'Mail & calendar', '#authUrlBox');
    await js(win, `document.getElementById('loadCalendars').click();`);
    await wait(600);
    await section('setup-calendars.png', 'Calendars');
    app.quit();
  });
}
