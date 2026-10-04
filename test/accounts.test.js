'use strict';
// Multi-account mail/calendar: account resolution, merging, and the Outlook
// normalisers (with a fake Graph).
const test = require('node:test');
const assert = require('node:assert/strict');

const { listAccounts, accountSlug, accountLabel, tokenSecret, upsertAccount, removeAccount } = require('../services/accounts');
const { resolveCalendars } = require('../services/calendar');
const { dedupe, handledBy } = require('../services/email');
const { dedupeEvents } = require('../services/sources/cal-util');
const { OutlookCalendarSource } = require('../services/sources/outlook-calendar');
const { OutlookMailSource, fromString } = require('../services/sources/outlook-mail');
const { sanitizeSettings } = require('../main/settings');

const none = () => false;
const legacyToken = (n) => n === 'GOOGLE_REFRESH_TOKEN';

test('accounts: slug, label, token secret name', () => {
  assert.equal(accountSlug('Alex@EWS.contoso.com'), 'alex-ews-contoso-com');
  assert.equal(accountLabel({ email: 'alex@ews.contoso.com' }), 'ews');
  assert.equal(accountLabel({ email: 'a@b.com', label: 'Client B' }), 'Client B');
  assert.equal(tokenSecret({ id: 'alex-ews-contoso-com' }), 'TOKEN_ALEX_EWS_CONTOSO_COM');
  assert.equal(tokenSecret({ id: 'google', secret: 'GOOGLE_REFRESH_TOKEN' }), 'GOOGLE_REFRESH_TOKEN');
});

test('accounts: legacy single Google token becomes account "google" until a list exists', () => {
  assert.deepEqual(listAccounts({}, none), []);
  const [a] = listAccounts({}, legacyToken);
  assert.equal(a.id, 'google'); assert.equal(a.secret, 'GOOGLE_REFRESH_TOKEN'); assert.equal(a.mail, true);
  // With a list, the legacy token is only used if the list names it.
  assert.deepEqual(listAccounts({ accounts: [{ provider: 'microsoft', email: 'x@y.com' }] }, legacyToken).map((x) => x.id), ['x-y-com']);
});

test('accounts: unknown providers and duplicate ids dropped; flags default on', () => {
  const list = listAccounts({ accounts: [
    { provider: 'google', email: 'A@x.com' }, { provider: 'yahoo', email: 'b@x.com' },
    { provider: 'microsoft', email: 'a@x.com' }, { provider: 'microsoft', email: 'c@x.com', mail: false },
  ] }, none);
  assert.deepEqual(list.map((a) => [a.id, a.provider, a.mail, a.calendar]), [['a-x-com', 'google', true, true], ['c-x-com', 'microsoft', false, true]]);
});

test('accounts: upsert materialises the legacy account, remove drops one', () => {
  const list = upsertAccount({}, { id: 'alex-ews-contoso-com', provider: 'microsoft', email: 'alex@ews.contoso.com' }, legacyToken);
  assert.deepEqual(list.map((a) => a.id), ['google', 'alex-ews-contoso-com']);
  assert.equal(list[0].secret, 'GOOGLE_REFRESH_TOKEN');
  const updated = upsertAccount({ accounts: list }, { id: 'google', provider: 'google', email: 'alex@contoso.com' }, none);
  assert.equal(updated.length, 2); assert.equal(updated[0].email, 'alex@contoso.com'); assert.equal(updated[0].secret, 'GOOGLE_REFRESH_TOKEN');
  assert.deepEqual(removeAccount({ accounts: list }, 'google', none).map((a) => a.id), ['alex-ews-contoso-com']);
});

test('calendar: entries without account go to the first Google account; bare accounts show primary', () => {
  const accounts = [{ id: 'ms', provider: 'microsoft', label: 'ews' }, { id: 'g1', provider: 'google', label: 'po' }, { id: 'g2', provider: 'google', label: 'cl' }];
  const cals = resolveCalendars([{ id: 'primary', name: 'Work' }, { id: 'team@group', account: 'g2' }, { id: 'x', account: 'gone' }], accounts);
  assert.deepEqual(cals.map((c) => [c.account, c.id]), [['g1', 'primary'], ['g2', 'team@group'], ['ms', 'primary']]);
  assert.equal(cals[2].name, 'ews');
  assert.deepEqual(resolveCalendars(undefined, []), []);
});

test('calendar: the same meeting in two accounts shows once, first calendar wins', () => {
  const evs = dedupeEvents([
    { id: 'g:1', uid: 'abc@google.com', start: 10, calendarName: 'Work' },
    { id: 'ms:9', uid: 'abc@google.com', start: 10, calendarName: 'ews' },
    { id: 'g:2', uid: 'abc@google.com', start: 20 }, // another occurrence of a series
  ]);
  assert.deepEqual(evs.map((e) => e.id), ['g:1', 'g:2']);
});

test('email: copies of one message (same Message-ID) fold; unread only while every copy is', () => {
  const { messages, copies } = dedupe([
    { id: 'g:1', messageId: '<M1@x>', unread: true },
    { id: 'ms:a', messageId: '<m1@x>', unread: false },
    { id: 'g:2', messageId: null, unread: true },
    { id: 'ms:b', messageId: null, unread: true },
  ]);
  assert.deepEqual(messages.map((m) => [m.id, m.unread]), [['g:1', false], ['g:2', true], ['ms:b', true]]);
  assert.deepEqual([...copies], [['g:1', ['ms:a']]]);
});

