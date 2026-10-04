import { Panel, h } from './base.js';

// ACE player (doomgen spec section 14): plays new tracks from the Doomgen
// server. The <audio> element lives here; the ace service in main holds the
// server connection, the queue source and offline event queue.
//
// Laid out like the audio panel it sits behind, row for row:
//   device picker  -> source chips: Unheard, Radio, and ▾ for Liked or a theme
//   volume + meter -> the same volume row and meter (moved over by audio-ace.js)
//   now playing    -> title, theme · batch (tap: full prompt, Broken buttons)
//   ⏮ ⏯ ⏭          -> 👎 ⏯ +30 ⏭ 👍
//   spectrum       -> the audio panel's own spectrum (also moved over)
// then a thin time line with a tick (seek) and tonight's render run.
//
// Feedback: finished -> completed, ⏭ -> skipped (with position), 👍 toggles
// like, 👎 dislikes and moves on. Nothing plays until the first tap (or a
// media key): a login should not start music.

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const RECENT = 30; // exclude this many recently played tracks from "next"
const FF_S = 30; // the +30 button (and the seekforward media action)

export class AcePanel extends Panel {
  // host: render into this element instead of our own panel body (the ACE
  // face of the audio panel, see audio-ace.js).
  constructor(name, config, { host = null } = {}) {
    super(name, config, 'ACE');
    this.host = host;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.volume = 1; // system volume stays with the audio panel
    this.track = null;
    this.startedSent = false;
    this.recent = [];
    this.loading = false;
    this.wantPlay = false;
    this.flashTimer = null;
    this.picking = false;
    this.build();
    this.bindAudio();
    this.bindMediaSession();
  }

  // The panel keeps its layout when the server is down (offline line instead).
  hasContent() { return true; }

  build() {
    const ui = this.ui = {};
    // Unheard and Radio one tap away; Liked and the themes behind the third chip.
    ui.unheard = h('button', { class: 'btn ace-chip', onClick: () => this.pickSource('unheard') });
    ui.radio = h('button', { class: 'btn ace-chip', onClick: () => this.pickSource('radio') }, h('span', { text: 'Radio' }));
    ui.moreName = h('span', { class: 'name' });
    ui.more = h('button', { class: 'btn ace-chip more', onClick: () => this.togglePicker() }, ui.moreName, h('span', { class: 'caret', text: '▾' }));
    ui.source = h('div', { class: 'ace-sources' }, ui.unheard, ui.radio, ui.more);
    ui.srclist = h('div', { class: 'devlist' });

    // Volume row and meter: the audio face's own, moved here by audio-ace.js.
    ui.volSlot = h('div', { class: 'ace-vol' });

    // Time: a thin line with a tick, under the spectrum.
    ui.tick = h('i', { class: 'tick' });
    ui.played = h('i', { class: 'played' });
    ui.elapsed = h('span');
    ui.total = h('span');
    ui.seek = h('div', { class: 'ace-seek' }, h('div', { class: 'line' }, ui.played, ui.tick));
    ui.times = h('div', { class: 'ace-times' }, ui.elapsed, ui.total);
    this.bindSeek();

    ui.title = h('div', { class: 't' });
    ui.sub = h('div', { class: 'a' });
    ui.np = h('div', { class: 'np ace-np', onClick: () => this.showPrompt() }, ui.title, ui.sub);

    ui.dislike = h('button', { class: 'btn', 'aria-label': 'Dislike', text: '👎', onClick: () => this.dislike() });
    ui.play = h('button', { class: 'btn', 'aria-label': 'Play', text: '▶', onClick: () => this.togglePlay() });
    ui.ff = h('button', { class: 'btn', 'aria-label': `Forward ${FF_S} seconds`, text: `+${FF_S}`, onClick: () => this.forward() });
    ui.skip = h('button', { class: 'btn', 'aria-label': 'Skip', text: '⏭', onClick: () => this.skip() });
    ui.like = h('button', { class: 'btn', 'aria-label': 'Like', text: '👍', onClick: () => this.like() });
    ui.transport = h('div', { class: 'transport' }, ui.dislike, ui.play, ui.ff, ui.skip, ui.like);

    // Filled with the audio panel's spectrum when we are its back face.
    ui.vizSlot = h('div', { class: 'ace-viz' });

    ui.runLabel = h('span', { class: 'ace-run-label' });
    ui.runFill = h('i');
    ui.runBar = h('div', { class: 'meter ace-run-bar' }, ui.runFill);
    ui.runBtn = h('button', { class: 'btn ghost ace-run-btn', onClick: () => this.toggleRun() });
    ui.tonight = h('div', { class: 'ace-tonight' }, h('div', { class: 'ace-run-text' }, ui.runLabel, ui.runBar), ui.runBtn);

    ui.overlay = h('div', { class: 'ace-overlay', hidden: true, onClick: (e) => { if (e.target === ui.overlay) this.closeOverlay(); } });
    this.root = h('div', { class: 'audio ace' },
      ui.source, ui.srclist, ui.volSlot,
      ui.np, ui.transport, ui.vizSlot, ui.seek, ui.times, ui.tonight, ui.overlay);
    (this.host || this.body).replaceChildren(this.root);
    this.showTrack(null);
  }

