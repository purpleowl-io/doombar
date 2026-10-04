'use strict';
// Audio panel v1: master volume + mute (read/write) and media transport.
// Windows only. Two backends behind one interface so the panel never cares:
//   1. PowerShell (default): scripts/win-audio.ps1 kept alive as a JSON-lines child process
//   2. koffi (opt-in): Win32 keybd_event for keys, IAudioEndpointVolume via COM vtable calls
// The v2 C# sidecar (per-app sessions, now-playing) slots in as a third backend.
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { Service } = require('./base');
const { unpackedPath } = require('../main/paths');

const VK = { PLAY_PAUSE: 0xB3, NEXT: 0xB0, PREV: 0xB1, VOL_UP: 0xAF, VOL_DOWN: 0xAE, VOL_MUTE: 0xAD };

// ---------------------------------------------------------------------------
// Backend 1: koffi
class KoffiBackend {
  constructor(log) {
    this.log = log;
    const koffi = require('koffi');
    this.koffi = koffi;
    const user32 = koffi.load('user32.dll');
    const ole32 = koffi.load('ole32.dll');
    this.keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');

    this.GUID = koffi.struct('DB_GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8) });
    const CoInitializeEx = ole32.func('int32_t __stdcall CoInitializeEx(void *pvReserved, uint32_t dwCoInit)');
    this.CoCreateInstance = ole32.func('int32_t __stdcall CoCreateInstance(const DB_GUID *rclsid, void *pUnkOuter, uint32_t dwClsContext, const DB_GUID *riid, _Out_ void **ppv)');
    this.PropVariantClear = ole32.func('int32_t __stdcall PropVariantClear(void *pvar)');
    CoInitializeEx(null, 0x0); // COINIT_MULTITHREADED; S_FALSE if already initialised is fine

    // COM method prototypes (self pointer first). __stdcall is a no-op on x64.
    this.protos = {
      Release: koffi.proto('uint32_t __stdcall Release(void *self)'),
      GetDefaultAudioEndpoint: koffi.proto('int32_t __stdcall GetDefaultAudioEndpoint(void *self, int dataFlow, int role, _Out_ void **device)'),
      Activate: koffi.proto('int32_t __stdcall Activate(void *self, const DB_GUID *iid, uint32_t clsCtx, void *params, _Out_ void **iface)'),
      OpenPropertyStore: koffi.proto('int32_t __stdcall OpenPropertyStore(void *self, uint32_t access, _Out_ void **store)'),
      GetValue: koffi.proto('int32_t __stdcall GetValue(void *self, const void *key, void *propvariant)'),
      GetMasterVolumeLevelScalar: koffi.proto('int32_t __stdcall GetMasterVolumeLevelScalar(void *self, _Out_ float *level)'),
      SetMasterVolumeLevelScalar: koffi.proto('int32_t __stdcall SetMasterVolumeLevelScalar(void *self, float level, const DB_GUID *ctx)'),
      GetMute: koffi.proto('int32_t __stdcall GetMute(void *self, _Out_ int32_t *mute)'),
      SetMute: koffi.proto('int32_t __stdcall SetMute(void *self, int32_t mute, const DB_GUID *ctx)'),
    };
    this.CLSID_MMDeviceEnumerator = this.guid('BCDE0395-E52F-467C-8E3D-C4579291692E');
    this.IID_IMMDeviceEnumerator = this.guid('A95664D2-9614-4F35-A746-DE8DB63617E6');
    this.IID_IAudioEndpointVolume = this.guid('5CDF2C82-841E-4546-9722-0CF74078229A');
    this.endpoint = null;
    this.deviceName = '';
    this.acquire();
  }

  guid(str) {
    const [a, b, c, d, e] = str.split('-');
    const tail = d + e;
    return {
      Data1: parseInt(a, 16), Data2: parseInt(b, 16), Data3: parseInt(c, 16),
      Data4: Array.from({ length: 8 }, (_, i) => parseInt(tail.slice(i * 2, i * 2 + 2), 16)),
    };
  }

  // Call vtable slot `index` on COM object `obj` with the given proto.
  method(obj, index, proto) {
    const vtbl = this.koffi.decode(obj, 'void *');
    const fnPtr = this.koffi.decode(vtbl, index * 8, 'void *');
    return this.koffi.decode(fnPtr, proto);
  }

  check(hr, what) {
    if (hr < 0) throw new Error(`${what} failed: HRESULT 0x${(hr >>> 0).toString(16)}`);
  }

  release(obj) {
    try { this.method(obj, 2, this.protos.Release)(obj); } catch { /* ignore */ }
  }

  acquire() {
    if (this.endpoint) { this.release(this.endpoint); this.endpoint = null; }
    const out = [null];
    this.check(this.CoCreateInstance(this.CLSID_MMDeviceEnumerator, null, 23 /* CLSCTX_ALL */, this.IID_IMMDeviceEnumerator, out), 'CoCreateInstance');
    const enumerator = out[0];
    try {
      const dev = [null];
      this.check(this.method(enumerator, 4, this.protos.GetDefaultAudioEndpoint)(enumerator, 0 /* eRender */, 1 /* eMultimedia */, dev), 'GetDefaultAudioEndpoint');
      const device = dev[0];
      try {
        const vol = [null];
        this.check(this.method(device, 3, this.protos.Activate)(device, this.IID_IAudioEndpointVolume, 23, null, vol), 'Activate');
        this.endpoint = vol[0];
        this.deviceName = this.readDeviceName(device);
      } finally { this.release(device); }
    } finally { this.release(enumerator); }
  }

  readDeviceName(device) {
    try {
      const store = [null];
      this.check(this.method(device, 4, this.protos.OpenPropertyStore)(device, 0 /* STGM_READ */, store), 'OpenPropertyStore');
      const ps = store[0];
      try {
        // PROPERTYKEY = GUID (16) + DWORD pid (PKEY_Device_FriendlyName, pid 14)
        const key = Buffer.alloc(20);
        const g = this.guid('A45C254E-DF1C-4EFD-8020-67D146A850E0');
        key.writeUInt32LE(g.Data1, 0); key.writeUInt16LE(g.Data2, 4); key.writeUInt16LE(g.Data3, 6);
        for (let i = 0; i < 8; i++) key.writeUInt8(g.Data4[i], 8 + i);
        key.writeUInt32LE(14, 16);
        const pv = Buffer.alloc(24);
        this.check(this.method(ps, 5, this.protos.GetValue)(ps, key, pv), 'GetValue');
        let name = '';
        if (pv.readUInt16LE(0) === 31 /* VT_LPWSTR */) {
          const strPtr = this.koffi.decode(pv, 8, 'void *');
          name = this.koffi.decode(strPtr, 'char16_t *');
        }
        this.PropVariantClear(pv);
        return name;
      } finally { this.release(ps); }
    } catch (e) {
      this.log.debug('device name unavailable:', e.message);
      return '';
    }
  }

  withRetry(fn) {
    try { return fn(); }
    catch (e) {
      // Default device changed or endpoint went away: re-acquire once.
      this.log.debug('endpoint call failed, re-acquiring:', e.message);
      this.acquire();
      return fn();
    }
  }

  get() {
    return this.withRetry(() => {
      const level = [0];
      this.check(this.method(this.endpoint, 9, this.protos.GetMasterVolumeLevelScalar)(this.endpoint, level), 'GetMasterVolumeLevelScalar');
      const mute = [0];
      this.check(this.method(this.endpoint, 15, this.protos.GetMute)(this.endpoint, mute), 'GetMute');
      return { volume: level[0], mute: !!mute[0], device: this.deviceName };
    });
  }

  set(volume) {
    this.withRetry(() => this.check(this.method(this.endpoint, 7, this.protos.SetMasterVolumeLevelScalar)(this.endpoint, volume, null), 'SetMasterVolumeLevelScalar'));
  }

  mute(on) {
    this.withRetry(() => this.check(this.method(this.endpoint, 14, this.protos.SetMute)(this.endpoint, on ? 1 : 0, null), 'SetMute'));
  }

  key(vk) {
    this.keybd_event(vk, 0, 0x1 /* EXTENDEDKEY */, 0);
    this.keybd_event(vk, 0, 0x3 /* EXTENDEDKEY | KEYUP */, 0);
  }

  close() { if (this.endpoint) this.release(this.endpoint); this.endpoint = null; }
}

// ---------------------------------------------------------------------------
// Backend 2: PowerShell child process
class PowerShellBackend {
  constructor(log) {
    this.log = log;
    this.queue = [];
    this.ready = false;
    const script = unpackedPath('scripts', 'win-audio.ps1');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.on('exit', (code) => { this.log.warn('powershell audio helper exited', code); this.proc = null; this.flush(new Error('helper exited')); });
    this.proc.stderr.on('data', (d) => this.log.debug('ps:', String(d).trim()));
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) { this.ready = true; this.readyResolve && this.readyResolve(); return; }
      const pending = this.queue.shift();
      if (!pending) return;
      if (msg.ok) pending.resolve(msg); else pending.reject(new Error(msg.error || 'helper error'));
    });
    this.readyPromise = new Promise((res) => { this.readyResolve = res; });
  }

  flush(err) { for (const p of this.queue.splice(0)) p.reject(err); }

  async send(cmd) {
    if (!this.proc) throw new Error('helper not running');
    await Promise.race([this.readyPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('helper start timeout')), 20000))]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { const i = this.queue.findIndex((p) => p.resolve === resolve); if (i !== -1) this.queue.splice(i, 1); reject(new Error('helper timeout')); }, 5000);
      this.queue.push({ resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.proc.stdin.write(JSON.stringify(cmd) + '\n');
    });
  }

  async get() { const r = await this.send({ cmd: 'get' }); return { volume: r.volume, mute: !!r.mute, device: r.device || '' }; }
  async set(volume) { await this.send({ cmd: 'set', volume }); }
  async mute(on) { await this.send({ cmd: 'mute', mute: !!on }); }
  async key(vk) { await this.send({ cmd: 'key', vk }); }
  async meter() { const r = await this.send({ cmd: 'meter' }); return Number(r.peak) || 0; }
  async list() { const r = await this.send({ cmd: 'list' }); return (r.devices || []).map((d) => ({ id: d.id, name: d.name, default: !!d.default })); }
  async setDefault(id) { await this.send({ cmd: 'setDefault', id }); }
  async nowPlaying() { const r = await this.send({ cmd: 'nowPlaying' }); return r.media || null; }
  async art() { const r = await this.send({ cmd: 'art' }); return r.art || null; }
  close() { if (this.proc) { try { this.proc.stdin.write('{"cmd":"quit"}\n'); } catch { /* ignore */ } this.proc.kill(); } }
}

