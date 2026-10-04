import { Panel, h } from './base.js';

const BARS = 32;
const VIZ_MODES = ['accent', 'energy', 'sustain'];
const VISUALS = ['spectrum', 'art', 'none'];
const VIZ_LABELS ={ accent: 'Accent colour', energy: 'Energy colour', sustain: 'Sustain colour' };
// Energy mode compares the smoothed level with a much slower reference, in dB, so
// the colour tracks "louder or quieter than lately" whatever the player volume is
// (measured loopback levels run anywhere from 0.05 to 0.6 depending on it).
const ENERGY_REF_SECONDS = 180; // memory of "lately"
const ENERGY_SPAN_DB = 8;       // this far above/below the reference reaches either end
const SILENCE = 0.004;          // below this the reference holds and the colour cools
// Sustain mode: per bar, a fast (~0.3 s) and a slow (~2 s) average of its height.
// While they agree (the band holds its level) the bar's hold time grows and its hue
// walks along the gradient; when the band changes, hold drains twice as fast.
const SUSTAIN_FAST = 0.3, SUSTAIN_SLOW = 2, SUSTAIN_FLOOR = 0.08;

// Audio: device picker, volume with a live peak meter, now-playing, transport,
// and an optional spectrum. The DOM is built once and patched, because the
// meter pushes state several times a second.
//
// The spectrum comes from a system-loopback capture in the renderer
// (getDisplayMedia, answered by main with audio: 'loopback' on Windows), which
// keeps FFT work out of the PowerShell helper. When it runs, it also drives the
// level meter; otherwise the meter follows the endpoint peak from the service.
//
// Bar colour (config audio.vizColor, a tap on the spectrum toggles it): 'accent'
// is the theme accent; 'energy' slides along a low-to-high gradient driven by
// the loudness averaged over audio.energySeconds, relative to the last few
// minutes (quieter than lately is cool, louder is warm); 'sustain' colours each bar
// by how long its band has held a steady level (audio.sustainSeconds to reach the
// far end). In all modes, brightness follows each bar's height.
export class AudioPanel extends Panel {
  constructor(name, config) {
    super(name, config, 'Audio');
    this.dragging = false;
    this.pendingVolume = null;
    this.lastSent = 0;
    this.ui = null;
    this.picking = false;
    this.pickTimer = null;
    this.devicesKey = '';
    this.viz = { state: 'idle' };
    this.meterLevel = 0;
    this.muted = false;
  }

  // --- DOM -------------------------------------------------------------------

  build() {
    const ui = (this.ui = {});
    ui.deviceName = h('span', { class: 'name' });
    ui.device = h('button', { class: 'btn device', onClick: () => this.togglePicker() }, ui.deviceName, h('span', { class: 'caret', text: '▾' }));
    ui.devlist = h('div', { class: 'devlist' });

    ui.level = h('div', { class: 'level' });
    ui.mute = h('button', { class: 'btn icon', onClick: () => this.action('mute') });
    ui.fill = h('div', { class: 'fill' });
    ui.thumb = h('div', { class: 'thumb' });
    ui.slider = h('div', { class: 'slider' }, ui.fill, ui.level, ui.thumb);
    this.wireSlider(ui.slider);

    ui.meterFill = h('i');
    ui.meter = h('div', { class: 'meter' }, ui.meterFill);

    ui.npTitle = h('div', { class: 't' });
    ui.npSub = h('div', { class: 'a' });
    ui.np = h('div', { class: 'np' }, ui.npTitle, ui.npSub);

    ui.play = h('button', { class: 'btn', text: '⏯', onClick: () => this.action('playPause') });
    ui.transport = h('div', { class: 'transport' },
      h('button', { class: 'btn', text: '⏮', onClick: () => this.action('prev') }),
      ui.play,
      h('button', { class: 'btn', text: '⏭', onClick: () => this.action('next') }));

    ui.canvas = h('canvas', { class: 'viz', onClick: () => this.cycleView() });
    ui.artImg = h('img', { alt: '' });
    ui.art = h('div', { class: 'art', onClick: () => this.cycleView() }, ui.artImg);
    ui.art.hidden = true;
    this.artId = undefined; this.artUrl = null;

    ui.levelRow = h('div', { class: 'level-row' }, ui.slider, ui.mute);
    ui.root = h('div', { class: 'audio' },
      ui.device, ui.devlist,
      ui.levelRow,
      ui.meter, ui.np, ui.transport, ui.canvas, ui.art);
    this.body.replaceChildren(ui.root);
  }

