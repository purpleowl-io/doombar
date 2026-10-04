'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  status: () => ipcRenderer.invoke('setup:status'),
  save: (name, value) => ipcRenderer.invoke('setup:save', name, value),
  remove: (name) => ipcRenderer.invoke('setup:remove', name),
  testAnthropic: (key) => ipcRenderer.invoke('setup:testAnthropic', key),
  testSlack: (tokens) => ipcRenderer.invoke('setup:testSlack', tokens),
  google: (creds) => ipcRenderer.invoke('setup:google', creds),
  onGoogleUrl: (cb) => { ipcRenderer.on('setup:googleUrl', (_e, url) => cb(url)); },
  importEnv: () => ipcRenderer.invoke('setup:importEnv'),
  open: (url) => ipcRenderer.invoke('setup:open', url),
  openDataDir: () => ipcRenderer.invoke('setup:openDataDir'),
  copy: (text) => ipcRenderer.invoke('setup:copy', text),
  settings: () => ipcRenderer.invoke('setup:settings'),
  saveSettings: (patch) => ipcRenderer.invoke('setup:saveSettings', patch),
  slackChannels: () => ipcRenderer.invoke('setup:slackChannels'),
  googleCalendars: () => ipcRenderer.invoke('setup:googleCalendars'),
});
