'use strict';
// Validation for settings written from the setup window and the dashboard.
// Takes an untrusted patch, returns a config patch holding only known keys with
// sane values (or null when nothing usable is left). Electron-free for tests.
const { THEMES } = require('./themes');

const VIZ_COLORS = ['accent', 'energy', 'sustain'];
const VISUALS = ['spectrum', 'art', 'none']; // what fills the audio panel under the transport
const GROUP_BY = ['client', 'sender', 'none'];
const VIEWS = ['normal', 'focus', 'more'];            // per-panel view, cycled by a header tap
// Which views each panel has; audio flips between itself and the ACE player.
const PANEL_VIEWS = { slack: VIEWS, email: VIEWS, calendar: VIEWS, audio: ['normal', 'ace'] };
const HEX = /^#[0-9a-f]{6}$/i;

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const hex = (v) => (HEX.test(str(v)) ? str(v).toLowerCase() : null);

function list(v, clean, max = 200) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const item of v) {
    const c = clean(item);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function num(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
}

function set(out, section, key, value) {
  if (value == null) return;
  (out[section] ||= {})[key] = value;
}

function sanitizeSettings(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};

  if (p.slack) {
    // Names ("general", "@dana", "mpdm-…") or IDs; the service accepts any of them.
    set(out, 'slack', 'channels', list(p.slack.channels, (c) => str(c, 120).replace(/^#/, '')));
    const n = num(p.slack.previewMessages, 1, 20);
    set(out, 'slack', 'previewMessages', n == null ? null : Math.round(n));
    const days = num(p.slack.activeDays, 0, 365); // 0 = show every watched channel
    set(out, 'slack', 'activeDays', days == null ? null : Math.round(days));
  }

  if (p.email) {
    // "acme", "globex.com", or "bob@x.com": see matchesSender in services/email.js.
    const entry = (e) => { const s = str(e, 120).toLowerCase().replace(/^@/, ''); return /^[a-z0-9._+-]+(@[a-z0-9.-]+)?$/.test(s) ? s : ''; };
    set(out, 'email', 'senders', list(p.email.senders, entry));
    set(out, 'email', 'prospects', list(p.email.prospects, entry));
    if (GROUP_BY.includes(p.email.groupBy)) set(out, 'email', 'groupBy', p.email.groupBy);
  }

  if (p.calendar) {
    set(out, 'calendar', 'calendars', list(p.calendar.calendars, (c) => {
      const id = str(c && c.id, 300);
      if (!id) return null;
      const cal = { id };
      // Owning account id (services/accounts.js slug); absent means the first Google account.
      if (/^[a-z0-9-]{1,60}$/.test(str(c.account, 60))) cal.account = str(c.account, 60);
      if (str(c.name, 80)) cal.name = str(c.name, 80);
      if (hex(c.color)) cal.color = hex(c.color);
      return cal;
    }, 30));
    const m = num(p.calendar.alertMinutes, 0, 60);
    set(out, 'calendar', 'alertMinutes', m == null ? null : Math.round(m));
    const fh = num(p.calendar.focusHours, 0.25, 24);
    set(out, 'calendar', 'focusHours', fh);
  }

  if (p.audio) {
    if (typeof p.audio.visualizer === 'boolean') set(out, 'audio', 'visualizer', p.audio.visualizer);
    if (VISUALS.includes(p.audio.visual)) set(out, 'audio', 'visual', p.audio.visual);
    if (VIZ_COLORS.includes(p.audio.vizColor)) set(out, 'audio', 'vizColor', p.audio.vizColor);
    set(out, 'audio', 'energySeconds', num(p.audio.energySeconds, 1, 120));
    set(out, 'audio', 'sustainSeconds', num(p.audio.sustainSeconds, 1, 120));
    // null or [] means "derive from the theme"; otherwise 2-6 hex stops, low to high.
    if (p.audio.energyColors === null) set(out, 'audio', 'energyColors', []);
    else {
      const stops = list(p.audio.energyColors, hex, 6);
      if (stops && (stops.length === 0 || stops.length >= 2)) set(out, 'audio', 'energyColors', stops);
    }
  }

  if (p.unreadAlert) {
    if (typeof p.unreadAlert.enabled === 'boolean') set(out, 'unreadAlert', 'enabled', p.unreadAlert.enabled);
    if (typeof p.unreadAlert.sweep === 'boolean') set(out, 'unreadAlert', 'sweep', p.unreadAlert.sweep);
    const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
    set(out, 'unreadAlert', 'sweepSeconds', round1(num(p.unreadAlert.sweepSeconds, 0.3, 10)));
    set(out, 'unreadAlert', 'sweepEverySeconds', round1(num(p.unreadAlert.sweepEverySeconds, 3, 3600)));
    set(out, 'unreadAlert', 'sweepEveryBreathingSeconds', round1(num(p.unreadAlert.sweepEveryBreathingSeconds, 3, 3600)));
    set(out, 'unreadAlert', 'breatheSeconds', round1(num(p.unreadAlert.breatheSeconds, 1, 30)));
    const red = num(p.unreadAlert.redAfterMinutes, 1, 1440);
    const pulse = num(p.unreadAlert.pulseAfterMinutes, 1, 1440);
    set(out, 'unreadAlert', 'redAfterMinutes', red == null ? null : Math.round(red));
    set(out, 'unreadAlert', 'pulseAfterMinutes', pulse == null ? null : Math.round(Math.max(pulse, red || 1)));
    const snooze = num(p.unreadAlert.snoozeMinutes, 1, 1440);
    set(out, 'unreadAlert', 'snoozeMinutes', snooze == null ? null : Math.round(snooze));
  }

  if (p.views && typeof p.views === 'object') {
    for (const [panel, views] of Object.entries(PANEL_VIEWS)) if (views.includes(p.views[panel])) set(out, 'views', panel, p.views[panel]);
  }

  if (p.display) {
    const ids = new Map(THEMES.map((t) => [t.id, t]));
    const t = str(p.display.theme);
    if (t === 'system' || ids.has(t)) set(out, 'display', 'theme', t);
    if (ids.get(p.display.darkTheme)?.mode === 'dark') set(out, 'display', 'darkTheme', p.display.darkTheme);
    if (ids.get(p.display.lightTheme)?.mode === 'light') set(out, 'display', 'lightTheme', p.display.lightTheme);
  }

  return Object.keys(out).length ? out : null;
}

module.exports = { sanitizeSettings, VIZ_COLORS, VISUALS };