// ---------------------------------------------------------------------------
// Backend 3: mock, for renderer work on a non-Windows box (DOOMBAR_AUDIO_BACKEND=mock).
class MockBackend {
  constructor() {
    this.volume = 0.62; this.muted = false; this.t0 = Date.now();
    this.devices = [
      { id: 'a', name: 'RTK FHD HDR (NVIDIA High Definition Audio)', default: true },
      { id: 'b', name: 'Speakers (Realtek(R) Audio)', default: false },
      { id: 'c', name: 'WH-1000XM5 Hands-Free', default: false },
    ];
  }
  async get() { return { volume: this.volume, mute: this.muted, device: this.devices.find((d) => d.default).name }; }
  async set(v) { this.volume = v; }
  async mute(on) { this.muted = on; }
  async key() {}
  async meter() { const t = (Date.now() - this.t0) / 1000; return this.muted ? 0 : 0.25 + 0.2 * Math.sin(t * 2.1) + 0.15 * Math.abs(Math.sin(t * 7.3)); }
  async list() { return this.devices.map((d) => ({ ...d })); }
  async setDefault(id) { for (const d of this.devices) d.default = d.id === id; }
  async nowPlaying() { return { title: 'Everything In Its Right Place', artist: 'Radiohead', album: 'Kid A', status: 'Playing', app: 'AppleMusic.exe', hasArt: true }; }
  async art() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><defs><linearGradient id="g" x2="1" y2="1">'
      + '<stop offset="0" stop-color="#1b2a4a"/><stop offset="1" stop-color="#d0473a"/></linearGradient></defs><rect width="8" height="8" fill="url(#g)"/></svg>';
    return { type: 'image/svg+xml', data: Buffer.from(svg).toString('base64') };
  }
  close() {}
}

