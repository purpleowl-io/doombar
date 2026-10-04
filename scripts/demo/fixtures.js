'use strict';
// Made-up Slack, Email and Calendar services for screenshots and recordings
// (scripts/demo/run.js). Same state shapes as the real services, no network,
// no accounts. Every company and person here is fictional; times are relative
// to now so the countdown and the unread tint look live.
const { Service } = require('../../services/base');

const MIN = 60000;
const now = Date.now();
const ago = (m) => now - m * MIN;

// Local midnight `d` days from today, and a clock time on that day.
function dayStart(d) { const t = new Date(now); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() + d); return t.getTime(); }
function at(d, hh, mm = 0) { return dayStart(d) + (hh * 60 + mm) * MIN; }
// The next quarter hour at least `m` minutes away: the "next meeting" lands on a round time.
function soon(m) { const q = 15 * MIN; return Math.ceil((now + m * MIN) / q) * q; }

class Fixture extends Service {
  constructor(name, build, actions = {}) {
    super(name, {});
    this.build = build;
    this.actions = actions;
  }
  async onStart() { this.setState(this.build()); }
}

// --- Slack -------------------------------------------------------------------

function slack() {
  const msg = (author, text, m) => ({ author, text, time: ago(m) });
  const ch = (c) => {
    const latest = c.messages[c.messages.length - 1];
    return { unread: 0, mentioned: false, handled: null, quiet: false, alerts: c.unread || 0, alertSince: c.unread ? latest.time : null, ...c, latest, unreadSince: c.unread ? latest.time : null };
  };
  const channels = [
    ch({ id: 'C1', type: 'private', name: 'ext-northwind', unread: 3, mentioned: true, messages: [
      msg('Jordan', 'Staging is green, cutting the release branch now', 95),
      msg('Maya Chen', 'Great, our QA team can start tomorrow morning', 12),
      msg('Maya Chen', 'One thing: the SSO redirect still points at the old domain', 8),
      msg('Maya Chen', '@Alex can you confirm the go-live date before our 4pm?', 4),
    ] }),
    ch({ id: 'D1', type: 'im', name: 'Dana Whitfield', unread: 1, messages: [
      msg('Dana Whitfield', 'Pushed the pricing deck, comments welcome before Tuesday', 6),
    ] }),
    ch({ id: 'C2', type: 'private', name: 'ext-fabrikam', unread: 2, alerts: 0, alertSince: null, handled: { name: 'Jordan' }, messages: [
      msg('Luis Ortega', 'Seeing a 502 on the export endpoint again', 41),
      msg('Luis Ortega', 'Only for files over 2 GB it seems', 39),
      msg('Jordan', 'On it, it is the upload timeout. Patch going out within the hour', 33),
    ] }),
    ch({ id: 'C3', type: 'public', name: 'eng-platform', messages: [
      msg('Priya', 'Postgres 17 upgrade done on staging, no regressions so far', 70),
      msg('Sam', 'Nice. Prod window Thursday?', 64),
    ] }),
    ch({ id: 'C4', type: 'public', name: 'releases', messages: [
      msg('deploybot', 'v2.14.0 deployed to production (38 commits)', 180),
    ] }),
    ch({ id: 'C5', type: 'private', name: 'ext-contoso', messages: [
      msg('Rachel Kim', 'Thanks for the walkthrough today, very helpful', 26 * 60),
    ] }),
  ];
  return { channels, teamId: 'T0', activeDays: 14, watched: channels.length };
}

// --- Email -------------------------------------------------------------------

