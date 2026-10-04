import { h, ago } from './base.js';
import { AudioPanel } from './audio.js';
import { AcePanel } from './ace.js';

// The audio panel with the ACE player on its back: a header tap flips between
// the two faces (views.audio: 'normal' | 'ace'), like the views of slack,
// email and calendar. Both faces stay live: ACE keeps playing behind the Audio
// face. There is one spectrum (system loopback, so it shows ACE too): its
// canvas moves to whichever face is up.
export class AudioAcePanel extends AudioPanel {
  constructor(name, config) {
    super(name, config);
    this.audioFace = h('div', { class: 'face' });
    this.aceFace = h('div', { class: 'face' });
    this.body.replaceChildren(this.audioFace, this.aceFace);
    this.el.classList.add('panel-ace');
    this.ace = new AcePanel('ace', config, { host: this.aceFace });
    this.enableViews({ normal: '', ace: '' }, ['normal', 'ace']);
    this.viewPill.hidden = true;
    this.aceState = null;
    this.unsubscribeAce = window.dashboard.subscribe('ace', (s) => {
      this.aceState = s;
      try { this.ace.receive(s); } catch (e) { console.error('ace', e); }
      this.syncHead();
    });
    this.applyFace();
  }

  build() {
    super.build(); // puts the audio UI straight into the body; move it to its face
    this.audioFace.replaceChildren(this.ui.root);
    this.body.replaceChildren(this.audioFace, this.aceFace);
    this.placeCanvas();
  }

  // On the ACE face the spectrum always shows (no album art mode there).
  applyVisual() {
    super.applyVisual();
    if (this.view === 'ace') this.ui.canvas.hidden = this.visualMode === 'none' || this.viz.state === 'failed';
  }

  // The volume row, the meter and the spectrum are shared: they sit on
  // whichever face is up, so volume is volume on both sides.
  placeCanvas() {
    if (!this.ui) return;
    const { canvas, art, levelRow, meter, devlist } = this.ui;
    if (this.view === 'ace') {
      if (canvas.parentNode !== this.ace.ui.vizSlot) this.ace.ui.vizSlot.append(canvas);
      if (levelRow.parentNode !== this.ace.ui.volSlot) this.ace.ui.volSlot.append(levelRow, meter);
    } else {
      if (canvas.nextSibling !== art) art.before(canvas);
      if (levelRow.previousSibling !== devlist) devlist.after(levelRow, meter);
    }
    this.applyVisual();
  }

  // Notices belong to the audio face; the ACE face has its own offline line.
  showNotice(text) { this.audioFace.replaceChildren(h('div', { class: 'notice', text })); }
  showError(text) { this.audioFace.replaceChildren(h('div', { class: 'notice error', text })); }
  hasContent() { return !!this.ui && this.audioFace.contains(this.ui.root); }

  receive(state) {
    super.receive(state);
    this.applyFace();
  }

  configChanged() {
    this.ace.config = this.config;
    super.configChanged();
  }

  applyFace() {
    const ace = this.view === 'ace';
    this.audioFace.hidden = ace;
    this.aceFace.hidden = !ace;
    this.title.textContent = ace ? 'ACE' : 'Audio';
    this.placeCanvas();
    this.syncHead();
  }

  // Header dot and "updated" follow the face that is showing.
  syncHead() {
    const s = this.view === 'ace' ? this.aceState : this.state;
    if (!s) return;
    this.dot.className = `panel-dot ${s.status}`;
    this.updated.textContent = s.lastUpdated ? ago(s.lastUpdated) : '';
  }

  tick() {
    super.tick();
    this.syncHead();
  }
}