// Apple Music leaves AlbumTitle empty and reports the artist as "Artist — Album".
function normalizeMedia(m) {
  if (!m || !m.title) return null;
  let artist = String(m.artist || ''), album = String(m.album || '');
  const i = artist.indexOf(' — ');
  if (!album && i > 0) { album = artist.slice(i + 3).trim(); artist = artist.slice(0, i).trim(); }
  return { title: String(m.title), artist, album, status: String(m.status || ''), app: String(m.app || ''), hasArt: !!m.hasArt };
}

// ---------------------------------------------------------------------------
class AudioService extends Service {
  constructor(opts) {
    const cfg = (opts.config && opts.config.audio) || {};
    super('audio', { ...opts, pollMs: (cfg.pollSeconds || 1) * 1000 });
    this.cfg = cfg;
    this.backend = null;
    this.state = {
      volume: 0, mute: false, device: '', backend: null, transport: true,
      peak: 0,            // 0..1 from the endpoint meter, published on its own fast cadence
      devices: [],        // [{ id, name, default }]
      media: null,        // { title, artist, album, status, app, hasArt, artId } or null
      visualizer: cfg.visualizer !== false,
    };
  }

  async onStart() {
    const prefer = process.env.DOOMBAR_AUDIO_BACKEND || this.cfg.backend || 'powershell';
    if (prefer === 'mock') {
      this.backend = new MockBackend();
      this.setState({ backend: 'mock' }, { touch: false });
      this.poll(() => this.tick(), this.pollMs);
      this.startMeter();
      return;
    }
    if (process.platform !== 'win32') { this.disable('audio control is Windows-only'); return; }
    // PowerShell is the default: its COM interop is the well-trodden path. The koffi
    // vtable path is faster but a wrong pointer there crashes the whole process
    // (no JS try/catch can catch a segfault), so it stays opt-in until verified:
    //   config.json -> "audio": { "backend": "koffi" }  or  DOOMBAR_AUDIO_BACKEND=koffi
    if (prefer === 'koffi') {
      try { this.backend = new KoffiBackend(this.log); await this.backend.get(); }
      catch (e) { this.log.warn('koffi audio backend failed, using PowerShell:', e.message); this.backend = null; }
    }
    if (!this.backend) this.backend = new PowerShellBackend(this.log);
    this.setState({ backend: this.backend instanceof KoffiBackend ? 'koffi' : 'powershell' }, { touch: false });
    this.poll(() => this.tick(), this.pollMs);
    this.startMeter();
  }

