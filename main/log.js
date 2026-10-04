'use strict';
// electron-log inside Electron, console otherwise. Never log bodies or tokens.
const { isElectron } = require('./paths');

let impl;
if (isElectron()) {
  try {
    const log = require('electron-log/main');
    log.initialize();
    log.transports.file.maxSize = 2 * 1024 * 1024;
    log.transports.file.level = 'info';
    log.transports.console.level = process.env.DOOMBAR_DEBUG ? 'debug' : 'info';
    impl = log;
  } catch {
    impl = null;
  }
}
if (!impl) {
  const quiet = process.argv.includes('--dump') && !process.env.DOOMBAR_DEBUG;
  const w = (level) => (...args) => {
    if (quiet && level !== 'error') return;
    (level === 'error' || level === 'warn' ? console.error : console.log)(`[${level}]`, ...args);
  };
  impl = { debug: w('debug'), info: w('info'), warn: w('warn'), error: w('error'), scope: () => impl };
}

function scoped(name) {
  const s = impl.scope ? impl.scope(name) : impl;
  return {
    debug: (...a) => s.debug(...a),
    info: (...a) => s.info(...a),
    warn: (...a) => s.warn(...a),
    error: (...a) => s.error(...a),
  };
}

module.exports = { log: impl, scoped };
