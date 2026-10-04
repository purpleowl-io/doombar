'use strict';
// Supervisor for the installed app. Runs as plain Node inside Doombar.exe
// (ELECTRON_RUN_AS_NODE), started by main on an unsupervised packaged launch.
// Spawns the dashboard and restarts it when it crashes, is killed, or stops
// heartbeating. Stands down on a clean quit (exit code 0) and when Windows is
// shutting down or logging off. No Electron requires.
//
// argv: watchdog.js <Doombar.exe> <userData dir> [app args...]
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const [,, exe, dataDir, ...appArgs] = process.argv;
const logDir = path.join(dataDir, 'logs');
const logFile = path.join(logDir, 'watchdog.log');
const heartbeatFile = path.join(dataDir, 'heartbeat');
const sessionEndFile = path.join(dataDir, 'session-end');

const TICK_MS = 10 * 1000;
const HANG_MS = 90 * 1000;          // heartbeat older than this means main is stuck
const START_GRACE_MS = 2 * 60 * 1000;
const WAKE_GRACE_MS = 60 * 1000;    // after sleep/resume, give main time to catch up
const BACKOFF_S = [2, 5, 15, 60, 300];
const BACKOFF_WINDOW_MS = 10 * 60 * 1000;

function log(msg) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    try { if (fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, `${logFile}.old`); } catch { /* none yet */ }
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* nowhere to log */ }
}

// GetSystemMetrics(SM_SHUTTINGDOWN) is the direct answer; the session-end marker
// written by main covers the case where koffi can't load.
let systemShuttingDown = () => false;
try {
  const koffi = require('koffi');
  const GetSystemMetrics = koffi.load('user32.dll').func('int __stdcall GetSystemMetrics(int nIndex)');
  systemShuttingDown = () => GetSystemMetrics(0x2000) !== 0;
} catch (e) {
  log(`koffi unavailable (${e.message}); relying on the session-end marker`);
}

function mtimeAge(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return Infinity; }
}

function sessionEnding() {
  return systemShuttingDown() || mtimeAge(sessionEndFile) < 5 * 60 * 1000;
}

let child = null;
let startedAt = 0;
let lastTick = Date.now();
let lastWake = 0;
let restarts = [];

function start() {
  try { fs.rmSync(sessionEndFile, { force: true }); } catch { /* fine */ }
  const env = { ...process.env, DOOMBAR_SUPERVISED: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(exe, appArgs, { env, stdio: 'ignore', windowsHide: false });
  startedAt = Date.now();
  log(`started dashboard pid ${child.pid}`);
  child.on('error', (e) => log(`spawn failed: ${e.message}`));
  child.on('exit', onExit);
}

function onExit(code, signal) {
  const why = signal ? `signal ${signal}` : `code ${code}`;
  child = null;
  if (code === 0) {
    log(`dashboard quit cleanly (${why}); watchdog done`);
    process.exit(0);
  }
  if (sessionEnding()) {
    log(`dashboard ended (${why}) during shutdown/logoff; not restarting`);
    process.exit(0);
  }
  const now = Date.now();
  restarts = restarts.filter((t) => now - t < BACKOFF_WINDOW_MS);
  const delay = BACKOFF_S[Math.min(restarts.length, BACKOFF_S.length - 1)];
  restarts.push(now);
  log(`dashboard died (${why}); restarting in ${delay}s`);
  setTimeout(() => {
    // A shutdown that started after the crash still wins.
    if (sessionEnding()) { log('shutdown/logoff in progress; not restarting'); process.exit(0); }
    start();
  }, delay * 1000);
}

// Hang check. A long gap between our own ticks means the machine slept, and the
// heartbeat will be stale for reasons that aren't the app's fault.
setInterval(() => {
  const now = Date.now();
  if (now - lastTick > 3 * TICK_MS) lastWake = now;
  lastTick = now;
  if (!child || now - startedAt < START_GRACE_MS || now - lastWake < WAKE_GRACE_MS) return;
  const age = mtimeAge(heartbeatFile);
  if (age < HANG_MS) return;
  log(`no heartbeat for ${Math.round(age / 1000)}s; killing pid ${child.pid}`);
  execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
}, TICK_MS);

log(`watchdog pid ${process.pid} supervising ${exe}`);
start();