  async onStop() { if (this.backend) this.backend.close(); this.backend = null; }

  // Republish so the panel repaints with the new audio.visual right away (main sends
  // the config first). Switching to art also fetches it now rather than next tick.
  async onConfig() {
    if (this.backend && this.has('art') && this.state.media) {
      await this.refreshArt(this.state.media);
      this.setState({ media: { ...this.state.media, artId: this.art ? this.art.id : null } }, { touch: false });
    } else this.setState({}, { touch: false });
  }

  // Extras (meter, device list, now-playing) exist on the PowerShell and mock
  // backends only; the koffi path degrades to volume/mute/transport.
  has(fn) { return typeof this.backend?.[fn] === 'function'; }

  // Peak meter on its own cadence. Publishes without touching lastUpdated so a
  // silent room does not look like a stale service. Skipped entirely while blanked.
  startMeter() {
    if (!this.has('meter') || this.cfg.meter === false) return;
    const ms = Math.max(60, this.cfg.meterMs || 150);
    this.poll(async () => {
      if (this.slowFactor > 1) return;
      const peak = await this.backend.meter();
      const rounded = Math.round(peak * 200) / 200;
      if (rounded !== this.state.peak) this.setState({ peak: rounded }, { touch: false });
    }, ms);
  }

  async tick() {
    this.ticks = (this.ticks || 0) + 1;
    const s = await this.backend.get();
    const patch = {};
    const volume = Math.round(s.volume * 100);
    if (volume !== this.state.volume) patch.volume = volume;
    if (s.mute !== this.state.mute) patch.mute = s.mute;
    if (s.device !== this.state.device) patch.device = s.device;

    if (this.has('nowPlaying')) {
      const media = await this.backend.nowPlaying().then(normalizeMedia, (e) => { this.log.debug('nowPlaying:', e.message); return this.state.media && { ...this.state.media }; });
      if (this.has('art')) await this.refreshArt(media);
      if (media) media.artId = this.art ? this.art.id : null;
      if (JSON.stringify(media) !== JSON.stringify(this.state.media)) patch.media = media;
    }
    // Device list changes rarely; refresh every ~15 s or when the default moved.
    if (this.has('list') && (this.ticks % 15 === 1 || patch.device !== undefined)) {
      const devices = await this.backend.list().catch((e) => { this.log.debug('list:', e.message); return this.state.devices; });
      if (JSON.stringify(devices) !== JSON.stringify(this.state.devices)) patch.devices = devices;
    }

    if (Object.keys(patch).length) this.setState(patch);
    else {
      this.lastUpdated = Date.now();
      if (this.status !== 'connected') this.setStatus('connected');
    }
  }