  wireSlider(slider) {
    const { fill, thumb, level } = this.ui;
    const setFromEvent = (e) => {
      const r = slider.getBoundingClientRect();
      const v = Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
      fill.style.width = `${v}%`; thumb.style.left = `${v}%`; level.textContent = `${v}%`;
      return v;
    };
    const send = (v, force) => {
      const now = Date.now();
      if (force || now - this.lastSent > 120) { this.lastSent = now; this.action('setVolume', { volume: v }); this.pendingVolume = null; }
      else this.pendingVolume = v;
    };
    slider.addEventListener('pointerdown', (e) => { this.dragging = true; slider.setPointerCapture(e.pointerId); send(setFromEvent(e), true); });
    slider.addEventListener('pointermove', (e) => { if (this.dragging) send(setFromEvent(e), false); });
    const stop = (e) => { if (!this.dragging) return; this.dragging = false; send(setFromEvent(e), true); };
    slider.addEventListener('pointerup', stop);
    slider.addEventListener('pointercancel', () => { this.dragging = false; });
  }

  togglePicker(open = !this.picking) {
    this.picking = open;
    clearTimeout(this.pickTimer);
    if (open) { this.pickTimer = setTimeout(() => this.togglePicker(false), 8000); this.action('refreshDevices'); }
    this.ui.devlist.classList.toggle('open', open);
    this.ui.device.classList.toggle('active', open);
  }

  // --- render / patch ----------------------------------------------------------

  render(d) {
    if (!this.ui || !this.body.contains(this.ui.root)) this.build();
    const ui = this.ui;

    ui.deviceName.textContent = d.device || 'Default output';
    const key = JSON.stringify(d.devices || []);
    if (key !== this.devicesKey) {
      this.devicesKey = key;
      ui.devlist.replaceChildren(...(d.devices || []).map((dev) =>
        h('button', { class: `btn devrow ${dev.default ? 'current' : ''}`, onClick: () => { this.togglePicker(false); if (!dev.default) this.action('setDevice', { id: dev.id }); } },
          h('span', { class: 'dot' }), h('span', { class: 'n', text: dev.name }))));
      if (!(d.devices || []).length) ui.devlist.replaceChildren(h('div', { class: 'empty', text: 'No other outputs' }));
    }
    ui.device.disabled = !(d.devices && d.devices.length > 1);

    if (!this.dragging) {
      ui.fill.style.width = `${d.volume}%`;
      ui.thumb.style.left = `${d.volume}%`;
      ui.level.textContent = `${d.volume}%`;
    }
    ui.level.classList.toggle('muted', !!d.mute);
    ui.mute.textContent = d.mute ? '🔇' : '🔊';
    ui.mute.classList.toggle('primary', !!d.mute);

    this.muted = !!d.mute;
    if (this.viz.state !== 'running') this.setMeter(d.mute ? 0 : d.peak || 0);
    else if (d.backend !== 'mock') this.checkStall(d);

    const m = d.media;
    if (m && m.title) {
      ui.np.classList.remove('idle');
      ui.npTitle.textContent = m.title;
      const app = (m.app || '').replace(/\.exe$/i, '').replace(/^.*[\\/]/, '').replace(/!.*$/, '');
      ui.npSub.textContent = [m.artist, m.album, app].filter(Boolean).join(' · ');
      ui.play.textContent = m.status === 'Playing' ? '❚❚' : '▶';
      ui.np.classList.toggle('paused', m.status !== 'Playing');
    } else {
      ui.np.classList.add('idle');
      ui.npTitle.textContent = 'Nothing playing';
      ui.npSub.textContent = '';
      ui.play.textContent = '⏯';
    }

    this.visualMode = this.visual(d);
    // Art mode still runs the capture: it drives the meter and fills in for tracks without art.
    if (this.visualMode !== 'none' && this.viz.state === 'idle') this.startViz(d.backend === 'mock');
    ui.art.classList.toggle('paused', !!m && m.status !== 'Playing');
    this.syncArt(this.visualMode === 'art' && m && m.artId ? m.artId : null);
    this.applyVisual();
  }

