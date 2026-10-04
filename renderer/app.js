// Renderer bootstrap: build the column grid from config, mount panels,
// subscribe each to its service, handle blanking, after-hours dimming, and
// layout editing (long-press a header to unlock; drag headers to reorder, drag
// the gaps to resize; saved back to config.json through main).
import { Panel, h } from './panels/base.js';
import { SlackPanel } from './panels/slack.js';
import { CalendarPanel } from './panels/calendar.js';
import { EmailPanel } from './panels/email.js';
import { TimersPanel } from './panels/timers.js';
import { AudioPanel } from './panels/audio.js';
import { SystemPanel } from './panels/system.js';
import { AcePanel } from './panels/ace.js';
import { AudioAcePanel } from './panels/audio-ace.js';

// With an `ace` config section the audio panel carries the ACE player on its
// back (header tap flips); `ace` also works as a panel of its own.
const AudioOrFlip = function (name, cfg) { return cfg.ace ? new AudioAcePanel(name, cfg) : new AudioPanel(name, cfg); };
const PANELS = { slack: SlackPanel, calendar: CalendarPanel, email: EmailPanel, timers: TimersPanel, audio: AudioOrFlip, system: SystemPanel, ace: AcePanel };
const MIN_WIDTH = 160;          // config width units (≈ px on the 2560 strip)
const LONG_PRESS_MS = 600;
const EDIT_IDLE_MS = 20000;

const grid = document.getElementById('grid');
const blank = document.getElementById('blank');
const doneBtn = document.getElementById('edit-done');
const editBar = document.getElementById('edit-bar');
const picker = document.getElementById('theme-picker');
const mounted = new Map(); // name -> { panel, unsubscribe }
let layout = [];           // [{ panel, width }] in display order, the renderer's working copy
let config = null;

// --- layout ---------------------------------------------------------------------

function applyColumns() {
  grid.style.gridTemplateColumns = layout.map((l) => `${l.width || 1}fr`).join(' ');
  positionHandles();
}

// Mount new panels, drop removed ones, and put the rest in order. Panels that
// merely moved or changed width keep their DOM and subscription, so a saved
// layout coming back from main does not flash.
function buildLayout(cfg) {
  const next = (cfg.layout || []).filter((l) => PANELS[l.panel]).map((l) => ({ panel: l.panel, width: l.width || 1 }));
  const names = new Set(next.map((l) => l.panel));
  for (const [name, { unsubscribe, panel }] of mounted) {
    if (names.has(name)) continue;
    unsubscribe(); panel.el.remove(); mounted.delete(name);
  }
  for (const item of next) {
    let entry = mounted.get(item.panel);
    if (!entry) {
      let panel;
      try { panel = new PANELS[item.panel](item.panel, cfg); }
      catch (e) { panel = new Panel(item.panel, cfg); panel.showError(`panel failed to load: ${e.message}`); }
      const unsubscribe = window.dashboard.subscribe(item.panel, (state) => {
        try { panel.receive(state); } catch (e) { console.error(item.panel, e); panel.showError(e.message); }
      });
      panel.snoozedUntil = snoozedUntil;
      entry = { panel, unsubscribe };
      mounted.set(item.panel, entry);
    }
    grid.appendChild(entry.panel.el); // appendChild on an existing child moves it
  }
  layout = next;
  applyColumns();
  ensureHandles();
}

window.dashboard.subscribe('config', (state) => {
  config = state.data;
  if (state.theme) applyTheme(state.theme);
  if (!editing) buildLayout(config);
  for (const { panel } of mounted.values()) { panel.config = config; panel.configChanged(); }
  document.documentElement.style.setProperty('--dim', String(config.display?.afterHoursDim ?? 0.45));
});

// Alert snooze (global hotkey, owned by main): panels drop their unread tint until then.
let snoozedUntil = 0;
window.dashboard.subscribe('alerts', (state) => {
  snoozedUntil = state.data?.snoozedUntil || 0;
  for (const { panel } of mounted.values()) { panel.snoozedUntil = snoozedUntil; panel.updateUnreadTint(); }
});

// --- layout editing -------------------------------------------------------------

let editing = false;
let editIdle = null;
const handles = [];

function touchEdit() {
  clearTimeout(editIdle);
  editIdle = setTimeout(() => setEditing(false), EDIT_IDLE_MS);
}