  // Album art, only while the panel is set to show it (audio.visual 'art'). Fetched
  // on a track change and once more a few seconds later, because players can swap
  // the thumbnail in after the title. The image stays out of state (the meter
  // republishes state several times a second); the renderer pulls it by artId.
  async refreshArt(media) {
    const want = this.cfg.visual === 'art' && media && media.hasArt;
    const key = want ? [media.title, media.artist, media.album, media.app].join('\u0001') : '';
    if (key !== this.artKey) { this.artKey = key; this.art = null; this.artChecks = key ? 2 : 0; this.artNext = 0; }
    if (!this.artChecks || this.ticks < this.artNext) return;
    this.artChecks--; this.artNext = this.ticks + 3;
    const a = await this.backend.art().catch((e) => { this.log.debug('art:', e.message); return null; });
    const url = a && a.data ? `data:${a.type || 'image/jpeg'};base64,${a.data}` : null;
    if (url && url !== this.art?.url) this.art = { id: (this.artSeq = (this.artSeq || 0) + 1), url };
  }

  actions = {
    art: async () => this.art || { id: null, url: null },
    setVolume: async ({ volume }) => {
      const v = Math.min(100, Math.max(0, Number(volume)));
      await this.backend.set(v / 100);
      this.setState({ volume: v });
    },
    mute: async ({ mute }) => {
      const on = mute === undefined ? !this.state.mute : !!mute;
      await this.backend.mute(on);
      this.setState({ mute: on });
    },
    setDevice: async ({ id }) => {
      if (!this.has('setDefault')) throw new Error('device switching needs the PowerShell backend');
      const dev = this.state.devices.find((d) => d.id === id);
      if (!dev) throw new Error('unknown device');
      await this.backend.setDefault(id);
      this.setState({ device: dev.name, devices: this.state.devices.map((d) => ({ ...d, default: d.id === id })) });
      this.ticks = 0; // force a list refresh on the next tick
    },
    refreshDevices: async () => {
      if (!this.has('list')) return { devices: [] };
      const devices = await this.backend.list();
      this.setState({ devices }, { touch: false });
      return { devices };
    },
    playPause: async () => { await this.backend.key(VK.PLAY_PAUSE); },
    next: async () => { await this.backend.key(VK.NEXT); },
    prev: async () => { await this.backend.key(VK.PREV); },
    volumeUp: async () => { await this.backend.key(VK.VOL_UP); },
    volumeDown: async () => { await this.backend.key(VK.VOL_DOWN); },
  };
}

module.exports = { AudioService, VK, normalizeMedia };

if (require.main === module) {
  require('./standalone').runStandalone(AudioService, { waitMs: 25000 });
}