  // audio.visual: 'spectrum' | 'art' | 'none'; older configs only have the visualizer flag.
  visual(d) {
    const a = this.config?.audio || {};
    if (VISUALS.includes(a.visual)) return a.visual;
    return (a.visualizer ?? d.visualizer) === false ? 'none' : 'spectrum';
  }

  applyVisual() {
    const art = this.visualMode === 'art' && !!this.artUrl;
    this.ui.art.hidden = !art;
    this.ui.canvas.hidden = art || this.visualMode === 'none' || this.viz.state === 'failed';
  }

  // The image is not in the service state (that is republished with every meter
  // tick); fetch it once per artId. The old cover stays up until the new one arrives.
  syncArt(id) {
    if (id === this.artId) return;
    this.artId = id;
    if (!id) { this.showArt(null); return; }
    this.action('art').then((r) => { if (this.artId === id && r && r.id === id) this.showArt(r.url); });
  }

  showArt(url) {
    const { art, artImg } = this.ui;
    this.artUrl = url || null;
    if (url) { artImg.src = url; art.style.setProperty('--art', `url("${url}")`); }
    else { artImg.removeAttribute('src'); art.style.removeProperty('--art'); }
    this.applyVisual();
  }

  get vizColor() {
    const m = this.config?.audio?.vizColor;
    return VIZ_MODES.includes(m) ? m : 'accent';
  }

  // Tap on the spectrum or the cover: accent → energy → sustain → album art → accent.
  // Art is skipped when the track has none; in art mode on such a track (spectrum
  // standing in) taps only cycle colours, so the art setting survives.
  cycleView() {
    const i = VIZ_MODES.indexOf(this.vizColor);
    const last = i === VIZ_MODES.length - 1;
    let patch;
    if (this.visualMode === 'art' && this.artUrl) patch = { visual: 'spectrum', vizColor: VIZ_MODES[0] };
    else if (this.visualMode === 'art') patch = { vizColor: VIZ_MODES[(i + 1) % VIZ_MODES.length] };
    else if (last && this.state?.data?.media?.hasArt) patch = { visual: 'art' };
    else patch = { visual: 'spectrum', vizColor: VIZ_MODES[(i + 1) % VIZ_MODES.length] };
    window.dashboard.action('config', 'setAudio', patch).then((r) => { if (r && r.error) console.warn('setAudio:', r.error); });
    // Say what the tap did; the config round trip repaints.
    if (patch.vizColor) this.viz.toast = { text: VIZ_LABELS[patch.vizColor], until: performance.now() + 1500 };
  }

  setMeter(level) {
    // Quick attack, slow release, like a real meter.
    this.meterLevel = level > this.meterLevel ? level : this.meterLevel * 0.85 + level * 0.15;
    this.ui.meterFill.style.width = `${Math.round(Math.min(1, this.meterLevel) * 100)}%`;
    this.ui.meterFill.classList.toggle('hot', this.meterLevel > 0.9);
  }

  // --- spectrum -----------------------------------------------------------------

