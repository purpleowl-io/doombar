'use strict';
// Find the 2560x666 strip, park a frameless kiosk window on it, and follow it
// when displays come and go.
const path = require('node:path');
const { BrowserWindow, screen, nativeTheme } = require('electron');
const { scoped } = require('../main/log');
const { THEMES, resolveTheme } = require('./themes');
const { MouseFence } = require('./mouse-fence');

const log = scoped('window');

// Electron reports display sizes in DIPs (physical / scaleFactor on Windows), so a
// 2560x666 strip at 125% scaling shows up as 2048x533. Match on either.
function physical(d) {
  return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
}

function findTarget(cfg) {
  const displays = screen.getAllDisplays();
  const want = cfg.display || {};
  const match = displays.find((d) => d.size.width === want.width && d.size.height === want.height)
    || displays.find((d) => physical(d).width === want.width && physical(d).height === want.height)
    || displays.find((d) => d.bounds.width === want.width && d.bounds.height === want.height);
  return { display: match || screen.getPrimaryDisplay(), matched: !!match, displays };
}

// Window chrome colour behind the renderer, so the first frame and any reload
// match the palette instead of flashing the wrong one.
let themeDisplay = {};
function themeBg() {
  const { id } = resolveTheme(themeDisplay, nativeTheme.shouldUseDarkColors);
  return THEMES.find((t) => t.id === id).bg;
}

// config.display.theme (see main/themes.js). A pinned theme pins nativeTheme to
// its mode; "system" lets Windows' app mode drive prefers-color-scheme, which the
// renderer uses to choose between darkTheme and lightTheme.
function applyTheme(cfg) {
  themeDisplay = cfg.display || {};
  nativeTheme.themeSource = resolveTheme(themeDisplay, nativeTheme.shouldUseDarkColors).source;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setBackgroundColor(themeBg());
}

function describe(d) {
  const p = physical(d);
  return `${d.id}: ${d.size.width}x${d.size.height} dip (${p.width}x${p.height} px @${d.scaleFactor}x) at ${d.bounds.x},${d.bounds.y}${d.internal ? ' internal' : ''}`;
}

function createWindow(cfg) {
  applyTheme(cfg);
  const { display, matched, displays } = findTarget(cfg);
  log.info(`displays: ${displays.map(describe).join(' | ')}`);
  log.info(`using display ${display.id} ${display.size.width}x${display.size.height}${matched ? '' : ` (no ${cfg.display.width}x${cfg.display.height} strip found, falling back to primary)`}`);

  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    show: false,
    backgroundColor: themeBg(),
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // Set bounds first, then kiosk: enabling kiosk before the window is on the
  // right display tends to lock it to the primary.
  win.setBounds(display.bounds);
  if (matched || process.env.DOOMBAR_KIOSK === '1') {
    win.setKiosk(true);
    win.setAlwaysOnTop(true, 'screen-saver');
  } else if (process.env.DOOMBAR_KIOSK !== '0') {
    // Dev box without the strip: emulate its aspect at a size that fits.
    win.setKiosk(false);
    win.setAlwaysOnTop(false);
    const w = Math.min(display.workArea.width, cfg.display.width || 2560);
    win.setSize(w, Math.round(w * (cfg.display.height || 666) / (cfg.display.width || 2560)));
    win.center();
  }
  // Renderer console warnings and errors land in main.log; there is no DevTools on a kiosk.
  win.webContents.on('console-message', (e) => {
    if (e.level === 'debug') return;
    const where = e.sourceId ? ` (${String(e.sourceId).split('/').pop()}:${e.lineNumber})` : '';
    const fn = e.level === 'error' ? log.error : e.level === 'warning' ? log.warn : log.info;
    fn(`renderer${where}: ${e.message}`);
  });
  // Keep the physical mouse off the strip (touch still works). display.mouseFence: false disables.
  const fence = new MouseFence();
  const updateFence = (t) => {
    if (t.matched && cfg.display.mouseFence !== false) fence.set(screen.dipToScreenRect(null, t.display.bounds));
    else fence.off();
  };
  updateFence({ display, matched });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const reposition = () => {
    if (win.isDestroyed()) return;
    const t = findTarget(cfg);
    updateFence(t);
    if (!t.matched) return;
    log.info('display change, moving to strip');
    win.setKiosk(false);
    win.setBounds(t.display.bounds);
    win.setKiosk(true);
  };
  const onTheme = () => { if (!win.isDestroyed()) win.setBackgroundColor(themeBg()); };
  nativeTheme.on('updated', onTheme);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
  screen.on('display-metrics-changed', reposition);
  win.on('closed', () => {
    fence.close();
    nativeTheme.off('updated', onTheme);
    screen.off('display-added', reposition);
    screen.off('display-removed', reposition);
    screen.off('display-metrics-changed', reposition);
  });
  return win;
}

module.exports = { createWindow, findTarget, applyTheme, themeBg };
