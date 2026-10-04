// Panel base: header with status dot + last-updated, body, helpers for rows,
// confirm-tap buttons, swipe-to-action, and relative time formatting.

export const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
};

export function timeShort(ms, tz) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(ms)).toLowerCase();
}

export function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function relTime(ms, tz) {
  const d = Date.now() - ms;
  if (d < 24 * 3600 * 1000 && new Date(ms).getDate() === new Date().getDate()) return timeShort(ms, tz);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz }).format(new Date(ms));
}

export function bytes(n) {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${Math.round(n)} B`;
}

// One line per merged account whose last poll failed (email/calendar state.accounts);
// the other accounts keep showing. Null when all are fine.
export function accountWarning(accounts) {
  const bad = (accounts || []).filter((a) => a.error);
  return bad.length ? h('div', { class: 'acct-warn', text: bad.map((a) => `⚠ ${a.label}: ${a.error}`).join(' · ') }) : null;
}

export const VIEWS = ['normal', 'focus', 'more'];

// A positive number of seconds from config, else the default.
const secs = (v, def) => (Number(v) > 0 ? Number(v) : def);

export class Panel {
  constructor(name, config, title = name) {
    this.name = name;
    this.config = config;
    this.state = null;
    this.dot = h('span', { class: 'panel-dot starting' });
    this.updated = h('span', { class: 'panel-updated' });
    this.snoozePill = h('span', { class: 'panel-snoozed', hidden: true });
    this.title = h('span', { class: 'panel-title', text: title });
    this.body = h('div', { class: 'panel-body' });
    this.el = h('section', { class: `panel panel-${name}` },
      (this.head = h('header', { class: 'panel-head' }, this.title, this.snoozePill, this.updated, this.dot)),
      this.body);
    this.openRow = null;
  }

  get tz() { return this.config?.display?.timezone; }

  // Views (config views.<panel>): 'normal', 'focus' or 'more'. A panel that has them
  // calls enableViews with its header labels; a tap on the header cycles
  // normal → focus → more (a long press still unlocks layout editing). A panel
  // with other faces passes its own list (audio: normal ↔ ace).
  enableViews(labels, views = VIEWS) {
    this.viewLabels = labels;
    this.viewList = views;
    this.viewPill = h('span', { class: 'panel-view' });
    this.title.after(this.viewPill);
    this.head.addEventListener('click', () => {
      if (this.el.closest('.grid.editing')) return;
      const list = this.viewList;
      const next = list[(list.indexOf(this.view) + 1) % list.length];
      window.dashboard.action('config', 'setView', { panel: this.name, view: next })
        .then((r) => { if (r && r.error) console.warn('setView:', r.error); });
    });
  }

  get view() {
    const v = this.config?.views?.[this.name];
    return this.viewLabels && this.viewList.includes(v) ? v : 'normal';
  }

  // Called by app.js when config changes: if the view moved, flip the panel over
  // to it. A tap during a flip is picked up when that flip ends.
  configChanged() {
    if (!this.viewLabels || this.view === this.renderedView || !this.state || this.flipping) return;
    this.flip(() => this.receive(this.state)).then(() => this.configChanged());
  }

  // Card flip: turn the panel edge-on, swap its contents, turn the new face in.
  // Skipped (plain swap) when the OS asks for reduced motion.
  async flip(swap) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { swap(); return; }
    this.flipping = true;
    const turn = (from, to, easing) => this.el.animate(
      [{ transform: `perspective(2000px) rotateY(${from}deg)` }, { transform: `perspective(2000px) rotateY(${to}deg)` }],
      { duration: 160, easing, fill: 'forwards' });
    const out = turn(0, 90, 'ease-in');
    try {
      await out.finished;
      swap();
      const back = turn(-90, 0, 'ease-out');
      out.cancel();
      await back.finished;
      back.cancel();
    } catch { /* cancelled */ } finally { this.flipping = false; }
  }

  receive(state) {
    this.state = state;
    if (this.viewLabels) {
      this.renderedView = this.view;
      this.viewPill.textContent = this.viewLabels[this.view] || '';
      this.el.dataset.view = this.view;
    }
    this.dot.className = `panel-dot ${state.status}`;
    this.updated.textContent = state.lastUpdated ? ago(state.lastUpdated) : '';
    if (state.status === 'disabled') { this.showNotice(state.error || 'disabled'); return; }
    if (state.status === 'error' && !this.hasContent()) { this.showError(state.error || 'error'); return; }
    this.render(state.data, state);
  }

  hasContent() { return this.body.childElementCount > 0 && !this.body.querySelector('.notice'); }

  tick() {
    if (this.state?.lastUpdated) this.updated.textContent = ago(this.state.lastUpdated);
    this.updateUnreadTint();
    this.onTick && this.onTick();
  }

  // Unread tint (config unreadAlert): a panel with unread items warms from amber
  // to red as the oldest one ages, then breathes gently between two reds.
  // Panels call setUnreadSince(ms | null) from render(); tick() keeps it moving.
  // `count` (optional) is the number of unread items; a rise triggers a header sweep.
  setUnreadSince(ms, count = ms ? 1 : 0) {
    const rose = count > (this.unreadCount || 0);
    this.unreadSince = ms || null;
    this.unreadCount = count;
    if (rose) this.nextSweep = 0; // sweep on the tick below
    this.updateUnreadTint();
  }

  // One soft band of light across the header (CSS .panel-head.sweep). Restarted by
  // removing the class and forcing a reflow so back-to-back sweeps still play.
  sweepHeader() {
    const head = this.head;
    head.classList.remove('sweep');
    void head.offsetWidth;
    head.classList.add('sweep');
    clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => head.classList.remove('sweep'), secs(this.config?.unreadAlert?.sweepSeconds, 1.1) * 1000 + 400);
  }

  updateUnreadTint() {
    const cfg = this.config?.unreadAlert || {};
    const want = cfg.enabled !== false && this.unreadSince && this.state?.status !== 'disabled';
    // Snoozed (hotkey, app.js sets snoozedUntil): no tint or sweep, just a quiet
    // header note with the time left.
    const snoozeLeft = (this.snoozedUntil || 0) - Date.now();
    this.snoozePill.hidden = !(want && snoozeLeft > 0);
    if (want && snoozeLeft > 0) this.snoozePill.textContent = `🔕 ${Math.ceil(snoozeLeft / 60000)}m`;
    const on = want && snoozeLeft <= 0;
    this.el.classList.toggle('unread-alert', !!on);
    if (!on) { this.el.classList.remove('pulsing'); this.nextSweep = 0; return; }
    const mins = Math.max(0, (Date.now() - this.unreadSince) / 60000);
    const redAfter = Math.max(1, Number(cfg.redAfterMinutes) || 30);
    const pulseAfter = Math.max(redAfter, Number(cfg.pulseAfterMinutes) || 60);
    const u = Math.min(1, mins / redAfter);
    this.el.style.setProperty('--u', `${Math.round(u * 100)}%`);
    this.el.style.setProperty('--tint', `${Math.round(11 + u * 12)}%`);
    this.el.style.setProperty('--breathe-dur', `${secs(cfg.breatheSeconds, 3.5)}s`);
    this.el.style.setProperty('--sweep-dur', `${secs(cfg.sweepSeconds, 1.1)}s`);
    const pulsing = mins >= pulseAfter;
    this.el.classList.toggle('pulsing', pulsing);

    // Header sweep: at once for new unread, then a reminder every sweepEverySeconds
    // (amber), sliding to sweepEveryBreathingSeconds once breathing. Never while blanked.
    if (cfg.sweep === false || document.body.classList.contains('blanked')) return;
    const now = Date.now();
    if (now >= (this.nextSweep || 0)) {
      this.sweepHeader();
      const early = secs(cfg.sweepEverySeconds, 30);
      const late = secs(cfg.sweepEveryBreathingSeconds, 12);
      this.nextSweep = now + (pulsing ? late : early + (late - early) * u) * 1000;
    }
  }

  render() {}

  clear() { this.body.replaceChildren(); this.openRow = null; }

  showNotice(text) { this.body.replaceChildren(h('div', { class: 'notice', text })); }
  showError(text) { this.body.replaceChildren(h('div', { class: 'notice error', text })); }

  action(name, payload) {
    return window.dashboard.action(this.name, name, payload).then((r) => {
      if (r && r.error) console.warn(`${this.name}.${name}:`, r.error);
      return r;
    });
  }

  // Second tap on the same button confirms; reverts after 3 s.
  confirmButton(label, onConfirm, cls = 'danger') {
    const btn = h('button', { class: `btn ${cls}`, text: label });
    let armed = null;
    btn.addEventListener('click', () => {
      if (armed) { clearTimeout(armed); armed = null; btn.textContent = label; btn.className = `btn ${cls}`; onConfirm(); return; }
      btn.textContent = 'Confirm';
      btn.className = 'btn confirm';
      armed = setTimeout(() => { armed = null; btn.textContent = label; btn.className = `btn ${cls}`; }, 3000);
    });
    return btn;
  }

  /**
   * A list row: tap toggles an actions drawer beneath it; a 40 px horizontal
   * swipe (under 15 px vertical) runs `onSwipe`. Pointer events only.
   */
  row({ classes = '', content, actions = [], onSwipe, swipeLabel = 'Read', key }) {
    const inner = h('div', { class: 'row-content' }, ...content);
    const hint = h('div', { class: 'swipe-hint', text: swipeLabel });
    const row = h('div', { class: `row ${classes}`, 'data-key': key }, onSwipe ? hint : null, inner);
    const drawer = h('div', { class: 'row-actions' }, ...actions);
    const wrap = h('div', { class: 'row-wrap' }, row, drawer);

    let start = null; let moved = false; let fired = false;
    row.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY }; moved = false; fired = false; row.setPointerCapture(e.pointerId); });
    row.addEventListener('pointermove', (e) => {
      if (!start || !onSwipe) return;
      const dx = e.clientX - start.x; const dy = e.clientY - start.y;
      if (Math.abs(dy) > 15 && !moved) { start = null; return; }
      if (dx > 6) { moved = true; row.classList.add('swiping'); inner.style.transform = `translateX(${Math.min(dx, 160)}px)`; hint.style.width = `${Math.min(dx, 160)}px`; }
      if (dx >= 40 && !fired) { fired = true; }
    });
    const end = () => {
      if (start === null && !moved) return;
      row.classList.remove('swiping'); inner.style.transform = ''; hint.style.width = '0';
      if (fired && onSwipe) onSwipe();
      else if (!moved) this.toggleDrawer(wrap, drawer);
      start = null; moved = false; fired = false;
    };
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', () => { row.classList.remove('swiping'); inner.style.transform = ''; hint.style.width = '0'; start = null; moved = false; fired = false; });
    if (this.openRow === key) drawer.classList.add('open');
    return wrap;
  }

  toggleDrawer(wrap, drawer) {
    const key = wrap.firstElementChild.dataset.key;
    const wasOpen = drawer.classList.contains('open');
    this.body.querySelectorAll('.row-actions.open').forEach((d) => d.classList.remove('open'));
    if (!wasOpen) { drawer.classList.add('open'); this.openRow = key; } else this.openRow = null;
  }
}
