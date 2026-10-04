'use strict';
// Minimal .env.local loader. Values already set in process.env win.
// This exists so the dev machine can keep the Anthropic key (and, optionally,
// Slack/Google tokens) in .env.local; `npm run setup -- --from-env` moves them
// into safeStorage for the real install.
const fs = require('node:fs');
const path = require('node:path');

function parse(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(val);
    if (quoted) {
      val = quoted[2];
    } else {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    out[m[1]] = val;
  }
  return out;
}

function load(projectRoot) {
  const loaded = {};
  for (const name of ['.env', '.env.local']) {
    const p = path.join(projectRoot, name);
    if (!fs.existsSync(p)) continue;
    const vars = parse(fs.readFileSync(p, 'utf8'));
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined) {
        process.env[k] = v;
        loaded[k] = v;
      }
    }
  }
  return loaded;
}

function parseFile(file) {
  try { return fs.existsSync(file) ? parse(fs.readFileSync(file, 'utf8')) : {}; } catch { return {}; }
}

module.exports = { parse, parseFile, load };
