'use strict';
// The whole renderer <-> main surface. Exactly two methods, plus nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map(); // service -> Set<cb>

ipcRenderer.on('dashboard:state', (_e, service, state) => {
  const set = listeners.get(service);
  if (!set) return;
  for (const cb of set) {
    try { cb(state); } catch (err) { console.error(`subscriber for ${service} threw`, err); }
  }
});

contextBridge.exposeInMainWorld('dashboard', {
  /**
   * Subscribe to a service's state. The callback fires immediately with the
   * current snapshot and again on every change. Returns an unsubscribe fn.
   */
  subscribe(service, cb) {
    if (!listeners.has(service)) listeners.set(service, new Set());
    listeners.get(service).add(cb);
    ipcRenderer.invoke('dashboard:snapshot', service).then((s) => { if (listeners.get(service)?.has(cb)) cb(s); });
    return () => listeners.get(service)?.delete(cb);
  },
  /** Send an action to a service. Resolves with the action result or {error}. */
  action(service, name, payload) {
    return ipcRenderer.invoke('dashboard:action', service, name, payload ?? {});
  },
});
