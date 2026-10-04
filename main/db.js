'use strict';
// One SQLite file via node:sqlite (built into Node 22.13+ and Electron 44's Node 24).
// Chosen over better-sqlite3 so the same code runs under Electron and plain Node
// without an ABI rebuild.
const { dbPath } = require('./paths');

// Node 22 still prints an ExperimentalWarning for node:sqlite; silence just that one.
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === 'string' ? warning : warning && warning.message;
  if (msg && /SQLite is an experimental feature/.test(msg)) return;
  return origEmit.call(process, warning, ...rest);
};

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS timers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  end_at INTEGER,
  paused_remaining_ms INTEGER,
  total_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  fired INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS slack_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_summaries (
  message_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seen (
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (scope, id)
);
`;

let instance = null;

class Db {
  constructor(file = dbPath()) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.raw.exec(SCHEMA);
    this._stmts = new Map();
  }

  prepare(sql) {
    let s = this._stmts.get(sql);
    if (!s) { s = this.raw.prepare(sql); this._stmts.set(sql, s); }
    return s;
  }

  run(sql, ...params) { return this.prepare(sql).run(...params); }
  get(sql, ...params) { return this.prepare(sql).get(...params); }
  all(sql, ...params) { return this.prepare(sql).all(...params); }

  // Simple key/value with JSON values.
  kvGet(key, fallback = undefined) {
    const row = this.get('SELECT value FROM kv WHERE key = ?', key);
    return row ? JSON.parse(row.value) : fallback;
  }
  kvSet(key, value) {
    this.run(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key, JSON.stringify(value), Date.now(),
    );
  }
  kvDelete(key) { this.run('DELETE FROM kv WHERE key = ?', key); }

  markSeen(scope, id) {
    this.run('INSERT OR REPLACE INTO seen (scope, id, seen_at) VALUES (?, ?, ?)', scope, id, Date.now());
  }
  isSeen(scope, id) {
    return !!this.get('SELECT 1 AS x FROM seen WHERE scope = ? AND id = ?', scope, id);
  }

  close() { this.raw.close(); if (instance === this) instance = null; }
}

function open(file) {
  if (!instance) instance = new Db(file);
  return instance;
}

module.exports = { Db, open };
