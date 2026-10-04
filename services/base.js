'use strict';
// Every integration is a Service with the same shape:
//   start(), stop(), getState(), events ('state', 'status'), actions map.
// Services never touch the DOM. The renderer only sees getState() snapshots.
const { EventEmitter } = require('node:events');
const { scoped } = require('../main/log');

const STATUS = ['connected', 'stale', 'error', 'disabled', 'starting'];

class Service extends EventEmitter {
  /**
   * @param {string} name        panel/service id ("slack", "system", ...)
   * @param {object} opts
   * @param {object} opts.config   full config object (Config#get())
   * @param {object} [opts.db]     shared Db
   * @param {number} [opts.pollMs] nominal poll interval, used for staleness (3x)
   */
  constructor(name, opts = {}) {
    super();
    this.name = name;
    this.config = opts.config || {};
    this.db = opts.db || null;
    this.pollMs = opts.pollMs || 0;
    this.log = scoped(name);
    this.state = {};
    this.status = 'starting';
    this.error = null;
    this.lastUpdated = 0;
    this.running = false;
    this.slowFactor = 1;
    this.actions = {};
    this._timers = new Set();
    this._backoffMs = 0;
    this._staleTimer = null;
  }

  // --- lifecycle -----------------------------------------------------------

  async start() {
    if (this.running) return;
    this.running = true;
    this.setStatus('starting');
    try {
      await this.onStart();
    } catch (e) {
      this.fail(e);
    }
    this._armStaleCheck();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    clearTimeout(this._staleTimer);
    try { await this.onStop(); } catch (e) { this.log.warn('stop failed:', e.message); }
  }

  async onStart() {}
  async onStop() {}

  // Called by the display schedule when the panel is blanked (factor > 1) or restored (1).
  setSlow(factor) {
    this.slowFactor = Math.max(1, factor || 1);
  }

  // --- state ---------------------------------------------------------------

  getState() {
    return {
      service: this.name,
      status: this.status,
      error: this.error,
      lastUpdated: this.lastUpdated,
      data: this.state,
    };
  }

  setState(patch, { touch = true } = {}) {
    this.state = typeof patch === 'function' ? patch(this.state) : { ...this.state, ...patch };
    if (touch) {
      this.lastUpdated = Date.now();
      if (this.status === 'stale' || this.status === 'starting') this.setStatus('connected');
      this._backoffMs = 0;
      this.error = null;
    }
    this.emit('state', this.getState());
  }

  setStatus(status, error = null) {
    if (!STATUS.includes(status)) throw new Error(`bad status ${status}`);
    const changed = status !== this.status || error !== this.error;
    this.status = status;
    this.error = error ? String(error.message || error) : null;
    if (changed) {
      this.log.info(`status -> ${status}${this.error ? ` (${this.error})` : ''}`);
      this.emit('status', status, this.error);
      this.emit('state', this.getState());
    }
  }

  fail(e) {
    this.log.error(e && e.stack ? e.stack.split('\n')[0] : String(e));
    this.setStatus('error', e);
  }

  disable(reason) {
    this.setStatus('disabled', reason);
  }

  // --- actions -------------------------------------------------------------

  async runAction(name, payload) {
    const fn = this.actions[name];
    if (!fn) throw new Error(`${this.name}: unknown action "${name}"`);
    return fn.call(this, payload || {});
  }

  actionNames() { return Object.keys(this.actions); }

  // --- scheduling helpers --------------------------------------------------

  /**
   * Run fn now and then every `ms` (scaled by slowFactor). Errors mark the
   * service as error and back off exponentially up to 10x the interval.
   * Returns a cancel function.
   */
  poll(fn, ms, { immediate = true } = {}) {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || !this.running) return;
      let delay = ms * this.slowFactor;
      try {
        await fn();
      } catch (e) {
        this.fail(e);
        this._backoffMs = Math.min(this._backoffMs ? this._backoffMs * 2 : ms, ms * 10);
        delay = this._backoffMs;
      }
      if (cancelled || !this.running) return;
      const t = setTimeout(() => { this._timers.delete(t); tick(); }, delay);
      this._timers.add(t);
    };
    if (immediate) tick();
    else {
      const t = setTimeout(() => { this._timers.delete(t); tick(); }, ms);
      this._timers.add(t);
    }
    return () => { cancelled = true; };
  }

  after(ms, fn) {
    const t = setTimeout(() => { this._timers.delete(t); fn(); }, ms);
    this._timers.add(t);
    return t;
  }

  _armStaleCheck() {
    if (!this.pollMs) return;
    const check = () => {
      if (!this.running) return;
      const limit = this.pollMs * 3 * this.slowFactor;
      if (this.status === 'connected' && this.lastUpdated && Date.now() - this.lastUpdated > limit) {
        this.setStatus('stale');
      }
      this._staleTimer = setTimeout(check, Math.max(250, this.pollMs));
    };
    this._staleTimer = setTimeout(check, Math.max(250, this.pollMs));
  }
}

module.exports = { Service, STATUS };
