'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSettings } = require('../main/settings');

test('settings: unknown sections and junk are dropped', () => {
  assert.equal(sanitizeSettings(null), null);
  assert.equal(sanitizeSettings({ layout: [], secrets: { x: 1 } }), null);
  assert.deepEqual(sanitizeSettings({ audio: { vizColor: 'rainbow', visualizer: 'yes' } }), null);
});

test('settings: slack channels trimmed, #-stripped, deduped; preview clamped', () => {
  const p = sanitizeSettings({ slack: { channels: ['#general', ' general ', '@Dana Q', 42, ''], previewMessages: 99 } });
  assert.deepEqual(p, { slack: { channels: ['general', '@Dana Q'], previewMessages: 20 } });
});

test('settings: email entries follow matchesSender forms', () => {
  const p = sanitizeSettings({ email: { senders: ['Acme', 'globex.com', '@x.io', 'bob@x.com', 'no spaces here'], prospects: [] } });
  assert.deepEqual(p.email, { senders: ['acme', 'globex.com', 'x.io', 'bob@x.com'], prospects: [] });
});

test('settings: calendars keep id, optional name, valid hex colour only', () => {
  const p = sanitizeSettings({ calendar: { calendars: [{ id: 'primary', name: 'Work', color: '#7C9CFF' }, { id: 'x@group', color: 'red' }, { name: 'no id' }] } });
  assert.deepEqual(p.calendar.calendars, [{ id: 'primary', name: 'Work', color: '#7c9cff' }, { id: 'x@group' }]);
});

test('settings: visualizer colour mode, window and gradient', () => {
  assert.deepEqual(sanitizeSettings({ audio: { vizColor: 'energy', energySeconds: 500, energyColors: ['#000000', '#ffffff'] } }).audio,
    { vizColor: 'energy', energySeconds: 120, energyColors: ['#000000', '#ffffff'] });
  // null means "use the theme"; a single stop is not a gradient.
  assert.deepEqual(sanitizeSettings({ audio: { energyColors: null } }).audio, { energyColors: [] });
  assert.equal(sanitizeSettings({ audio: { energyColors: ['#000000'] } }), null);
});

test('settings: themes must exist and match their slot', () => {
  assert.deepEqual(sanitizeSettings({ display: { theme: 'system', darkTheme: 'nord', lightTheme: 'nord' } }).display, { theme: 'system', darkTheme: 'nord' });
  assert.equal(sanitizeSettings({ display: { theme: 'neon' } }), null);
});

test('settings: unread tint thresholds clamp and breathe never precedes red', () => {
  assert.deepEqual(sanitizeSettings({ unreadAlert: { enabled: false, redAfterMinutes: 45, pulseAfterMinutes: 10 } }).unreadAlert,
    { enabled: false, redAfterMinutes: 45, pulseAfterMinutes: 45 });
  assert.deepEqual(sanitizeSettings({ unreadAlert: { redAfterMinutes: 0 } }).unreadAlert, { redAfterMinutes: 1 });
});

test('settings: unread timing in seconds is clamped and rounded', () => {
  assert.deepEqual(sanitizeSettings({ unreadAlert: { sweepSeconds: 0.05, sweepEverySeconds: 45.26, sweepEveryBreathingSeconds: 'x', breatheSeconds: 99 } }).unreadAlert,
    { sweepSeconds: 0.3, sweepEverySeconds: 45.3, breatheSeconds: 30 });
});

test('settings: slack activeDays, email groupBy, sustain mode', () => {
  const p = sanitizeSettings({ slack: { activeDays: 400 }, email: { groupBy: 'client' }, audio: { vizColor: 'sustain', sustainSeconds: 0 } });
  assert.deepEqual(p, { slack: { activeDays: 365 }, email: { groupBy: 'client' }, audio: { vizColor: 'sustain', sustainSeconds: 1 } });
  assert.equal(sanitizeSettings({ email: { groupBy: 'thread' } }), null);
});

test('settings: audio visual is spectrum, art or none', () => {
  assert.deepEqual(sanitizeSettings({ audio: { visual: 'art', visualizer: true } }).audio, { visual: 'art', visualizer: true });
  assert.equal(sanitizeSettings({ audio: { visual: 'video' } }), null);
});

test('settings: panel views for slack, email, calendar; audio flips to ace', () => {
  assert.deepEqual(sanitizeSettings({ views: { slack: 'focus', email: 'more', calendar: 'normal', audio: 'focus', timers: 'more' } }).views,
    { slack: 'focus', email: 'more', calendar: 'normal' });
  assert.deepEqual(sanitizeSettings({ views: { audio: 'ace' } }).views, { audio: 'ace' });
  assert.equal(sanitizeSettings({ views: { slack: 'zen' } }), null);
  assert.equal(sanitizeSettings({ views: { slack: 'ace' } }), null);
});

test('settings: calendar focusHours clamped to 0.25..24', () => {
  assert.equal(sanitizeSettings({ calendar: { focusHours: 6 } }).calendar.focusHours, 6);
  assert.equal(sanitizeSettings({ calendar: { focusHours: 100 } }).calendar.focusHours, 24);
});
