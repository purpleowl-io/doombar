'use strict';
// Where things live. Works both inside Electron and under plain Node
// (for `node services/x.js --dump` and tests).
const path = require('node:path');
const fs = require('node:fs');

const projectRoot = path.resolve(__dirname, '..');

function isElectron() {
  return !!(process.versions && process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE);
}

function dataDir() {
  if (process.env.DOOMBAR_DATA) return process.env.DOOMBAR_DATA;
  if (isElectron()) {
    try {
      const { app } = require('electron');
      if (app && app.getPath) return app.getPath('userData');
    } catch { /* fall through */ }
  }
  return path.join(projectRoot, 'data');
}

function isPackaged() {
  if (!isElectron()) return false;
  try { return !!require('electron').app.isPackaged; } catch { return false; }
}

// Files that must exist as real files on disk (spawned scripts) live outside the asar.
function unpackedPath(...parts) {
  const root = projectRoot.includes('app.asar') ? projectRoot.replace('app.asar', 'app.asar.unpacked') : projectRoot;
  return path.join(root, ...parts);
}

// Hand-edited config lives next to the database when packaged; in the repo during dev.
function configPath() {
  if (process.env.DOOMBAR_CONFIG) return process.env.DOOMBAR_CONFIG;
  if (!isPackaged()) return path.join(projectRoot, 'config.json');
  const target = path.join(ensureDataDir(), 'config.json');
  if (!fs.existsSync(target)) fs.copyFileSync(path.join(projectRoot, 'config.json'), target);
  return target;
}

function ensureDataDir() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  projectRoot,
  isElectron,
  dataDir,
  ensureDataDir,
  isPackaged,
  unpackedPath,
  configPath,
  dbPath: () => path.join(ensureDataDir(), 'doombar.sqlite'),
  secretsPath: () => path.join(ensureDataDir(), 'secrets.json'),
};