  // --- audio -----------------------------------------------------------------------

  bindAudio() {
    const a = this.audio;
    a.addEventListener('playing', () => {
      this.syncPlaying();
      if (this.track && !this.startedSent) { this.startedSent = true; this.action('event', { track_id: this.track.track_id, event: 'started', position_s: a.currentTime }); }
    });
    a.addEventListener('pause', () => this.syncPlaying());
    a.addEventListener('timeupdate', () => this.syncTime());
    a.addEventListener('durationchange', () => this.syncTime());
    a.addEventListener('ended', () => {
      if (this.track) this.action('event', { track_id: this.track.track_id, event: 'completed', position_s: a.duration });
      this.advance(true);
    });
    a.addEventListener('error', () => {
      const code = a.error && a.error.code;
      console.warn('ace audio error', code, this.track && this.track.track_id);
      this.syncPlaying();
      // Missing file or server gone: try the next track once the server answers.
      if (this.state?.data?.online) setTimeout(() => this.advance(this.wantPlay), 2000);
    });
  }

  bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.play());
    ms.setActionHandler('pause', () => this.audio.pause());
    ms.setActionHandler('nexttrack', () => this.skip());
    try { ms.setActionHandler('seekforward', (d) => this.forward(d?.seekOffset)); } catch { /* not supported */ }
    try { ms.setActionHandler('stop', () => this.audio.pause()); } catch { /* not supported */ }
  }

  setMediaMetadata(t) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = t ? new MediaMetadata({
      title: t.title, artist: t.theme_name, album: t.batch_title || t.theme_name,
      artwork: t.cover_url ? [{ src: t.cover_url, sizes: '600x600', type: 'image/png' }] : [],
    }) : null;
  }

  syncPlaying() {
    const playing = !this.audio.paused && !this.audio.ended;
    this.ui.play.textContent = playing ? '❚❚' : '▶';
    this.ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.ui.np.classList.toggle('paused', !!this.track && !playing);
    this.root.classList.toggle('playing', playing);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : this.track ? 'paused' : 'none';
  }

  duration() {
    const d = this.audio.duration;
    return Number.isFinite(d) ? d : this.track?.duration_s || 0;
  }

  syncTime() {
    if (this.seeking) return;
    const d = this.duration();
    this.showSeek(d ? Math.min(100, (this.audio.currentTime / d) * 100) : 0, this.audio.currentTime);
  }

  showSeek(pct, t) {
    this.ui.tick.style.left = `${pct}%`;
    this.ui.played.style.width = `${pct}%`;
    this.ui.elapsed.textContent = this.track ? fmt(t) : '';
    this.ui.total.textContent = this.track ? fmt(this.duration()) : '';
  }

  // Drag or tap anywhere on the line (the touch area is taller than it looks);
  // the jump happens on release.
  bindSeek() {
    const bar = this.ui.seek;
    const at = (e) => {
      const r = bar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };
    const show = (e) => { const f = at(e); this.seekTo = f * this.duration(); this.showSeek(f * 100, this.seekTo); };
    bar.addEventListener('pointerdown', (e) => {
      if (!this.track) return;
      this.seeking = true;
      bar.setPointerCapture(e.pointerId);
      show(e);
    });
    bar.addEventListener('pointermove', (e) => { if (this.seeking) show(e); });
    bar.addEventListener('pointerup', (e) => {
      if (!this.seeking) return;
      this.seeking = false;
      show(e);
      if (Number.isFinite(this.audio.duration)) this.audio.currentTime = this.seekTo;
      this.syncTime();
    });
    bar.addEventListener('pointercancel', () => { this.seeking = false; this.syncTime(); });
  }

  // --- queue -------------------------------------------------------------------------

  async advance(autoplay) {
    if (this.loading) return;
    this.loading = true;
    this.wantPlay = autoplay;
    try {
      const r = await this.action('next', { exclude: [this.track?.track_id, ...this.recent] });
      if (r && r.track) {
        this.load(r.track);
        if (autoplay) this.play();
      } else if (r && !r.error) {
        this.load(null);
      }
    } finally {
      this.loading = false;
    }
  }

  load(track) {
    if (this.track) {
      this.recent.unshift(this.track.track_id);
      this.recent.length = Math.min(this.recent.length, RECENT);
    }
    this.track = track;
    this.startedSent = false;
    if (track) {
      this.audio.src = track.audio_url;
    } else {
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.showTrack(track);
    this.setMediaMetadata(track);
    this.syncPlaying();
    this.syncTime();
  }

  play() {
    this.wantPlay = true;
    if (!this.track) { this.advance(true); return; }
    this.audio.play().catch((e) => console.warn('ace play failed:', e.message));
  }

  togglePlay() {
    if (this.audio.paused) this.play();
    else { this.wantPlay = false; this.audio.pause(); }
  }

  // Jump ahead within the track; within the last few seconds that is just the end.
  forward(by = FF_S) {
    const a = this.audio;
    if (!this.track || !Number.isFinite(a.duration)) return;
    a.currentTime = Math.min(a.duration - 0.5, a.currentTime + by);
    this.syncTime();
  }

  skip() {
    const playing = !this.audio.paused || this.wantPlay;
    if (this.track) this.action('event', { track_id: this.track.track_id, event: 'skipped', position_s: this.audio.currentTime });
    this.advance(playing || !this.track);
  }

  like() {
    const t = this.track;
    if (!t) return;
    t.liked = !t.liked;
    if (t.liked) t.disliked = false;
    this.action('event', { track_id: t.track_id, event: t.liked ? 'liked' : 'unliked', position_s: this.audio.currentTime });
    this.flash(this.ui.like, t.liked ? 'Liked' : 'Unliked');
    this.showVotes();
  }

  dislike() {
    const t = this.track;
    if (!t) return;
    this.action('event', { track_id: t.track_id, event: 'disliked', position_s: this.audio.currentTime });
    this.flash(this.ui.dislike, 'Disliked');
    this.advance(!this.audio.paused || this.wantPlay);
  }

  // A render defect (hiss, noise, garble): the server moves it to _rejected,
  // keeps it out of the taste scores and renders the spec again.
  broken(reason = 'noise') {
    const t = this.track;
    if (!t) return;
    this.action('event', { track_id: t.track_id, event: 'broken', reason, position_s: this.audio.currentTime });
    this.flash(this.ui.skip, `Removed · ${reason}`);
    this.advance(!this.audio.paused || this.wantPlay);
  }

  // Hotkeys arrive as a command in service state (seq increments per press).
  runCommand(cmd) {
    if (!cmd || cmd.seq === this.lastCommand) return;
    const first = this.lastCommand === undefined;
    this.lastCommand = cmd.seq;
    if (first && Date.now() - cmd.at > 3000) return; // stale on panel reload
    if (cmd.name === 'like') { if (this.track && !this.track.liked) this.like(); else if (this.track) this.flash(this.ui.like, 'Liked'); }
    if (cmd.name === 'dislike') this.dislike();
    if (cmd.name === 'broken') this.broken('noise');
  }

  // Immediate visual confirmation for like/dislike (spec 14): the button pops
  // and the line under the title says what happened.
  flash(btn, text) {
    btn.classList.remove('pop');
    void btn.offsetWidth;
    btn.classList.add('pop');
    this.ui.sub.dataset.flash = text;
    this.root.classList.add('flashing');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.root.classList.remove('flashing'), 1400);
  }

  showVotes() {
    this.ui.like.classList.toggle('on', !!this.track?.liked);
  }

  showTrack(t) {
    const ui = this.ui;
    ui.np.classList.toggle('idle', !t);
    ui.title.textContent = t ? t.title : 'Nothing queued';
    ui.sub.textContent = t ? [t.theme_name, t.batch_title].filter(Boolean).join(' · ') : '';
    for (const b of [ui.like, ui.dislike, ui.skip]) b.disabled = !t;
    this.showVotes();
  }

  // --- source picker (like the audio panel's device picker) ------------------------

  togglePicker(open = !this.picking) {
    this.picking = open;
    clearTimeout(this.pickTimer);
    if (open) this.pickTimer = setTimeout(() => this.togglePicker(false), 8000);
    this.ui.srclist.classList.toggle('open', open);
    this.ui.more.classList.toggle('active', open);
  }

  pickSource(k) {
    this.togglePicker(false);
    if ((this.state?.data?.source || 'unheard') !== k) this.setSource(k);
  }

  renderSources(d) {
    const ui = this.ui;
    const s = d.sources || {};
    const src = d.source || 'unheard';
    const themes = s.themes || [];
    const themeOf = (key) => themes.find((t) => `theme:${t.theme_id}` === key);
    ui.unheard.replaceChildren(h('span', { text: 'Unheard' }), s.unheard != null ? h('small', { text: String(s.unheard) }) : null);
    ui.unheard.classList.toggle('primary', src === 'unheard');
    ui.radio.classList.toggle('primary', src === 'radio');
    const other = src !== 'unheard' && src !== 'radio';
    ui.more.classList.toggle('primary', other);
    ui.moreName.textContent = !other ? 'More' : src === 'liked' ? 'Liked' : themeOf(src)?.name || 'Theme';
    const key = JSON.stringify([src, s]);
    if (key === this.sourcesKey) return;
    this.sourcesKey = key;
    const row = (k, name, n) => h('button', { class: `btn devrow ${src === k ? 'current' : ''}`, onClick: () => this.pickSource(k) },
      h('span', { class: 'dot' }), h('span', { class: 'n', text: name }), n != null ? h('small', { class: 'ace-count', text: String(n) }) : null);
    ui.srclist.replaceChildren(row('liked', 'Liked', s.liked), ...themes.map((t) => row(`theme:${t.theme_id}`, t.name, t.tracks)));
  }

  setSource(source) {
    this.action('setSource', { source }).then((r) => {
      if (r && r.error) return;
      // Switch now: the next track comes from the new source. No skip event,
      // changing source says nothing about the current track.
      this.advance(!this.audio.paused || this.wantPlay);
    });
  }

  // --- prompt sheet ----------------------------------------------------------------

  showPrompt() {
    const t = this.track;
    if (!t) return;
    const facts = [t.keyscale, t.bpm && `${t.bpm} bpm`, t.duration_s && fmt(t.duration_s), t.model].filter(Boolean).join(' · ');
    this.openOverlay(
      h('div', { class: 'ace-sheet' },
        h('div', { class: 'ace-sheet-head' }, h('b', { text: t.title }), h('button', { class: 'btn ghost', text: '✕', onClick: () => this.closeOverlay() })),
        h('div', { class: 'ace-facts', text: facts }),
        h('p', { class: 'ace-prompt', text: t.tags || '' }),
        t.lyrics ? h('pre', { class: 'ace-sections', text: t.lyrics }) : null,
        h('div', { class: 'ace-sheet-actions' },
          h('span', { class: 'ace-broken-label', text: 'Broken:' }),
          ...['hiss', 'noise', 'garble'].map((r) => h('button', { class: 'btn danger', text: r[0].toUpperCase() + r.slice(1), onClick: () => { this.closeOverlay(); this.broken(r); } })),
          h('button', { class: 'btn', text: 'Studio ↗', onClick: () => { this.closeOverlay(); this.action('openStudio', { track_id: t.track_id }); } }))));
  }

  openOverlay(content) {
    this.ui.overlay.replaceChildren(content);
    this.ui.overlay.hidden = false;
    clearTimeout(this.overlayIdle);
    this.overlayIdle = setTimeout(() => this.closeOverlay(), 30000);
  }

  closeOverlay() { this.ui.overlay.hidden = true; this.ui.overlay.replaceChildren(); clearTimeout(this.overlayIdle); }

  toggleRun() {
    const run = this.state?.data?.run;
    if (!run) return;
    this.action(run.state === 'running' ? 'pauseRun' : 'resumeRun');
  }

  // --- service state -----------------------------------------------------------

  render(d) {
    if (!this.host && !this.root.isConnected) this.body.replaceChildren(this.root);
    const online = !!d.online;
    this.renderSources(d);
    this.renderTonight(d);
    this.runCommand(d.command);

    // First contact: queue a track (paused) so ▶ plays at once.
    const s = d.sources || {};
    if (online && !this.track && !this.loading && s.total) this.advance(false);
    if (!this.track) {
      this.ui.sub.textContent = !online ? 'Doomgen server offline' : s.total === 0 ? 'Library is empty · tracks arrive after a night run' : 'Tap ▶ to start';
    }
    this.root.classList.toggle('offline', !online);
  }

  // Tonight (FR-94): scheduled / running / paused / done, progress, rejects, on
  // one line; the bar under it is the run's progress (the audio face's meter slot).
  renderTonight(d) {
    const ui = this.ui;
    const run = d.run;
    const active = run && ['running', 'paused', 'planning'].includes(run.state);
    let label;
    let showBar = false;
    if (active || (run && Date.now() - (run.ended_at || 0) < 18 * 3600000)) {
      const p = run.progress || {};
      const verb = { running: 'Rendering', paused: 'Paused', planning: 'Planning', stopped: 'Stopped', done: 'Last night', failed: 'Failed' }[run.state] || run.state;
      label = `${verb} · ${p.done ?? 0} / ${p.total ?? 0}${p.rejected ? ` · ${p.rejected} rejected` : ''}${p.failed ? ` · ${p.failed} failed` : ''}`;
      ui.runFill.style.width = p.total ? `${Math.round(((p.done || 0) / p.total) * 100)}%` : '0%';
      showBar = !!active;
    } else if (d.next) {
      const at = new Date(d.next.starts_at);
      label = `Tonight · ${d.next.name} at ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${d.next.tracks ? ` · ~${d.next.tracks} tracks` : ''}`;
    } else {
      label = 'Nothing scheduled tonight';
    }
    if (!d.online) label = d.queued ? `Server offline · ${d.queued} events waiting` : 'Server offline';
    ui.runLabel.textContent = label;
    ui.runBar.hidden = !showBar;
    ui.tonight.dataset.state = d.online ? run?.state || 'none' : 'offline';
    const canToggle = d.online && run && (run.state === 'running' || run.state === 'paused');
    ui.runBtn.hidden = !canToggle;
    ui.runBtn.textContent = run?.state === 'running' ? 'Pause' : 'Resume';
  }
}
