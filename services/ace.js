'use strict';
// ACE player backend: talks to the Doomgen server (doomgen/, default
// http://127.0.0.1:7788). Holds the /ws connection (push only, reconnect with
// backoff), the tonight/run state and the queue-source choice, and relays
// player actions. Playback itself is an <audio> element in the renderer panel.
// Play events that cannot be delivered wait in memory (and the db, so a restart
// keeps them) and are flushed when the server is back.
const { Service } = require('./base');

const MAX_OFFLINE_EVENTS = 500;

class AceService extends Service {
  constructor(opts) {
    const cfg = (opts.config && opts.config.ace) || {};
    super('ace', { ...opts, pollMs: 0 });
    this.cfg = cfg;
    this.base = String(cfg.url || 'http://127.0.0.1:7788').replace(/\/+$/, '');
    this.openExternal = opts.openExternal || null;
    this.ws = null;
    this.backoff = 1000;
    this.reconnectTimer = null;
    this.outbox = (this.db && this.db.kvGet('ace.outbox', [])) || [];
    this.state = {
      base: this.base,
      online: false,
      source: (this.db && this.db.kvGet('ace.source', null)) || cfg.source || 'unheard',
      sources: null,
      run: null,
      next: null,
      queued: this.outbox.length,
    };
  }

  async onStart() {
    this.setState({}, { touch: false });
    this.connect();
  }

  async onStop() {
    clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
  }

  // --- server plumbing -----------------------------------------------------------

