'use strict';
// Countdown timers. End timestamps (not remaining seconds) are persisted so a
// restart mid-timer resumes correctly. Ticks only while something is running.
const crypto = require('node:crypto');
const { Service } = require('./base');

const TICK_MS = 250;

class TimersService extends Service {
  constructor(opts) {
    const cfg = (opts.config && opts.config.timers) || {};
    super('timers', { ...opts, pollMs: 0 });
    this.cfg = cfg;
    this.notify = opts.notify || null; // (title, body) => void, injected by main
    this.tickHandle = null;
    this.state = { timers: [], presets: cfg.presets || [5, 15, 25, 50], steps: cfg.steps || [5, 10, 60], sound: cfg.sound !== false, firedIds: [] };
  }

  async onStart() {
    if (!this.db) throw new Error('timers need a database');
    this.publish();
    this.ensureTicking();
    this.setStatus('connected');
  }

  async onStop() {
    clearInterval(this.tickHandle);
    this.tickHandle = null;
  }

  rows() {
    return this.db.all('SELECT * FROM timers ORDER BY created_at ASC');
  }

  toView(r, now) {
    const running = r.end_at != null;
    const remaining = running ? Math.max(0, r.end_at - now) : r.paused_remaining_ms;
    return {
      id: r.id,
      label: r.label,
      totalMs: r.total_ms,
      remainingMs: remaining,
      running,
      done: running && remaining === 0,
      fired: !!r.fired,
      endAt: r.end_at,
    };
  }

  publish() {
    const now = Date.now();
    const timers = this.rows().map((r) => this.toView(r, now));
    this.setState({ timers, presets: this.cfg.presets || [5, 15, 25, 50], steps: this.cfg.steps || [5, 10, 60] });
  }

  ensureTicking() {
    const anyRunning = this.rows().some((r) => r.end_at != null && !r.fired);
    if (anyRunning && !this.tickHandle) {
      this.tickHandle = setInterval(() => this.tick(), TICK_MS);
    } else if (!anyRunning && this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  tick() {
    const now = Date.now();
    const justFired = [];
    for (const r of this.rows()) {
      if (r.end_at != null && !r.fired && r.end_at <= now) {
        this.db.run('UPDATE timers SET fired = 1 WHERE id = ?', r.id);
        justFired.push(r);
      }
    }
    for (const r of justFired) {
      this.log.info(`timer fired: ${r.label}`);
      if (this.notify) {
        try { this.notify('Timer done', r.label); } catch (e) { this.log.warn('notify failed:', e.message); }
      }
    }
    this.state.firedIds = justFired.map((r) => r.id);
    this.publish();
    this.state.firedIds = [];
    this.ensureTicking();
  }

  actions = {
    start: async ({ minutes, seconds, label }) => {
      const ms = Math.round(((Number(minutes) || 0) * 60 + (Number(seconds) || 0)) * 1000);
      if (ms <= 0) throw new Error('duration must be positive');
      const id = crypto.randomUUID();
      const now = Date.now();
      this.db.run(
        'INSERT INTO timers (id, label, end_at, paused_remaining_ms, total_ms, created_at, fired) VALUES (?, ?, ?, NULL, ?, ?, 0)',
        id, label || formatLabel(ms), now + ms, ms, now,
      );
      this.publish();
      this.ensureTicking();
      return { id };
    },
    startDefault: async () => {
      const m = this.cfg.defaultPresetMinutes || (this.cfg.presets || [25])[0];
      return this.actions.start.call(this, { minutes: m });
    },
    pause: async ({ id }) => {
      const r = this.db.get('SELECT * FROM timers WHERE id = ?', id);
      if (!r || r.end_at == null) return;
      const remaining = Math.max(0, r.end_at - Date.now());
      this.db.run('UPDATE timers SET end_at = NULL, paused_remaining_ms = ? WHERE id = ?', remaining, id);
      this.publish();
      this.ensureTicking();
    },
    resume: async ({ id }) => {
      const r = this.db.get('SELECT * FROM timers WHERE id = ?', id);
      if (!r || r.end_at != null) return;
      this.db.run('UPDATE timers SET end_at = ?, paused_remaining_ms = NULL, fired = 0 WHERE id = ?', Date.now() + (r.paused_remaining_ms || 0), id);
      this.publish();
      this.ensureTicking();
    },
    // Positive or negative minutes. Remaining never drops below zero; a timer
    // brought to zero fires on the next tick like any other.
    add: async ({ id, minutes = 5 }) => {
      const r = this.db.get('SELECT * FROM timers WHERE id = ?', id);
      if (!r) return;
      const delta = Number(minutes) * 60 * 1000;
      if (!Number.isFinite(delta) || !delta) return;
      const now = Date.now();
      if (r.end_at != null) {
        const remaining = Math.max(0, Math.max(r.end_at, now) - now + delta);
        this.db.run('UPDATE timers SET end_at = ?, total_ms = MAX(?, total_ms + ?), fired = 0 WHERE id = ?', now + remaining, remaining, delta, id);
      } else {
        const remaining = Math.max(0, (r.paused_remaining_ms || 0) + delta);
        this.db.run('UPDATE timers SET paused_remaining_ms = ?, total_ms = MAX(?, total_ms + ?) WHERE id = ?', remaining, remaining, delta, id);
      }
      this.publish();
      this.ensureTicking();
    },
    dismiss: async ({ id }) => {
      this.db.run('DELETE FROM timers WHERE id = ?', id);
      this.publish();
      this.ensureTicking();
    },
  };
}

function formatLabel(ms) {
  const m = Math.round(ms / 60000);
  if (m >= 60 && m % 60 === 0) return `${m / 60} hr`;
  if (m >= 1) return `${m} min`;
  return `${Math.round(ms / 1000)} sec`;
}

module.exports = { TimersService };

if (require.main === module) {
  require('./standalone').runStandalone(TimersService, { waitMs: 1500 });
}