function email() {
  const m = (o) => ({ unread: false, handled: null, isProspect: false, attachments: 0, summary: null, accountLabel: null, ...o });
  const messages = [
    m({ id: 'e1', fromName: 'Maya Chen', accountLabel: 'Work', subject: 'Re: Q4 rollout timeline', snippet: 'Following up on the cutover plan: can we move the freeze to the 14th so our QA team has a full week?', date: ago(14), unread: true, unreadIds: ['e1', 'e1b'], alertIds: ['e1', 'e1b'], alertSince: ago(14) }),
    m({ id: 'e2', fromName: 'Lakeshore Health', accountLabel: 'M365', isProspect: true, subject: 'Evaluating data platform partners', snippet: 'Hi Alex, we were referred by the Northwind team and are looking for help consolidating three warehouses…', date: ago(9), unread: true, unreadIds: ['e2'], alertIds: ['e2'], alertSince: ago(9),
      summary: 'Wants: a partner to consolidate three data warehouses into one platform. Deadline: shortlist by Oct 17. Asks you to: send case studies and propose a 30-minute intro call next week.' }),
    m({ id: 'e3', fromName: 'Luis Ortega', accountLabel: 'Work', subject: 'Export failures on large files', snippet: 'We are still seeing timeouts on exports over 2 GB. Attaching the request IDs from this morning.', date: ago(38), unread: true, unreadIds: ['e3'], alertIds: [], alertSince: null, handled: { by: 'reply', name: 'Jordan' } }),
    m({ id: 'e4', fromName: 'Rachel Kim', accountLabel: 'M365', subject: 'Signed SOW and kickoff dates', snippet: 'Attached is the countersigned SOW. Our team is available for kickoff any day the week of the 19th.', date: ago(26 * 60), attachments: 2 }),
    m({ id: 'e5', fromName: 'Tailspin Toys', accountLabel: 'Work', subject: 'Invoice #1042 received', snippet: 'Thanks, invoice received and scheduled for payment on net-30 terms.', date: ago(2 * 24 * 60) }),
    m({ id: 'e6', fromName: 'Wingtip Labs', accountLabel: 'Work', isProspect: true, subject: 'Re: follow-up from the meetup', snippet: 'Great meeting you at the meetup. Could you share the architecture doc you mentioned?', date: ago(3 * 24 * 60 + 200) }),
  ];
  return {
    messages, newerThanDays: 7, maxMessages: 8, summariesAvailable: true, summaryErrors: {},
    accounts: [{ id: 'g1', label: 'Work' }, { id: 'm1', label: 'M365' }],
  };
}

// --- Calendar ----------------------------------------------------------------

const WORK = '#7c9cff', M365 = '#4fc3a1', PERSONAL = '#ff7aa2';

function calendar() {
  const meet = 'https://meet.example.com/demo';
  const next = soon(18);
  const raw = [
    { id: 'c3', title: 'Fabrikam pilot review', start: next, mins: 45, color: WORK, meetingUrl: meet, attendees: 6 },
    { id: 'c4', title: '1:1 Dana', start: next + 75 * MIN, mins: 30, color: M365, meetingUrl: meet, attendees: 2 },
    { id: 'c5', title: 'Lakeshore Health intro', start: next + 135 * MIN, mins: 30, color: WORK, meetingUrl: meet, attendees: 4 },
    { id: 'c7', title: 'Northwind go-live planning', start: at(1, 10, 30), mins: 60, color: M365, meetingUrl: meet, attendees: 9 },
    { id: 'c9', title: 'Contoso SOW walkthrough', start: at(2, 10), mins: 45, color: WORK, meetingUrl: meet, attendees: 5 },
    { id: 'c11', title: 'Quarterly planning', start: at(2, 13), mins: 120, color: WORK, attendees: 12 },
    { id: 'c12', title: 'Lunch with Priya', start: at(3, 12, 30), mins: 60, color: PERSONAL },
    { id: 'c13', title: 'Fabrikam architecture deep dive', start: at(3, 14), mins: 90, color: M365, meetingUrl: meet, attendees: 8 },
    { id: 'c14', title: 'Office hours', start: at(4, 10), mins: 60, color: WORK, meetingUrl: meet },
    { id: 'c15', title: 'Tailspin renewal call', start: at(4, 16), mins: 30, color: M365, meetingUrl: meet, attendees: 3 },
  ];
  const t0 = dayStart(0);
  const events = raw.map(({ mins, ...e }) => {
    const i = Math.floor((e.start - t0) / (24 * 60 * MIN));
    return { attendees: 0, meetingUrl: null, allDay: false, ...e, end: e.start + mins * MIN, day: i === 0 ? 'today' : i === 1 ? 'tomorrow' : 'later', dayStart: dayStart(i), snoozed: false };
  });
  return {
    events, nextId: 'c3', alertMinutes: 5, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, snoozed: [],
    accounts: [{ id: 'g1', label: 'Work' }, { id: 'm1', label: 'M365' }],
  };
}

// Taps on rows do nothing harmful: actions are accepted and ignored.
const inert = (names) => Object.fromEntries(names.map((n) => [n, async () => ({ ok: true })]));

module.exports = {
  SlackService: class extends Fixture { constructor() { super('slack', slack, inert(['markRead', 'open', 'expand'])); } },
  EmailService: class extends Fixture { constructor() { super('email', email, inert(['markRead', 'archive', 'open', 'summarize'])); } },
  CalendarService: class extends Fixture { constructor() { super('calendar', calendar, inert(['join', 'open', 'snooze'])); } },
  WORK, M365, PERSONAL,
};