  async api(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `${method} ${path} -> ${res.status}`), { status: res.status });
    return data;
  }

  connect() {
    if (!this.running || this.ws) return;
    let ws;
    try { ws = new WebSocket(this.base.replace(/^http/, 'ws') + '/ws'); } catch (e) { this.offline(e); return; }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.backoff = 1000;
      this.log.info('connected to', this.base);
      this.online();
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.onEvent(msg);
    });
    const drop = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.offline(e && e.message ? e : new Error('connection closed'));
    };
    ws.addEventListener('close', () => drop());
    ws.addEventListener('error', (e) => drop(e));
  }

  offline(err) {
    if (this.state.online || this.status === 'starting') {
      this.log.warn('doomgen server offline:', err ? err.message || String(err) : '');
    }
    this.setState({ online: false }, { touch: false });
    this.setStatus('error', 'Doomgen server offline');
    clearTimeout(this.reconnectTimer);
    if (!this.running) return;
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  async online() {
    this.setState({ online: true });
    this.setStatus('connected');
    await this.flush();
    await Promise.all([this.refreshTonight(), this.refreshSources()]);
  }

  async refreshTonight() {
    try {
      const t = await this.api('GET', '/api/tonight');
      this.setState({ run: t.run, next: t.next });
    } catch (e) { this.log.warn('tonight:', e.message); }
  }

  async refreshSources() {
    try { this.setState({ sources: await this.api('GET', '/api/player/sources') }); } catch (e) { this.log.warn('sources:', e.message); }
  }

  onEvent({ type, data }) {
    switch (type) {
      case 'hello': this.setState({ run: data.run }); break;
      case 'run.state': this.refreshTonight(); break;
      case 'run.progress': {
        const run = this.state.run;
        if (run && run.run_id === data.run_id) this.setState({ run: { ...run, progress: { ...(run.progress || {}), ...data } } });
        else this.refreshTonight();
        break;
      }
      case 'take.accepted':
        clearTimeout(this.sourcesTimer);
        this.sourcesTimer = setTimeout(() => this.refreshSources(), 1500);
        break;
      case 'player.feedback':
        clearTimeout(this.sourcesTimer);
        this.sourcesTimer = setTimeout(() => this.refreshSources(), 1500);
        break;
      default:
    }
  }

  // --- offline event queue (FR-96) ---------------------------------------------

  saveOutbox() {
    if (this.db) this.db.kvSet('ace.outbox', this.outbox);
    this.setState({ queued: this.outbox.length }, { touch: false });
  }

  async flush() {
    if (!this.outbox.length) return;
    const batch = this.outbox.slice();
    try {
      const r = await this.api('POST', '/api/player/events', { events: batch });
      this.outbox = this.outbox.slice(batch.length);
      const failed = (r.results || []).filter((x) => x.error);
      if (failed.length) this.log.warn(`${failed.length} queued play events rejected:`, failed[0].error);
      this.log.info(`flushed ${batch.length} queued play events`);
      this.saveOutbox();
    } catch (e) {
      this.log.warn('flush failed:', e.message);
    }
  }

  // --- helpers -----------------------------------------------------------------

  absolute(track) {
    if (!track) return null;
    return { ...track, audio_url: this.base + track.audio_url, cover_url: this.base + track.cover_url };
  }

  // --- actions (renderer panel) ---------------------------------------------------

  actions = {
    next: async ({ exclude = [] } = {}) => {
      const ex = exclude.filter(Boolean).join(',');
      const get = (source) => this.api('GET', `/api/player/next?${new URLSearchParams({ source, exclude: ex })}`);
      let { track } = await get(this.state.source);
      // A source that ran dry falls back to unheard, then radio.
      if (!track && this.state.source !== 'unheard') ({ track } = await get('unheard'));
      if (!track && this.state.source !== 'radio') ({ track } = await get('radio'));
      return { track: this.absolute(track) };
    },

    track: async ({ id }) => ({ track: this.absolute(await this.api('GET', `/api/tracks/${encodeURIComponent(id)}`)) }),

    event: async ({ track_id, event, position_s, reason }) => {
      const ev = { track_id, event, position_s: position_s == null ? null : Math.round(position_s * 10) / 10, client: 'doombar', at: Date.now(), ...(reason ? { reason } : {}) };
      try {
        if (this.outbox.length) await this.flush();
        return await this.api('POST', '/api/player/events', ev);
      } catch (e) {
        if (e.status && e.status < 500) throw e; // the server said no; queuing won't help
        this.outbox.push(ev);
        if (this.outbox.length > MAX_OFFLINE_EVENTS) this.outbox.shift();
        this.saveOutbox();
        return { queued: true };
      }
    },

    setSource: async ({ source }) => {
      const ok = ['unheard', 'liked', 'radio'].includes(source) || /^theme:[\w-]+$/.test(String(source));
      if (!ok) throw new Error(`bad source ${source}`);
      if (this.db) this.db.kvSet('ace.source', source);
      this.setState({ source }, { touch: false });
      return { ok: true };
    },

    // Global hotkeys (main/index.js): the panel owns the current track, so pass
    // the command along in state; the panel runs it once per seq.
    hotkey: async ({ name }) => {
      if (!['like', 'dislike', 'broken'].includes(name)) throw new Error(`bad hotkey ${name}`);
      this.commandSeq = (this.commandSeq || 0) + 1;
      this.setState({ command: { seq: this.commandSeq, name, at: Date.now() } }, { touch: false });
      return { ok: true };
    },

    pauseRun: async () => { await this.api('POST', '/api/runs/pause', {}); await this.refreshTonight(); return { ok: true }; },
    resumeRun: async () => { await this.api('POST', '/api/runs/resume', {}); await this.refreshTonight(); return { ok: true }; },

    // FR-98: the browser opens Studio on the track, or on its theme.
    openStudio: async ({ track_id, theme_id } = {}) => {
      const hash = track_id ? `#/library/${encodeURIComponent(track_id)}` : theme_id ? `#/themes/${encodeURIComponent(theme_id)}` : '';
      if (!this.openExternal) throw new Error('cannot open a browser from here');
      await this.openExternal(`${this.base}/${hash}`);
      return { ok: true };
    },
  };
}

module.exports = { AceService };
