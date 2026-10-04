'use strict';
// Owns every service, fans their state out to the renderer over IPC, and
// routes actions back. A service that fails to start becomes an error tile,
// not a crashed app.
const { ipcMain, shell } = require('electron');
const { scoped } = require('../main/log');

const log = scoped('host');

class ServiceHost {
  constructor({ getWindow }) {
    this.getWindow = getWindow;
    this.services = new Map();
    this.virtual = new Map(); // name -> () => state, for config/display pseudo-services
    ipcMain.handle('dashboard:action', (_e, service, name, payload) => this.action(service, name, payload));
    ipcMain.handle('dashboard:snapshot', (_e, service) => this.snapshot(service));
  }

  static openExternal(url) {
    if (!/^(https?|slack|mailto):/i.test(url)) return Promise.reject(new Error('refusing to open ' + url));
    return shell.openExternal(url);
  }

  add(service) {
    this.services.set(service.name, service);
    service.on('state', (s) => this.send(service.name, s));
    return service;
  }

  addVirtual(name, getState, onAction) {
    this.virtual.set(name, { getState, onAction });
  }

  send(name, state) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('dashboard:state', name, state);
  }

  snapshot(name) {
    if (this.virtual.has(name)) return this.virtual.get(name).getState();
    const s = this.services.get(name);
    return s ? s.getState() : { service: name, status: 'error', error: 'no such service', data: {} };
  }

  async action(service, name, payload) {
    try {
      if (this.virtual.has(service)) {
        const v = this.virtual.get(service);
        return v.onAction ? await v.onAction(name, payload) : null;
      }
      const s = this.services.get(service);
      if (!s) throw new Error(`no such service: ${service}`);
      const result = await s.runAction(name, payload);
      return result === undefined ? null : result;
    } catch (e) {
      log.warn(`${service}.${name} failed: ${e.message}`);
      return { error: e.message };
    }
  }

  // Start everything at once so a slow integration (Slack handshake, PowerShell
  // spin-up) never delays the panels that need nothing.
  async startAll() {
    await Promise.all([...this.services.values()].map(async (s) => {
      try {
        await s.start();
      } catch (e) {
        // Service#start catches its own errors, but guard anyway.
        log.error(`${s.name} failed to start:`, e.message);
        s.setStatus('error', e);
      }
    }));
  }

  async stopAll() {
    await Promise.allSettled([...this.services.values()].map((s) => s.stop()));
  }

  setSlow(factor) {
    for (const s of this.services.values()) s.setSlow(factor);
  }
}

module.exports = { ServiceHost };
