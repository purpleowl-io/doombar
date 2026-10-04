'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.DOOMBAR_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'doombar-test-'));

const env = require('../main/env');
const tz = require('../services/tz');
const { matchesSender, groupMessages, handledBy, extractBody, isCalendarReply, htmlToText, decodeEntities } = require('../services/email');
const { alertOf: slackAlertOf } = require('../services/slack');
const { stripQuotesAndSignature } = require('../services/summarizer');
const { merge } = require('../main/config');
const { Service } = require('../services/base');
const { Db } = require('../main/db');
const { TimersService } = require('../services/timers');

test('env parser handles quotes, comments, export', () => {
  const vars = env.parse('# c\nA=1\nexport B="two words"\nC=\'x\' # trailing\nD=raw # comment\n\nBAD LINE\n');
  assert.deepEqual(vars, { A: '1', B: 'two words', C: 'x', D: 'raw' });
});

test('Phoenix start of day and business hours ignore DST', () => {
  // 2026-07-01 03:30 UTC = 2026-06-30 20:30 Phoenix (UTC-7, always)
  const d = new Date('2026-07-01T03:30:00Z');
  const p = tz.parts(d, 'America/Phoenix');
  assert.equal(p.day, 30); assert.equal(p.hour, 20); assert.equal(p.weekday, 2);
  assert.equal(tz.startOfDay(d, 'America/Phoenix').toISOString(), '2026-06-30T07:00:00.000Z');
  assert.equal(tz.startOfDay(d, 'America/Phoenix', 1).toISOString(), '2026-07-01T07:00:00.000Z');
  const bh = { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };
  assert.equal(tz.isBusinessHours(new Date('2026-07-01T16:00:00Z'), 'America/Phoenix', bh), true); // 09:00 Wed
  assert.equal(tz.isBusinessHours(new Date('2026-07-02T01:30:00Z'), 'America/Phoenix', bh), false); // 18:30 Wed
  assert.equal(tz.isBusinessHours(new Date('2026-07-04T16:00:00Z'), 'America/Phoenix', bh), false); // Sat
});

test('sender matching: fragment, domain with subdomains, exact address', () => {
  const entries = ['acme', 'globex.com', 'bob@initech.io'];
  assert.equal(matchesSender('Jane <jane@acme.com>', entries), true);
  assert.equal(matchesSender('jane@mail.acme.net', entries), true);
  assert.equal(matchesSender('x@notAcme.com', entries), false);
  assert.equal(matchesSender('a@GLOBEX.com', entries), true);
  assert.equal(matchesSender('a@crm.globex.com', entries), true);
  assert.equal(matchesSender('a@globex.company', entries), false);
  assert.equal(matchesSender('Bob <BOB@initech.io>', entries), true);
  assert.equal(matchesSender('alice@initech.io', entries), false);
  assert.equal(matchesSender('nobody', entries), false);
});

test('html to text and quote/signature stripping', () => {
  assert.equal(htmlToText('<p>Hi&nbsp;there</p><div>Line <b>two</b></div>'), 'Hi there\nLine two');
  const body = 'Can you send the SOW by Friday?\n\nThanks,\nJane\n\nOn Tue, Jan 2, 2026 at 3:00 PM Me <me@example.com> wrote:\n> earlier stuff\n> more';
  const out = stripQuotesAndSignature(body);
  assert.equal(out, 'Can you send the SOW by Friday?');
  assert.equal(stripQuotesAndSignature('Thanks,\nsee attached'), 'Thanks,\nsee attached');
});

test('config merge is deep and arrays replace', () => {
  const out = merge({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9] });
  assert.deepEqual(out, { a: { b: 1, c: 3 }, l: [9] });
});

test('service goes stale after 3x poll interval', async () => {
  const s = new Service('t', { pollMs: 30 });
  s.onStart = async function () { this.setState({ ok: true }); };
  await s.start();
  assert.equal(s.status, 'connected');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(s.status, 'stale');
  await s.stop();
});

test('timers persist end timestamps across service restarts', async () => {
  const db = new Db(path.join(process.env.DOOMBAR_DATA, 't.sqlite'));
  const cfg = { timers: { presets: [1] } };
  const a = new TimersService({ config: cfg, db });
  await a.start();
  const { id } = await a.runAction('start', { minutes: 2, label: 'x' });
  await a.runAction('pause', { id });
  const pausedA = a.getState().data.timers[0];
  assert.equal(pausedA.running, false);
  await a.stop();

  const b = new TimersService({ config: cfg, db });
  await b.start();
  const t = b.getState().data.timers.find((x) => x.id === id);
  assert.ok(t); assert.equal(t.running, false); assert.ok(t.remainingMs > 100000);
  await b.runAction('add', { id, minutes: 5 });
  assert.ok(b.getState().data.timers[0].remainingMs > 400000);
  await b.runAction('dismiss', { id });
  assert.equal(b.getState().data.timers.length, 0);
  await b.stop();
  db.close();
});

