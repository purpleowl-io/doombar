'use strict';
// Loads config.json, deep-merges over defaults, watches for edits.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { configPath, projectRoot } = require('./paths');
const { scoped } = require('./log');

const log = scoped('config');

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

class Config extends EventEmitter {
  constructor(file = configPath()) {
    super();
    this.file = file;
    this.defaults = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8'));
    this.data = this.defaults;
    this.watcher = null;
    this.reload();
  }

  reload() {
    try {
      const raw = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : '{}';
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      this.data = merge(this.defaults, parsed);
      this.emit('change', this.data);
      return true;
    } catch (e) {
      log.error('config.json invalid, keeping previous config:', e.message);
      this.emit('error', e);
      return false;
    }
  }

  get(section) { return section ? this.data[section] : this.data; }

  // Write a patch into the user-editable file (not the bundled defaults). Only the
  // keys given are touched, so hand edits elsewhere in the file survive. The
  // watcher picks the write up, but reload() is called too so callers see the new
  // data synchronously.
  save(patch) {
    let current = {};
    try { const raw = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : ''; current = raw.trim() ? JSON.parse(raw) : {}; }
    catch (e) { log.warn('config unreadable, rewriting from defaults:', e.message); }
    const next = merge(current, patch);
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2) + '\n');
    this.reload();
    this.watch();
  }

  watch() {
    if (this.watcher || !fs.existsSync(this.file)) return;
    let timer = null;
    try {
      this.watcher = fs.watch(this.file, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (this.reload()) log.info('config reloaded');
        }, 250);
      });
    } catch (e) {
      log.warn('could not watch config:', e.message);
    }
  }

  close() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }
}

module.exports = { Config, merge };
