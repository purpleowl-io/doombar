'use strict';
// Keeps the physical mouse off the touch strip via scripts/mouse-fence.ps1 (a
// low-level mouse hook in its own process, so a busy main thread can't stall the
// system cursor). Touch still reaches the strip. Windows only.
const { spawn } = require('node:child_process');
const { scoped } = require('./log');
const { unpackedPath } = require('./paths');

const log = scoped('mouse-fence');

class MouseFence {
  constructor() {
    this.proc = null;
    this.rect = null; // physical px { x, y, width, height }
    this.closed = false;
    this.restarts = 0;
  }

  set(rect) {
    this.rect = rect;
    if (this.proc) this.send();
    else this.start();
  }

  off() {
    this.rect = null;
    if (this.proc) this.send();
  }

  start() {
    if (process.platform !== 'win32' || this.closed) return;
    const script = unpackedPath('scripts', 'mouse-fence.ps1');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (s) => {
      for (const line of s.split(/\r?\n/).filter(Boolean)) {
        if (line === 'ready') { this.restarts = 0; log.info('fencing', this.describe()); }
        else log.warn(line);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (s) => log.warn(s.trim()));
    proc.on('error', (e) => log.warn('spawn failed:', e.message));
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      if (this.closed) return;
      log.warn('helper exited', code);
      if (this.rect && this.restarts++ < 5) setTimeout(() => { if (!this.proc && this.rect) this.start(); }, 5000);
    });
    this.send();
  }

  send() {
    const r = this.rect;
    const line = r ? `${r.x} ${r.y} ${r.x + r.width} ${r.y + r.height}` : 'off';
    try { this.proc.stdin.write(line + '\n'); } catch { /* exit handler restarts */ }
  }

  describe() {
    const r = this.rect;
    return r ? `${r.width}x${r.height} at ${r.x},${r.y}` : 'off';
  }

  close() {
    this.closed = true;
    if (this.proc) { try { this.proc.stdin.end(); } catch { /* ignore */ } this.proc.kill(); }
  }
}

module.exports = { MouseFence };