  async startViz(mock) {
    this.viz.state = 'starting';
    let ctx = null;
    try {
      ctx = new AudioContext();
      let source;
      if (mock) source = mockSource(ctx);
      else {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        stream.getVideoTracks().forEach((t) => t.stop());
        if (!stream.getAudioTracks().length) throw new Error('no loopback audio track');
        source = ctx.createMediaStreamSource(stream);
        this.viz.stream = stream;
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.7;
      const sink = ctx.createGain(); sink.gain.value = 0; // keeps the graph pulled without echoing
      source.connect(analyser).connect(sink).connect(ctx.destination);
      console.info('visualizer running:', mock ? 'mock source' : `${this.viz.stream.getAudioTracks()[0].label || 'loopback'} @ ${ctx.sampleRate} Hz`);
      // Monitor sleep and endpoint changes can end the loopback track or suspend the
      // context without any error; notice and recover instead of drawing zeros forever.
      const track = this.viz.stream?.getAudioTracks()[0];
      if (track) track.addEventListener('ended', () => { if (this.viz.ctx === ctx) this.restartViz('loopback track ended'); });
      ctx.addEventListener('statechange', () => {
        if (this.viz.ctx !== ctx) return;
        if (ctx.state === 'closed') this.restartViz('audio context closed');
        else if (ctx.state !== 'running') ctx.resume().catch(() => {});
      });
      this.viz = {
        state: 'running', ctx, analyser, stream: this.viz.stream, restartedAt: this.viz.restartedAt,
        startedAt: performance.now(), heardAt: 0, sampledAt: 0, loudSince: 0,
        freq: new Uint8Array(analyser.frequencyBinCount),
        time: new Uint8Array(analyser.fftSize),
        bands: bandEdges(analyser.frequencyBinCount, ctx.sampleRate),
        heights: new Float32Array(BARS), colorAt: 0, color: '#b388ff',
        stops: [], energy: 0, ref: 0,
        fast: new Float32Array(BARS), slow: new Float32Array(BARS), hold: new Float32Array(BARS),
        lastT: performance.now(),
      };
      this.frame();
    } catch (e) {
      if (ctx) ctx.close().catch(() => {});
      const needsGesture = e.name === 'InvalidStateError' || e.name === 'NotAllowedError' || /activation|gesture/i.test(e.message);
      if (needsGesture && !this.viz.retried) {
        // getDisplayMedia wants a user gesture: try once more on the next tap.
        // 'waiting' (not 'idle') so the meter's frequent renders do not pile up retries.
        console.warn('visualizer waiting for a tap:', e.name, e.message);
        this.viz = { state: 'waiting', retried: true };
        document.addEventListener('pointerdown', () => { if (this.viz.state === 'waiting') this.startViz(mock); }, { once: true, capture: true });
      } else if (!mock && (e.name === 'NotReadableError' || e.name === 'AbortError')) {
        // WASAPI loopback can say "Device in use" for a while at start-up (seen right
        // after login/relaunch); it clears on its own. Retry with backoff, capped at 60 s.
        const tries = (this.viz.tries || 0) + 1;
        const delay = Math.min(60, 5 * 2 ** (tries - 1)) * 1000;
        console.warn(`visualizer unavailable (${e.name} ${e.message}), retry ${tries} in ${delay / 1000} s`);
        this.viz = { state: 'waiting', tries, retried: this.viz.retried };
        setTimeout(() => { if (this.viz.state === 'waiting') this.startViz(mock); }, delay);
      } else {
        console.warn('visualizer unavailable:', e.name, e.message);
        this.viz = { state: 'failed' };
        if (this.ui) this.applyVisual();
      }
    }
  }

  // Tear the capture down and start a fresh one. Rate-limited so a capture that
  // really is silent (or a device the endpoint meter disagrees with) cannot loop.
  restartViz(reason) {
    const v = this.viz;
    if (v.state !== 'running') return;
    const now = performance.now();
    if (v.restartedAt && now - v.restartedAt < 30000) return;
    console.warn(`visualizer restarting: ${reason}`);
    this.viz = { state: 'idle', restartedAt: now };
    v.stream?.getTracks().forEach((t) => t.stop());
    v.ctx.close().catch(() => {});
    this.startViz(false);
  }

  // The endpoint peak meter (PowerShell helper) is an independent witness: if it
  // hears sound for a few seconds while the loopback stays flat, the capture is dead.
  checkStall(d) {
    const v = this.viz;
    const now = performance.now();
    if (d.mute || !(d.peak > 0.02)) { v.loudSince = 0; return; }
    if (!v.loudSince) v.loudSince = now;
    const sampling = now - v.sampledAt < 1500; // frame() is not parked
    const quietFor = now - Math.max(v.heardAt, v.startedAt);
    if (sampling && now - v.loudSince > 5000 && quietFor > 5000) this.restartViz(`loopback silent for ${Math.round(quietFor / 1000)} s while the endpoint peak is ${d.peak}`);
  }

  frame() {
    const v = this.viz;
    if (v.state !== 'running') return;
    const parked = document.hidden || document.body.classList.contains('blanked') || !this.ui || !this.body.contains(this.ui.root) || this.faceHidden;
    if (parked) { setTimeout(() => this.frame(), 500); return; }
    requestAnimationFrame(() => this.frame());

    v.analyser.getByteFrequencyData(v.freq);
    v.analyser.getByteTimeDomainData(v.time);
    // Windows loopback taps the stream before endpoint mute, so show muted as silence.
    if (this.muted) { v.freq.fill(0); v.time.fill(128); }

    // Level: RMS of the waveform, scaled so typical music sits around 0.6.
    let sum = 0;
    for (let i = 0; i < v.time.length; i++) { const x = (v.time[i] - 128) / 128; sum += x * x; }
    const level = Math.min(1, Math.sqrt(sum / v.time.length) * 2.5);
    this.setMeter(level);

    // Long-term energy: exponential average with a time constant, frame-rate independent.
    // dt is capped so a long park (blanked) does not jump straight to the current level.
    const now = performance.now();
    v.sampledAt = now;
    if (level > SILENCE) v.heardAt = now;
    const dt = Math.min(0.25, (now - v.lastT) / 1000); v.lastT = now;
    const tau = Math.max(1, Number(this.config?.audio?.energySeconds) || 8);
    v.energy += (level - v.energy) * (1 - Math.exp(-dt / tau));
    if (level > SILENCE) {
      if (!v.ref) v.ref = v.energy = level; // first sound: start in the middle, not from silence
      // Until there are ENERGY_REF_SECONDS of sound, the reference is the running mean
      // of everything heard, so one quiet first moment cannot skew it for minutes.
      v.heard = (v.heard || 0) + dt;
      const refTau = Math.min(ENERGY_REF_SECONDS, Math.max(tau, v.heard));
      v.ref += (v.energy - v.ref) * (1 - Math.exp(-dt / refTau));
    }

    // Everything above keeps the meter and energy going while album art hides the canvas.
    const canvas = this.ui.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(canvas.clientWidth * dpr); const H = Math.round(canvas.clientHeight * dpr);
    if (!W || !H) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

    if (now - v.colorAt > 1000) {
      const css = getComputedStyle(canvas);
      const cssVar = (n) => css.getPropertyValue(n).trim();
      v.color = cssVar('--accent') || v.color;
      const custom = this.config?.audio?.energyColors;
      v.stops = (Array.isArray(custom) && custom.length >= 2 ? custom : [cssVar('--accent-2'), cssVar('--accent'), cssVar('--amber'), cssVar('--red')])
        .map(parseHex).filter(Boolean);
      v.colorAt = now;
    }

    const g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    const gap = Math.max(1, Math.round(2 * dpr));
    const bw = (W - gap * (BARS - 1)) / BARS;
    const db = v.ref ? 20 * Math.log10(Math.max(v.energy, 1e-4) / v.ref) : -Infinity;
    const t = Math.min(1, Math.max(0, 0.5 + db / (2 * ENERGY_SPAN_DB)));
    const mode = v.stops.length >= 2 ? this.vizColor : 'accent';
    g.fillStyle = mode === 'energy' ? gradientAt(v.stops, t) : v.color;
    const holdMax = Math.max(1, Number(this.config?.audio?.sustainSeconds) || 10);
    const kFast = 1 - Math.exp(-dt / SUSTAIN_FAST), kSlow = 1 - Math.exp(-dt / SUSTAIN_SLOW);
    for (let b = 0; b < BARS; b++) {
      const [lo, hi] = v.bands[b];
      let peak = 0;
      for (let i = lo; i < hi; i++) if (v.freq[i] > peak) peak = v.freq[i];
      const target = Math.pow(peak / 255, 1.4);
      v.heights[b] = target > v.heights[b] ? target : v.heights[b] * 0.82 + target * 0.18;
      // Sustain bookkeeping runs in every mode so switching to it shows the real state.
      v.fast[b] += (v.heights[b] - v.fast[b]) * kFast;
      v.slow[b] += (v.heights[b] - v.slow[b]) * kSlow;
      const steady = v.slow[b] > SUSTAIN_FLOOR && Math.abs(v.fast[b] - v.slow[b]) < 0.06 + 0.2 * v.slow[b];
      v.hold[b] = Math.min(holdMax, Math.max(0, v.hold[b] + (steady ? dt : -2 * dt)));
      if (mode === 'sustain') g.fillStyle = gradientAt(v.stops, v.hold[b] / holdMax);
      const bh = Math.max(gap, v.heights[b] * H);
      g.globalAlpha = 0.35 + 0.65 * v.heights[b];
      g.fillRect(b * (bw + gap), H - bh, bw, bh);
    }
    g.globalAlpha = 1;

    if (v.toast && now < v.toast.until) {
      g.globalAlpha = Math.min(1, (v.toast.until - now) / 400);
      g.font = `600 ${Math.round(15 * dpr)}px ${getComputedStyle(canvas).fontFamily}`;
      g.fillStyle = getComputedStyle(canvas).getPropertyValue('--fg').trim() || '#fff';
      g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText(v.toast.text, W / 2, Math.round(4 * dpr));
      g.globalAlpha = 1;
    }
  }
}

function parseHex(s) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Colour at t (0..1) along evenly spaced stops, linear in RGB.
function gradientAt(stops, t) {
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(',')})`;
}

// Log-spaced band edges from ~40 Hz to ~16 kHz, at least one bin wide each.
function bandEdges(bins, sampleRate) {
  const hzPerBin = sampleRate / 2 / bins;
  const lo = 40, hi = Math.min(16000, sampleRate / 2);
  const edges = [];
  let prev = Math.max(1, Math.floor(lo / hzPerBin));
  for (let b = 1; b <= BARS; b++) {
    const f = lo * Math.pow(hi / lo, b / BARS);
    let idx = Math.min(bins, Math.floor(f / hzPerBin));
    if (idx <= prev) idx = prev + 1;
    edges.push([prev, Math.min(bins, idx)]);
    prev = idx;
  }
  return edges;
}

// Dev-box stand-in for loopback: a few drifting tones over quiet noise.
function mockSource(ctx) {
  const out = ctx.createGain(); out.gain.value = 0.5;
  for (const [f, rate] of [[110, 0.3], [330, 0.7], [880, 0.5], [2400, 1.1], [6000, 0.9]]) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const g = ctx.createGain(); g.gain.value = 0.15;
    const lfo = ctx.createOscillator(); lfo.frequency.value = rate;
    const depth = ctx.createGain(); depth.gain.value = 0.12;
    lfo.connect(depth).connect(g.gain);
    o.connect(g).connect(out); o.start(); lfo.start();
  }
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.05;
  const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.connect(out); noise.start();
  return out;
}