test('timers: -5 on a running timer clamps to zero and fires, never negative', async () => {
  const db = new Db(path.join(process.env.DOOMBAR_DATA, 't2.sqlite'));
  const s = new TimersService({ config: { timers: {} }, db });
  await s.start();
  const { id } = await s.runAction('start', { minutes: 2, label: 'x' });
  await s.runAction('add', { id, minutes: -5 });
  let t = s.getState().data.timers[0];
  assert.equal(t.remainingMs, 0);
  s.tick();
  t = s.getState().data.timers[0];
  assert.equal(t.fired, true);
  assert.equal(t.remainingMs, 0);
  await s.runAction('dismiss', { id });
  await s.stop();
  db.close();
});

test.after(() => {
  const res = process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap' && r !== 'PipeWrap');
  if (res.length) console.error('active resources after tests:', res);
});

test('timer add accepts negative minutes and clamps at zero', async () => {
  const db = new Db(path.join(process.env.DOOMBAR_DATA, 't2.sqlite'));
  const s = new TimersService({ config: { timers: {} }, db });
  await s.start();
  const { id } = await s.runAction('start', { minutes: 10 });
  await s.runAction('add', { id, minutes: -4 });
  let t = s.getState().data.timers[0];
  assert.ok(t.remainingMs > 5 * 60000 && t.remainingMs <= 6 * 60000, `remaining ${t.remainingMs}`);
  assert.equal(t.totalMs, 6 * 60000); // a 10 min timer minus 4 is a 6 min timer
  await s.runAction('add', { id, minutes: -60 });
  t = s.getState().data.timers[0];
  assert.equal(t.remainingMs, 0);
  await s.runAction('pause', { id: (await s.runAction('start', { minutes: 3 })).id });
  const paused = s.getState().data.timers.find((x) => !x.running);
  await s.runAction('add', { id: paused.id, minutes: -1 });
  assert.equal(s.getState().data.timers.find((x) => x.id === paused.id).remainingMs, 2 * 60000);
  assert.deepEqual(s.getState().data.steps, [5, 10, 60]);
  await s.stop();
  db.close();
});

test('layout sanitizer permutes and resizes but never adds panels', () => {
  const { sanitizeLayout } = require('../main/layout');
  const current = [{ panel: 'a', width: 500 }, { panel: 'b', width: 300, extra: true }];
  assert.deepEqual(sanitizeLayout([{ panel: 'b', width: 400.4 }, { panel: 'a', width: 400 }], current),
    [{ panel: 'b', width: 400, extra: true }, { panel: 'a', width: 400 }]);
  assert.equal(sanitizeLayout([{ panel: 'a', width: 500 }], current), null);                  // dropped one
  assert.equal(sanitizeLayout([{ panel: 'a', width: 500 }, { panel: 'a', width: 300 }], current), null); // duplicate
  assert.equal(sanitizeLayout([{ panel: 'a', width: 500 }, { panel: 'c', width: 300 }], current), null); // unknown
  assert.equal(sanitizeLayout([{ panel: 'a', width: 10 }, { panel: 'b', width: 790 }], current), null);  // too narrow
});

test('email grouping: newest per client, unread ids and oldest unread per group', () => {
  const msg = (id, from, date, unread) => ({ id, from, date, unread });
  const sorted = [
    msg('a', 'Jane <jane@acme.com>', 500, false),
    msg('b', 'x@globex.com', 400, true),
    msg('c', 'Bob <bob@acme.com>', 300, true),
    msg('d', 'jane@acme.com', 200, true),
  ];
  const entries = ['acme', 'globex.com'];
  const byClient = groupMessages(sorted, 'client', entries);
  assert.deepEqual(byClient.map((g) => [g.head.id, g.unreadIds, g.unreadSince, g.total]), [['a', ['c', 'd'], 200, 3], ['b', ['b'], 400, 1]]);
  const bySender = groupMessages(sorted, 'sender', entries);
  assert.deepEqual(bySender.map((g) => [g.head.id, g.unreadIds]), [['a', ['d']], ['b', ['b']], ['c', ['c']]]);
  assert.equal(groupMessages(sorted, 'none', entries).length, 4);
});

test('email: team reply or label change marks mail handled and out of the alert', () => {
  const m = { id: 'm', from: 'Kim <kim@acme.com>', date: 100, labels: ['INBOX', 'UNREAD', 'Label_1'] };
  const team = ['example.com'];
  assert.equal(handledBy(m, [], ['Label_1'], team), null);
  assert.deepEqual(handledBy(m, [{ from: '"Sam Lee" <sam@mail.example.com>', date: 200, labels: [] }], ['Label_1'], team), { by: 'reply', name: 'Sam Lee' });
  assert.equal(handledBy(m, [{ from: 'sam@example.com', date: 50, labels: [] }], ['Label_1'], team), null); // earlier, not a reply
  assert.equal(handledBy(m, [{ from: 'bob@acme.com', date: 200, labels: [] }], ['Label_1'], team), null);
  assert.equal(handledBy(m, [{ from: 'me@gmail.com', date: 200, labels: ['SENT'] }], ['Label_1'], team).by, 'reply');
  assert.deepEqual(handledBy(m, [], [], team), { by: 'label' });
  assert.deepEqual(handledBy({ ...m, labels: ['INBOX'] }, [], ['Label_1'], team), { by: 'label' });

  const g = groupMessages([
    { id: 'a', from: 'x@acme.com', date: 300, unread: true },
    { id: 'b', from: 'y@acme.com', date: 200, unread: true, handled: { by: 'label' } },
  ], 'client', ['acme']);
  assert.deepEqual([g[0].unreadIds, g[0].unreadSince, g[0].alertIds, g[0].alertSince], [['a', 'b'], 200, ['a'], 300]);
});

