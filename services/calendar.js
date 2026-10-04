'use strict';
// Calendar panel: today's remaining events and tomorrow's (plus the week for the
// "more" view), merged from every calendar of every account in config.accounts,
// Google and Microsoft 365, in the display timezone. A meeting in several
// calendars shows once. Google syncs incrementally (syncToken, full resync hourly);
// Microsoft refetches the week each poll.
//
// calendar.calendars entries: { account?, id, name?, color? }. No account means the
// first Google account (what entries meant before there were several). A calendar
// account with no entries shows its primary calendar.
const { Service } = require('./base');
const { listAccounts, clientFor } = require('./accounts');
const { dedupeEvents } = require('./sources/cal-util');
const tz = require('./tz');

const ACCOUNT_COLORS = ['#7c9cff', '#4fc3a1', '#f5b950', '#ff7aa2', '#b388ff'];

// Calendars to show, each with its account id. Pure, for tests.
function resolveCalendars(configured, accounts) {
  const fallback = (accounts.find((a) => a.provider === 'google') || accounts[0] || {}).id;
  const list = (configured || []).map((c) => (typeof c === 'string' ? { id: c } : c)).map((c) => ({ ...c, account: c.account || fallback }));
  const out = list.filter((c) => accounts.some((a) => a.id === c.account));
  accounts.forEach((a, i) => {
    if (!list.some((c) => c.account === a.id)) out.push({ id: 'primary', account: a.id, name: a.label, color: ACCOUNT_COLORS[i % ACCOUNT_COLORS.length] });
  });
  return out;
}

class CalendarService extends Service {
  constructor(opts) {
    const cfg = (opts.config && opts.config.calendar) || {};
    super('calendar', { ...opts, pollMs: (cfg.pollSeconds || 120) * 1000 });
    this.cfg = cfg;
    this.tz = (opts.config && opts.config.display && opts.config.display.timezone) || 'America/Phoenix';
    this.openExternal = opts.openExternal || (async (url) => this.log.info('open', url));
    this.sources = new Map(); // accountId -> { account, src, error }
    this.events = new Map(); // "account|calendarId" -> [event]
    this.lastFullSync = 0;
    this.key = '';
    this.polling = false;
    this.state = { events: [], nextId: null, alertMinutes: cfg.alertMinutes || 5, timezone: this.tz, snoozed: [], accounts: [] };
  }

  async onStart() {
    this.buildSources();
    if (!this.sources.size) { this.disable('No calendar account connected - open setup (Doombar.exe --setup)'); return; }
    this.startPolling();
  }

  startPolling() {
    if (this.polling) return;
    this.polling = true;
    this.poll(() => this.tick(), this.pollMs);
    // Re-publish every 30 s so "next event" flips over without a network call.
    this.poll(() => { if (this.lastUpdated) this.publish(false); }, 30000, { immediate: false });
  }

  calendarAccounts() { return listAccounts(this.config).filter((a) => a.calendar); }

  calendars() { return resolveCalendars(this.cfg.calendars, this.calendarAccounts()); }

  configKey() { return JSON.stringify([this.calendarAccounts().map((a) => [a.id, a.provider, a.email]), this.calendars()]); }

  buildSources() {
    this.key = this.configKey();
    this.sources.clear();
    for (const account of this.calendarAccounts()) {
      const entry = { account, src: null, error: null };
      try {
        const auth = clientFor(account);
        entry.src = account.provider === 'google'
          ? new (require('./sources/gcal').GoogleCalendarSource)({ account, auth })
          : new (require('./sources/outlook-calendar').OutlookCalendarSource)({ account, auth });
      } catch (e) { entry.error = e.message; }
      this.sources.set(account.id, entry);
    }
  }

  // Accounts, calendars or colours changed in setup: drop everything and resync.
  async onConfig() {
    if (this.configKey() === this.key) return;
    this.buildSources();
    this.events.clear(); this.lastFullSync = 0;
    if (!this.sources.size) { this.setState({ events: [], nextId: null, accounts: [] }); this.disable('No calendar account connected - open setup (Doombar.exe --setup)'); return; }
    if (!this.polling) { this.setStatus('starting'); this.startPolling(); } else await this.tick();
  }