function setEditing(on) {
  if (editing === on) return;
  editing = on;
  grid.classList.toggle('editing', on);
  editBar.hidden = !on;
  clearTimeout(editIdle);
  if (on) { touchEdit(); positionHandles(); }
  else if (config) buildLayout(config); // pick up anything main saved meanwhile
}
doneBtn.addEventListener('click', () => setEditing(false));
editBar.addEventListener('pointerdown', () => touchEdit());

// --- theme ----------------------------------------------------------------------

// Main resolves which palette is active (it knows the Windows app mode) and sends
// it with the config state. The picker lives in the edit bar: Auto follows Windows
// between a dark and a light pick (dashed ring = the pick not showing right now);
// with Auto off, a swatch pins that theme.
let themeInfo = null;
function applyTheme(info) {
  themeInfo = info;
  document.documentElement.dataset.theme = info.active;
  renderPicker();
}

function renderPicker() {
  const t = themeInfo;
  if (!t) return;
  const setTheme = (payload) => window.dashboard.action('config', 'setTheme', payload)
    .then((r) => { if (r && r.error) console.warn('theme save failed:', r.error); });
  const swatch = (th) => {
    const on = th.id === t.active;
    const slot = !on && t.auto && (th.id === t.dark || th.id === t.light);
    return h('button', { class: `swatch${on ? ' on' : ''}${slot ? ' slot' : ''}`, 'data-theme': th.id, onClick: () => setTheme({ theme: th.id }) },
      h('i'), th.name);
  };
  const dark = t.themes.filter((th) => th.mode === 'dark');
  const light = t.themes.filter((th) => th.mode === 'light');
  picker.replaceChildren(
    h('button', { class: `btn auto${t.auto ? ' primary' : ''}`, onClick: () => setTheme({ auto: !t.auto }) },
      'Auto', h('small', { text: 'follows Windows' })),
    h('span', { class: 'sep' }),
    ...dark.map(swatch),
    h('span', { class: 'sep' }),
    ...light.map(swatch));
}

function saveLayout() {
  window.dashboard.action('config', 'setLayout', { layout: layout.map((l) => ({ panel: l.panel, width: Math.round(l.width) })) })
    .then((r) => { if (r && r.error) console.warn('layout save failed:', r.error); });
}

function panelIndex(el) { return layout.findIndex((l) => mounted.get(l.panel)?.panel.el === el); }

// One resize handle per gap between panels, positioned over the gap.
function ensureHandles() {
  while (handles.length < layout.length - 1) {
    const hd = h('div', { class: 'handle' });
    hd.addEventListener('pointerdown', startResize);
    grid.appendChild(hd);
    handles.push(hd);
  }
  while (handles.length > Math.max(0, layout.length - 1)) handles.pop().remove();
  positionHandles();
}

function positionHandles() {
  handles.forEach((hd, i) => {
    const left = mounted.get(layout[i]?.panel)?.panel.el;
    const right = mounted.get(layout[i + 1]?.panel)?.panel.el;
    if (!left || !right) { hd.style.display = 'none'; return; }
    hd.style.display = '';
    hd.style.left = `${(left.offsetLeft + left.offsetWidth + right.offsetLeft) / 2}px`;
  });
}
window.addEventListener('resize', positionHandles);

function unitsPerPx() {
  const total = layout.reduce((s, l) => s + l.width, 0);
  const gaps = 8 * (layout.length - 1);
  return total / Math.max(1, grid.clientWidth - 16 - gaps);
}

function startResize(e) {
  if (!editing) return;
  const hd = e.currentTarget;
  const i = handles.indexOf(hd);
  const left = layout[i]; const right = layout[i + 1];
  if (!left || !right) return;
  const upp = unitsPerPx();
  const startX = e.clientX; const lw = left.width; const rw = right.width;
  hd.setPointerCapture(e.pointerId);
  hd.classList.add('active');
  touchEdit();
  const move = (ev) => {
    let d = (ev.clientX - startX) * upp;
    d = Math.max(MIN_WIDTH - lw, Math.min(rw - MIN_WIDTH, d));
    left.width = lw + d; right.width = rw - d;
    applyColumns();
  };
  const end = () => {
    hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', end); hd.removeEventListener('pointercancel', end);
    hd.classList.remove('active');
    left.width = Math.round(left.width); right.width = Math.round(right.width);
    applyColumns();
    saveLayout();
    touchEdit();
  };
  hd.addEventListener('pointermove', move); hd.addEventListener('pointerup', end); hd.addEventListener('pointercancel', end);
}