test('slack: a teammate answering the customer takes the channel out of the alert', () => {
  const m = (ts, author, team) => ({ ts: String(ts), author, team, time: ts * 1000 });
  const ch = (messages, unread, lastRead = '0') => slackAlertOf({ messages, unread, lastRead });
  // Customer asked, Sam answered: handled, nothing alerts.
  assert.deepEqual(ch([m(1, 'Kim', false), m(2, 'Sam', true)], 2), { alerts: 0, alertSince: null, handled: { name: 'Sam' } });
  // Customer came back after the answer: that message alerts.
  assert.deepEqual(ch([m(1, 'Kim', false), m(2, 'Sam', true), m(3, 'Kim', false)], 3), { alerts: 1, alertSince: 3000, handled: null });
  // Nobody answered yet.
  assert.deepEqual(ch([m(1, 'Kim', false), m(2, 'Kim', false)], 2, '1'), { alerts: 1, alertSince: 2000, handled: null });
  // Internal channel: every unread alerts, from the oldest unread held.
  assert.deepEqual(ch([m(1, 'Ann', true), m(2, 'Sam', true)], 2), { alerts: 2, alertSince: 1000, handled: null });
  assert.deepEqual(ch([m(1, 'Kim', false)], 0), { alerts: 0, alertSince: null, handled: null });
});

test('slack: ignoreBots leaves unread bot messages out of the alert', () => {
  const m = (ts, author, team) => ({ ts: String(ts), author, team, time: ts * 1000 });
  const ch = (messages, unread, ignoreBots, lastRead = '0') => slackAlertOf({ messages, unread, lastRead }, { ignoreBots });
  const bots = [m(1, 'Ann', true), m(2, 'CI', null), m(3, 'CI', null)];
  assert.deepEqual(ch(bots, 2, true, '1'), { alerts: 0, alertSince: null, handled: null });
  assert.deepEqual(ch(bots, 2, false, '1'), { alerts: 2, alertSince: 2000, handled: null });
  assert.deepEqual(ch(bots, 3, true), { alerts: 1, alertSince: 1000, handled: null });
  // More unread than held: the unseen older ones still alert.
  assert.deepEqual(ch(bots.slice(1), 4, true), { alerts: 2, alertSince: 2000, handled: null });
});

test('entities decode once: named, numeric, hex; unknown left alone', () => {
  assert.equal(decodeEntities('run the &quot;Create in Booker&quot; &amp; it&#39;s &#x263A; &amp;lt; &bogus;'),
    'run the "Create in Booker" & it\'s \u263a &lt; &bogus;');
});

test('audio: Apple Music "Artist — Album" is split when the album is empty', () => {
  const { normalizeMedia } = require('../services/audio');
  const m = normalizeMedia({ title: 'Changing Clothes (Alt)', artist: 'Jeff Russo — Lucy in the Sky (Original Motion Picture Soundtrack)', album: '', status: 'Playing', app: 'AppleInc.AppleMusicWin_x!App', hasArt: true });
  assert.equal(m.artist, 'Jeff Russo');
  assert.equal(m.album, 'Lucy in the Sky (Original Motion Picture Soundtrack)');
  assert.equal(m.hasArt, true);
  assert.equal(normalizeMedia({ title: 'T', artist: 'A — B', album: 'Real' }).artist, 'A — B');
  assert.equal(normalizeMedia({ title: '' }), null);
});

test('email: calendar RSVPs never count as unread', () => {
  assert.equal(isCalendarReply('Accepted: Standup @ Tue 9am (jane@acme.com)', false), true);
  assert.equal(isCalendarReply('Declined: Review', false), true);
  assert.equal(isCalendarReply('Invitation: Review', false), false);
  assert.equal(isCalendarReply('Re: accepted terms', false), false);
  const ics = Buffer.from('BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR').toString('base64');
  const payload = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: '' } }, { mimeType: 'text/calendar', headers: [], body: { data: ics } }] };
  assert.equal(extractBody(payload).calendarReply, true);
  assert.equal(extractBody({ mimeType: 'text/calendar', headers: [{ name: 'Content-Type', value: 'text/calendar; charset=UTF-8; method=REQUEST' }], body: { data: '' } }).calendarReply, false);
  const g = groupMessages([{ id: 'a', from: 'jane@acme.com', date: 2, unread: true, calendarReply: true }, { id: 'b', from: 'jane@acme.com', date: 1, unread: true }], 'client', ['acme']);
  assert.deepEqual([g[0].unreadIds, g[0].alertIds, g[0].total], [['b'], ['b'], 2]);
});
