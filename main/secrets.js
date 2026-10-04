'use strict';
// Secret storage. Lookup order:
//   1. process.env (populated from .env.local by main/env.js) - dev convenience
//   2. secrets.json in the data dir, each value encrypted with Electron safeStorage
// Plain Node (standalone --dump) can only see (1).
const fs = require('node:fs');
const { secretsPath, isElectron } = require('./paths');

const NAMES = [
  'ANTHROPIC_API_KEY',
  'SLACK_APP_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
  'MICROSOFT_CLIENT_ID',
];
// Per-account refresh tokens (services/accounts.js) are stored as TOKEN_<ID>.

function safeStorage() {
  if (!isElectron()) return null;
  try {
    const { safeStorage: ss } = require('electron');
    return ss && ss.isEncryptionAvailable() ? ss : null;
  } catch { return null; }
}

function readFile() {
  const p = secretsPath();
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function writeFile(obj) {
  fs.writeFileSync(secretsPath(), JSON.stringify(obj, null, 2), { mode: 0o600 });
}

const cache = new Map();

// fresh: re-read the file, for tokens another process (the setup window) may have replaced.
function get(name, { fresh = false } = {}) {
  if (process.env[name]) return process.env[name];
  if (cache.has(name) && !fresh) return cache.get(name);
  const ss = safeStorage();
  if (!ss) return undefined;
  const entry = readFile()[name];
  if (!entry) return undefined;
  try {
    const val = ss.decryptString(Buffer.from(entry, 'base64'));
    cache.set(name, val);
    return val;
  } catch { return undefined; }
}

// Why safeStorage cannot be used right now, or null when it can.
function unavailableReason() {
  if (!isElectron()) return 'safeStorage only exists inside the Electron runtime (run via `electron`, not `node`)';
  const { safeStorage: ss } = require('electron');
  if (ss.isEncryptionAvailable()) return null;
  const backend = process.platform === 'linux' && ss.getSelectedStorageBackend ? ss.getSelectedStorageBackend() : 'unknown';
  if (backend === 'basic_text') return 'no OS keyring on this Linux box (gnome-keyring/kwallet not running), so Electron cannot encrypt';
  return `OS encryption backend unavailable (${backend})`;
}

function set(name, value) {
  const ss = safeStorage();
  if (!ss) throw new Error(`cannot store ${name}: ${unavailableReason()}`);
  const all = readFile();
  all[name] = ss.encryptString(String(value)).toString('base64');
  writeFile(all);
  cache.set(name, String(value));
}

function remove(name) {
  const all = readFile();
  delete all[name];
  writeFile(all);
  cache.delete(name);
}

function has(name) { return !!get(name); }

// Which names are set, and from where. Never returns values.
function status() {
  const stored = readFile();
  const out = {};
  for (const n of NAMES) {
    out[n] = process.env[n] ? 'env' : stored[n] ? 'safeStorage' : null;
  }
  return out;
}

module.exports = { NAMES, get, set, remove, has, status, unavailableReason };