// Header pointerdown: long-press unlocks; while unlocked, drag reorders.
grid.addEventListener('pointerdown', (e) => {
  const head = e.target.closest('.panel-head');
  if (!head || e.target.closest('.handle')) return;
  const el = head.parentElement;
  if (!editing) { armLongPress(e, head); return; }
  startDrag(e, el);
});

function armLongPress(e, head) {
  const sx = e.clientX; const sy = e.clientY;
  const timer = setTimeout(() => { cleanup(); setEditing(true); }, LONG_PRESS_MS);
  const cancel = (ev) => { if (ev.type === 'pointermove' && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return; cleanup(); };
  const cleanup = () => { clearTimeout(timer); head.removeEventListener('pointermove', cancel); head.removeEventListener('pointerup', cancel); head.removeEventListener('pointercancel', cancel); };
  head.addEventListener('pointermove', cancel); head.addEventListener('pointerup', cancel); head.addEventListener('pointercancel', cancel);
}

function startDrag(e, el) {
  const head = el.querySelector('.panel-head');
  const grab = e.clientX - el.getBoundingClientRect().left;
  const gridLeft = grid.getBoundingClientRect().left;
  let moved = false;
  head.setPointerCapture(e.pointerId);
  touchEdit();
  const move = (ev) => {
    const wantLeft = ev.clientX - gridLeft - grab;
    if (!moved && Math.abs(wantLeft - el.offsetLeft) < 6) return;
    moved = true;
    el.classList.add('dragging');
    // Where would a panel whose centre is under the finger sit among the others?
    const centre = wantLeft + el.offsetWidth / 2;
    const from = panelIndex(el);
    let to = 0;
    for (const l of layout) {
      const other = mounted.get(l.panel).panel.el;
      if (other === el) continue;
      if (centre > other.offsetLeft + other.offsetWidth / 2) to++;
    }
    if (to !== from) {
      const [item] = layout.splice(from, 1);
      layout.splice(to, 0, item);
      const before = to + 1 < layout.length ? mounted.get(layout[to + 1].panel).panel.el : handles[0] || null;
      grid.insertBefore(el, before);
      applyColumns();
    }
    el.style.transform = `translateX(${wantLeft - el.offsetLeft}px)`;
  };
  const end = () => {
    head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', end); head.removeEventListener('pointercancel', end);
    el.style.transform = '';
    el.classList.remove('dragging');
    if (moved) saveLayout();
    positionHandles();
    touchEdit();
  };
  head.addEventListener('pointermove', move); head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
}

// --- blanking and dimming -------------------------------------------------------

// Blanking: an overlay, not a window change. Swallow the first tap after waking.
let swallowNext = false;
window.dashboard.subscribe('display', (state) => {
  const wasBlank = !blank.hidden;
  blank.hidden = !state.data.blanked;
  document.body.classList.toggle('blanked', !!state.data.blanked);
  if (wasBlank && !state.data.blanked) swallowNext = true;
  // Outside business hours the strip stays on but drops to a fraction of its
  // brightness; a tap lifts the dim for a minute so it can still be used.
  const after = state.data.businessHours === false;
  document.body.classList.toggle('after-hours', after);
});
let liftTimer = null;
function liftDim() {
  document.body.classList.add('dim-lifted');
  clearTimeout(liftTimer);
  liftTimer = setTimeout(() => document.body.classList.remove('dim-lifted'), 60000);
}
blank.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); swallowNext = true; window.dashboard.action('display', 'activity'); }, true);
document.addEventListener('pointerdown', (e) => {
  if (swallowNext) { swallowNext = false; e.stopPropagation(); e.preventDefault(); }
  if (document.body.classList.contains('after-hours')) liftDim();
}, true);

// Report activity to main so its idle counter has a second source.
let lastReport = 0;
document.addEventListener('pointerdown', () => {
  const now = Date.now();
  if (now - lastReport > 5000) { lastReport = now; window.dashboard.action('display', 'activity'); }
}, { passive: true, capture: true });

// Tick once a second for countdowns / "last updated".
setInterval(() => { for (const { panel } of mounted.values()) panel.tick(); }, 1000);
