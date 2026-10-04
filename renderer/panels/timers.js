import { Panel, h } from './base.js';

function fmt(ms) {
  const s = Math.ceil(ms / 1000);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

function minutesLabel(m) {
  if (m >= 60 && m % 60 === 0) return `${m / 60} hr`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m} min`;
}

// Presets start a timer in one tap. Below them, +/- chips either build up a
// custom duration (then Start) or, when a running timer has been tapped to
// select it, add or remove time from that timer. No keyboard, no numpad.
export class TimersPanel extends Panel {
  constructor(name, config) {
    super(name, config, 'Timers');
    this.staged = 0;          // minutes being built up for a new timer
    this.selected = null;     // id of the timer the chips currently adjust
    this.selectIdle = null;
    this.audioCtx = null;
    this.rendered = new Map(); // id -> { remainingEl, endAt, running }
  }

  beep() {
    if (!(this.state?.data?.sound ?? true)) return;
    try {
      this.audioCtx ||= new AudioContext();
      const ctx = this.audioCtx;
      for (let i = 0; i < 3; i++) {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.35);
        g.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + i * 0.35 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.35 + 0.3);
        o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + i * 0.35); o.stop(ctx.currentTime + i * 0.35 + 0.32);
      }
    } catch (e) { console.warn('beep failed', e); }
  }

  select(id) {
    this.selected = this.selected === id ? null : id;
    clearTimeout(this.selectIdle);
    if (this.selected) this.selectIdle = setTimeout(() => { this.selected = null; this.rerender(); }, 10000);
    this.rerender();
  }

  rerender() { if (this.state?.data) this.render(this.state.data); }

  step(minutes, d) {
    clearTimeout(this.selectIdle);
    if (this.selected && d.timers.some((t) => t.id === this.selected)) {
      this.selectIdle = setTimeout(() => { this.selected = null; this.rerender(); }, 10000);
      this.action('add', { id: this.selected, minutes });
      return;
    }
    this.selected = null;
    this.staged = Math.max(0, Math.min(24 * 60, this.staged + minutes));
    this.render(d);
  }

  render(d) {
    if (d.firedIds && d.firedIds.length) this.beep();
    if (this.selected && !d.timers.some((t) => t.id === this.selected)) this.selected = null;
    this.rendered.clear();

    const list = h('div', { class: 'timer-list' });
    for (const t of d.timers) {
      const remaining = h('div', { class: 'remaining', text: fmt(t.remainingMs) });
      const finished = t.done || t.fired;
      const el = h('div', { class: `timer ${t.running ? '' : 'paused'} ${finished ? 'done' : ''} ${this.selected === t.id ? 'selected' : ''}` },
        remaining,
        h('div', { class: 'label', text: t.label }),
        h('div', { class: 'tbtns' },
          finished
            ? h('button', { class: 'btn primary', text: 'OK', onClick: () => this.action('dismiss', { id: t.id }) })
            : [
              h('button', { class: 'btn', text: t.running ? '❚❚' : '▶', onClick: (e) => { e.stopPropagation(); this.action(t.running ? 'pause' : 'resume', { id: t.id }); } }),
              h('button', { class: 'btn ghost', text: '✕', onClick: (e) => { e.stopPropagation(); this.action('dismiss', { id: t.id }); } }),
            ]));
      if (!finished) el.addEventListener('click', (e) => { if (!e.target.closest('button')) this.select(t.id); });
      list.append(el);
      this.rendered.set(t.id, { remainingEl: remaining, endAt: t.endAt, running: t.running });
    }

    const presets = h('div', { class: 'presets' },
      ...d.presets.map((m) => h('button', { class: 'btn big', text: minutesLabel(m), onClick: () => this.action('start', { minutes: m }) })));

    const steps = (d.steps && d.steps.length ? d.steps : [5, 10, 60]).slice(0, 3);
    const selected = this.selected ? d.timers.find((t) => t.id === this.selected) : null;
    const display = selected
      ? h('div', { class: 'stage adjusting' }, h('span', { class: 'hint', text: 'Adjust' }), h('b', { text: selected.label }))
      : h('div', { class: `stage ${this.staged ? '' : 'empty'}` },
        h('span', { class: 'hint', text: this.staged ? 'New timer' : 'Custom' }),
        h('b', { text: this.staged ? minutesLabel(this.staged) : `Tap + to build a timer` }));

    const adjust = h('div', { class: 'adjust' },
      h('div', { class: 'stage-row' },
        display,
        selected
          ? h('button', { class: 'btn ghost', text: 'Done', onClick: () => this.select(selected.id) })
          : this.staged
            ? [h('button', { class: 'btn ghost', text: '✕', onClick: () => { this.staged = 0; this.render(d); } }),
              h('button', { class: 'btn primary', text: 'Start', onClick: () => { const m = this.staged; this.staged = 0; this.action('start', { minutes: m }); } })]
            : null),
      h('div', { class: 'chips' },
        h('button', { class: 'btn chip minus', text: `−${steps[0]}`, disabled: !selected && this.staged <= 0, onClick: () => this.step(-steps[0], d) }),
        ...steps.map((s) => h('button', { class: 'btn chip', text: `+${s}`, onClick: () => this.step(s, d) }))));

    this.body.replaceChildren(list, presets, adjust);
  }

  // Smooth countdown between service pushes (which only come on state changes).
  onTick() {
    const now = Date.now();
    for (const r of this.rendered.values()) {
      if (r.running && r.endAt) r.remainingEl.textContent = fmt(Math.max(0, r.endAt - now));
    }
  }
}
