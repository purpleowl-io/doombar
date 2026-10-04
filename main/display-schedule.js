'use strict';
// Business hours: keep the display awake, blank to black after N minutes of
// system idle, wake on any input. Off hours: hands off, let Windows decide.
// Blanked is an app state; services keep polling at a reduced rate.
const { EventEmitter } = require('node:events');
const { powerMonitor, powerSaveBlocker } = require('electron');
const tz = require('../services/tz');
const { scoped } = require('../main/log');

const log = scoped('display');
const CHECK_MS = 30 * 1000;

class DisplaySchedule extends EventEmitter {
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    this.blanked = false;
    this.business = null;
    this.blockerId = null;
    this.timer = null;
    this.lastRendererActivity = Date.now();
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), CHECK_MS);
    powerMonitor.on('resume', () => this.wake('resume'));
    powerMonitor.on('unlock-screen', () => this.wake('unlock'));
  }

  stop() {
    clearInterval(this.timer);
    this.releaseBlocker();
  }

  cfg() { return this.getConfig().display || {}; }

  getState() {
    return { blanked: this.blanked, businessHours: !!this.business, keepAwake: this.blockerId != null };
  }

  // Renderer reports pointer events; used as a second opinion on idle time.
  activity() {
    this.lastRendererActivity = Date.now();
    if (this.blanked) this.wake('touch');
  }

  tick() {
    const c = this.cfg();
    const business = tz.isBusinessHours(new Date(), c.timezone || 'America/Phoenix', c.businessHours);
    if (business !== this.business) {
      this.business = business;
      log.info(business ? 'entering business hours' : 'leaving business hours');
    }

    if (!business) {
      this.releaseBlocker();
      if (this.blanked) this.setBlanked(false);
      this.emit('state', this.getState());
      return;
    }

    const idleSec = Math.min(powerMonitor.getSystemIdleTime(), Math.floor((Date.now() - this.lastRendererActivity) / 1000));
    const limit = (c.blankAfterIdleMinutes || 30) * 60;
    if (idleSec >= limit && !this.blanked) this.setBlanked(true);
    else if (idleSec < limit && this.blanked) this.setBlanked(false);

    if (this.blanked) this.releaseBlocker(); else this.holdBlocker();
    this.emit('state', this.getState());
  }

  wake(reason) {
    if (!this.blanked) return;
    log.info('wake:', reason);
    this.setBlanked(false);
    this.holdBlocker();
    this.emit('state', this.getState());
  }

  setBlanked(v) {
    this.blanked = v;
    log.info(v ? 'blanking display' : 'restoring display');
    this.emit('blanked', v);
  }

  holdBlocker() {
    if (this.blockerId == null) this.blockerId = powerSaveBlocker.start('prevent-display-sleep');
  }

  releaseBlocker() {
    if (this.blockerId != null && powerSaveBlocker.isStarted(this.blockerId)) powerSaveBlocker.stop(this.blockerId);
    this.blockerId = null;
  }
}

module.exports = { DisplaySchedule };