test('email: handledBy takes provider-neutral sent flag and tags', () => {
  const m = { id: 'm', from: 'Kim <kim@acme.com>', date: 100, tags: ['Blue category'] };
  assert.equal(handledBy(m, [{ from: 'me@ews.example.com', date: 200, sent: true }], ['Blue category'], []).by, 'reply');
  assert.equal(handledBy(m, [], ['Blue category'], []), null);
  assert.deepEqual(handledBy({ ...m, tags: [] }, [], ['Blue category'], []), { by: 'label' });
});

test('outlook: sender string, calendar normalisation', () => {
  assert.equal(fromString({ emailAddress: { name: 'Kim Lee', address: 'kim@acme.com' } }), '"Kim Lee" <kim@acme.com>');
  assert.equal(fromString({ emailAddress: { address: 'kim@acme.com' } }), 'kim@acme.com');
  const src = new OutlookCalendarSource({ account: { id: 'ms' }, auth: null });
  const c = { id: 'primary', name: 'ews', color: '#4fc3a1' };
  const timed = src.normalize({
    id: 'E1', iCalUId: 'U1', subject: 'Sync', isAllDay: false,
    start: { dateTime: '2026-10-05T20:30:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-05T21:00:00.0000000', timeZone: 'UTC' },
    attendees: [{ type: 'required' }, { type: 'resource' }], onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/x' },
    responseStatus: { response: 'tentativelyAccepted' }, webLink: 'https://outlook.office365.com/owa/?itemid=E1',
  }, c, 'America/Phoenix');
  assert.equal(timed.id, 'ms:E1'); assert.equal(timed.uid, 'U1');
  assert.equal(timed.start, Date.parse('2026-10-05T20:30:00Z'));
  assert.equal(timed.attendees, 1); assert.equal(timed.meetingUrl, 'https://teams.microsoft.com/l/x'); assert.equal(timed.responseStatus, 'tentative');
  const allDay = src.normalize({ id: 'E2', subject: 'Off', isAllDay: true, start: { dateTime: '2026-10-06T00:00:00.0000000' }, end: { dateTime: '2026-10-07T00:00:00.0000000' }, responseStatus: { response: 'organizer' } }, c, 'America/Phoenix');
  assert.equal(allDay.start, Date.parse('2026-10-06T07:00:00Z')); // midnight in Phoenix
  assert.equal(allDay.end - allDay.start, 86400000);
  assert.equal(allDay.responseStatus, 'accepted');
  assert.equal(src.normalize({ id: 'E3', isAllDay: false, start: { dateTime: '2026-10-05T20:30:00' }, end: { dateTime: '2026-10-05T21:00:00' }, location: { displayName: 'https://zoom.us/j/1' } }, c, 'UTC').meetingUrl, 'https://zoom.us/j/1');
});

test('outlook mail: list filters by sender, fetches new matches in full, reuses cached ones', async () => {
  const calls = [];
  const graph = {
    list: async () => [
      { id: 'A', conversationId: 'C1', internetMessageId: '<a@x>', from: { emailAddress: { name: 'Kim', address: 'kim@acme.com' } }, subject: 'Hi', receivedDateTime: '2026-10-01T10:00:00Z', bodyPreview: 'preview', isRead: false, hasAttachments: true, categories: ['Red'], webLink: 'https://outlook/A' },
      { id: 'B', from: { emailAddress: { address: 'news@spam.com' } }, subject: 'Sale', receivedDateTime: '2026-10-01T09:00:00Z', isRead: false, categories: [] },
      { id: 'C', from: { emailAddress: { address: 'bob@acme.com' } }, subject: 'Accepted: Sync', receivedDateTime: '2026-10-01T08:00:00Z', isRead: true, categories: [] },
    ],
    get: async (path) => {
      calls.push(path);
      if (path.includes('/attachments')) return { value: [{ name: 'a.pdf', isInline: false }, { name: 'logo.png', isInline: true }] };
      return { body: { content: 'Hello\r\nthere' } };
    },
  };
  const src = new OutlookMailSource({ account: { id: 'ms', email: 'me@ews.example.com' }, auth: graph });
  const cache = new Map([['C', { id: 'ms:C', rawId: 'C', from: 'bob@acme.com', subject: 'Accepted: Sync', calendarReply: true, unread: false, tags: [], snippet: '' }]]);
  const out = await src.list({ days: 30, scan: 300, cached: (r) => cache.get(r), match: (from) => /acme\.com/.test(from) });
  assert.deepEqual(out.map((m) => m.id), ['ms:A', 'ms:C']);
  const a = out[0];
  assert.equal(a.from, '"Kim" <kim@acme.com>'); assert.equal(a.threadId, 'C1'); assert.equal(a.messageId, '<a@x>');
  assert.equal(a.unread, true); assert.equal(a.attachments, 1); assert.deepEqual(a.tags, ['Red']);
  assert.equal(a._body, 'Hello\nthere'); assert.equal(src.url(a), 'https://outlook/A');
  assert.equal(calls.filter((p) => p.startsWith('/me/messages/C')).length, 0); // cached: no refetch
});

test('settings: calendar entries keep a valid account id', () => {
  const p = sanitizeSettings({ calendar: { calendars: [{ id: 'primary', account: 'alex-ews-contoso-com' }, { id: 'x', account: 'Bad Id!' }] } });
  assert.deepEqual(p.calendar.calendars, [{ id: 'primary', account: 'alex-ews-contoso-com' }, { id: 'x' }]);
});