  async tick() {
    const now = Date.now();
    const full = now - this.lastFullSync > (this.cfg.fullResyncMinutes || 60) * 60 * 1000;
    for (const e of this.sources.values()) if (e.src) e.error = null;
    let ok = 0;
    const cals = this.calendars();
    await Promise.all(cals.map(async (c) => {
      const e = this.sources.get(c.account);
      if (!e || !e.src) return;
      try {
        this.events.set(`${c.account}|${c.id}`, await e.src.sync(c, { full, timezone: this.tz }));
        ok++;
      } catch (err) {
        e.error = `${c.name || c.id}: ${err.message}`;
        this.log.warn(`${e.account.email || e.account.id} ${e.error}`);
      }
    }));
    if (!ok) throw new Error([...this.sources.values()].map((e) => e.error).filter(Boolean).join('; ') || 'no calendar reachable');
    if (full) this.lastFullSync = now;
    // Drop calendars no longer configured.
    const keys = new Set(cals.map((c) => `${c.account}|${c.id}`));
    for (const k of this.events.keys()) if (!keys.has(k)) this.events.delete(k);
    this.publish(true);
  }

  publish(touch) {
    const now = Date.now();
    // The whole fetched week goes out: the panel's normal view shows today and
    // tomorrow, its "more" view the rest. dayStart labels the later days.
    const starts = Array.from({ length: 8 }, (_, i) => tz.startOfDay(new Date(now), this.tz, i).getTime());
    const snoozed = this.db ? this.db.kvGet('calendar.snoozed', {}) : {};
    for (const [id, until] of Object.entries(snoozed)) if (until < now) delete snoozed[id];

    const ordered = this.calendars().flatMap((c) => this.events.get(`${c.account}|${c.id}`) || []);
    const events = [];
    for (const ev of dedupeEvents(ordered)) {
      if (ev.end <= now && !ev.allDay) continue; // finished
      if (ev.start >= starts[7] || ev.end <= starts[0]) continue;
      if (ev.responseStatus === 'declined') continue;
      const i = Math.max(0, starts.findIndex((s, k) => ev.start < starts[k + 1]));
      events.push({ ...ev, day: i === 0 ? 'today' : i === 1 ? 'tomorrow' : 'later', dayStart: starts[i], snoozed: !!snoozed[ev.id] });
    }
    events.sort((a, b) => a.start - b.start || (a.allDay ? -1 : 1));
    const next = events.find((e) => !e.allDay && e.end > now && e.day !== 'later') || null;
    const accounts = [...this.sources.values()].map((e) => ({ id: e.account.id, label: e.account.label, provider: e.account.provider, error: e.error }));
    this.setState({ events, nextId: next ? next.id : null, alertMinutes: this.cfg.alertMinutes || 5, timezone: this.tz, snoozed: Object.keys(snoozed), accounts }, { touch: !!touch });
  }

  find(id) {
    for (const list of this.events.values()) { const e = list.find((x) => x.id === id); if (e) return e; }
    return null;
  }

  actions = {
    open: async ({ id }) => { const e = this.find(id); if (e && e.htmlLink) await this.openExternal(e.htmlLink); },
    join: async ({ id }) => { const e = this.find(id); if (e && e.meetingUrl) await this.openExternal(e.meetingUrl); },
    snooze: async ({ id, minutes = 10 }) => {
      if (!this.db) return;
      const s = this.db.kvGet('calendar.snoozed', {});
      s[id] = Date.now() + Number(minutes) * 60000;
      this.db.kvSet('calendar.snoozed', s);
      this.publish(false);
    },
    refresh: async () => { this.lastFullSync = 0; await this.tick(); },
  };
}

module.exports = { CalendarService, resolveCalendars };

if (require.main === module) {
  require('./standalone').runStandalone(CalendarService, { waitMs: 20000 });
}
