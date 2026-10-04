'use strict';
// System panel: CPU (total + per-core history), RAM, GPU via nvidia-smi,
// disk, network rates. No auth, so it is the first thing to
// verify end to end.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const { Service } = require('./base');

const execFileP = promisify(execFile);
const HISTORY_SECONDS = 60;

class SystemService extends Service {
  constructor(opts) {
    const cfg = (opts.config && opts.config.system) || {};
    super('system', { ...opts, pollMs: (cfg.pollSeconds || 2) * 1000 });
    this.cfg = cfg;
    this.si = null;
    this.gpuAvailable = cfg.gpu !== false;
    this.gpuFailures = 0;
    this.state = {
      cpu: { total: 0, cores: [], history: [] },
      mem: { used: 0, total: 0, percent: 0 },
      gpu: null,
      disks: [],
      net: { rxSec: 0, txSec: 0, iface: '', history: [] },
      thresholds: cfg.thresholds || {},
      platform: process.platform,
      hostname: os.hostname(),
    };
  }

  async onStart() {
    this.si = require('systeminformation');
    const fast = this.pollMs;
    const slow = (this.cfg.diskPollSeconds || 30) * 1000;
    this.poll(() => this.tickFast(), fast);
    this.poll(() => this.tickDisk(), slow);
  }

  async tickFast() {
    const [load, mem, net, gpu] = await Promise.all([
      this.si.currentLoad(),
      this.si.mem(),
      this.si.networkStats().catch(() => []),
      this.readGpu(),
    ]);

    const historyLen = Math.ceil((HISTORY_SECONDS * 1000) / this.pollMs);
    const total = Math.round(load.currentLoad * 10) / 10;
    const history = [...(this.state.cpu.history || []), total].slice(-historyLen);
    const cores = (load.cpus || []).map((c) => Math.round(c.load));

    const active = (net || []).filter((n) => n.operstate === 'up' || n.rx_sec > 0 || n.tx_sec > 0);
    const primary = active.sort((a, b) => (b.rx_sec + b.tx_sec) - (a.rx_sec + a.tx_sec))[0] || net[0] || {};

    if (gpu) gpu.history = [...((this.state.gpu && this.state.gpu.history) || []), gpu.utilization].slice(-historyLen);

    const rxSec = Math.max(0, primary.rx_sec || 0);
    const txSec = Math.max(0, primary.tx_sec || 0);
    const netHistory = [...(this.state.net.history || []), [Math.round(rxSec), Math.round(txSec)]].slice(-historyLen);

    const used = mem.total - mem.available;
    this.setState({
      cpu: { total, cores, history },
      mem: { used, total: mem.total, percent: Math.round((used / mem.total) * 100) },
      gpu,
      net: { rxSec, txSec, iface: primary.iface || '', history: netHistory },
    });
  }

  async tickDisk() {
    const fs = await this.si.fsSize();
    const disks = fs
      .filter((d) => d.size > 10 * 1024 * 1024 * 1024) // skip small/system partitions
      .filter((d) => !['none', 'tmpfs', 'overlay', '9p'].includes(d.fs))
      .filter((d) => !/^\/(boot|snap|run|dev|sys|proc|usr\/lib)/.test(d.mount))
      .map((d) => ({ mount: d.mount, fs: d.fs, size: d.size, used: d.used, percent: Math.round(d.use) }))
      .slice(0, 4);
    this.setState({ disks }, { touch: false });
  }

  async readGpu() {
    if (!this.gpuAvailable) return this.state.gpu;
    try {
      const { stdout } = await execFileP('nvidia-smi', [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,fan.speed',
        '--format=csv,noheader,nounits',
      ], { timeout: 1500, windowsHide: true });
      const line = stdout.trim().split('\n')[0] || '';
      const [name, util, memUsed, memTotal, temp, power, fan] = line.split(',').map((s) => s.trim());
      this.gpuFailures = 0;
      return {
        name,
        utilization: Number(util) || 0,
        memUsedMb: Number(memUsed) || 0,
        memTotalMb: Number(memTotal) || 0,
        temperature: Number(temp) || 0,
        // "[N/A]" on cards that do not report these; null hides them.
        powerW: Number.isFinite(Number(power)) ? Math.round(Number(power)) : null,
        fan: Number.isFinite(Number(fan)) ? Number(fan) : null,
      };
    } catch (e) {
      // nvidia-smi missing (this box) or GPU busy: stop trying after a few misses.
      if (++this.gpuFailures >= 3) {
        this.gpuAvailable = false;
        this.log.info('nvidia-smi unavailable, GPU stats disabled:', e.code || e.message);
      }
      return null;
    }
  }

  actions = {
    // Read-only panel: the only action opens Task Manager. No kill; a mis-tap on a
    // touch strip is too easy and the damage is not reversible.
    openTaskManager: async () => {
      if (process.platform !== 'win32') return { ok: false, reason: 'not windows' };
      execFile('taskmgr.exe', { windowsHide: false }, () => {});
      return { ok: true };
    },
  };
}

module.exports = { SystemService };

if (require.main === module) {
  require('./standalone').runStandalone(SystemService);
}
