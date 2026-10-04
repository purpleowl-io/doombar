'use strict';
// Calendar panel: today's remaining events and tomorrow's, merged from several
// Google calendars, in the display timezone. Incremental fetch via syncToken,
// full resync hourly.
const { Service } = require('./base');
const { authClient } = require('./google');
const tz = require('./tz');

class CalendarService extends Service {
  constructor(opts) {
    const cfg = (opts.config && opts.config.calendar) || {};
    super('calendar', { ...opts, pollMs: (cfg.pollSeconds || 120) * 1000 });
    this.cfg = cfg;
    this.tz = (opts.config && opts.config.display && opts.config.display.timezone) || 'America/Phoenix';
    this.openExternal = opts.openExternal || (async (url) => this.log.info('open', url));
    this.cal = null;
    this.events = new Map(); // calendarId -> Map(eventId -> event)
    this.syncTokens = new Map();
    this.lastFullSync = 0;
    this.calendarsKey = JSON.stringify(cfg.calendars || []);
    this.state = { events: [], nextId: null, alertMinutes: cfg.alertMinutes || 5, timezone: this.tz, snoozed: [] };
  }

  async onStart() {
    const auth = authClient();
    if (!auth) { this.disable('Google not connected - open setup (Doombar.exe --setup)'); return; }
    const { calendar } = require('@googleapis/calendar');
    this.cal = calendar({ version: 'v3', auth });
    this.poll(() => this.tick(), this.pollMs);
    // Re-publish every 30 s so "next event" flips over without a network call.
    this.poll(() => { if (this.lastUpdated) this.publish(false); }, 30000, { immediate: false });
  }

  // Calendars or colours changed in setup: drop everything and resync.
  async onConfig() {
    const key = JSON.stringify(this.cfg.calendars || []);
    if (!this.cal || key === this.calendarsKey) return;
    this.calendarsKey = key;
    this.events.clear(); this.syncTokens.clear(); this.lastFullSync = 0;
    await this.tick();
  }

  calendars() {
    const list = this.cfg.calendars && this.cfg.calendars.length ? this.cfg.calendars : [{ id: 'primary' }];
    return list.map((c) => (typeof c === 'string' ? { id: c } : c));
  }

  async tick() {
    const now = Date.now();
    const full = now - this.lastFullSync > (this.cfg.fullResyncMinutes || 60) * 60 * 1000;
    for (const c of this.calendars()) {
      await this.syncCalendar(c, full);
    }
    if (full) this.lastFullSync = now;
    this.publish(true);
  }

  async syncCalendar(c, full) {
    const token = full ? null : this.syncTokens.get(c.id);
    const store = full || !this.events.has(c.id) ? new Map() : this.events.get(c.id);
    let pageToken;
    const params = { calendarId: c.id, singleEvents: true, showDeleted: true, maxResults: 250 };
    if (token) params.syncToken = token;
    else {
      params.timeMin = tz.startOfDay(new Date(), this.tz).toISOString();
      params.timeMax = tz.startOfDay(new Date(), this.tz, 7).toISOString();
      params.orderBy = 'startTime';
    }
    try {
      do {
        const res = await this.cal.events.list({ ...params, pageToken });
        for (const ev of res.data.items || []) {
          if (ev.status === 'cancelled') store.delete(ev.id);
          else store.set(ev.id, this.normalize(ev, c));
        }
        pageToken = res.data.nextPageToken;
        if (res.data.nextSyncToken) this.syncTokens.set(c.id, res.data.nextSyncToken);
      } while (pageToken);
      this.events.set(c.id, store);
    } catch (e) {
      if (e.code === 410 || e.status === 410) {
        this.syncTokens.delete(c.id);
        return this.syncCalendar(c, true);
      }
      throw e;
    }
  }

  normalize(ev, c) {
    const allDay = !!(ev.start && ev.start.date);
    const start = allDay ? tz.startOfDay(new Date(ev.start.date + 'T12:00:00Z'), this.tz).getTime() : Date.parse(ev.start.dateTime);
    const end = allDay ? tz.startOfDay(new Date(ev.end.date + 'T12:00:00Z'), this.tz).getTime() : Date.parse(ev.end.dateTime);
    const link = ev.hangoutLink
      || (ev.conferenceData && ev.conferenceData.entryPoints || []).find((p) => p.entryPointType === 'video')?.uri
      || firstUrl(ev.location) || firstUrl(ev.description) || null;
    return {
      id: ev.id,
      calendarId: c.id,
      calendarName: c.name || c.id,
      color: c.color || '#7c9cff',
      title: ev.summary || '(untitled)',
      start, end, allDay,
      location: ev.location || '',
      attendees: (ev.attendees || []).filter((a) => !a.resource).length,
      meetingUrl: link,
      htmlLink: ev.htmlLink,
      responseStatus: ((ev.attendees || []).find((a) => a.self) || {}).responseStatus || null,
    };
  }

  publish(touch) {
    const now = Date.now();
    // The whole fetched week goes out: the panel's normal view shows today and
    // tomorrow, its "more" view the rest. dayStart labels the later days.
    const starts = Array.from({ length: 8 }, (_, i) => tz.startOfDay(new Date(now), this.tz, i).getTime());
    const snoozed = this.db ? this.db.kvGet('calendar.snoozed', {}) : {};
    for (const [id, until] of Object.entries(snoozed)) if (until < now) delete snoozed[id];

    const events = [];
    for (const store of this.events.values()) {
      for (const ev of store.values()) {
        if (ev.end <= now && !ev.allDay) continue; // finished
        if (ev.start >= starts[7] || ev.end <= starts[0]) continue;
        if (ev.responseStatus === 'declined') continue;
        const i = Math.max(0, starts.findIndex((s, k) => ev.start < starts[k + 1]));
        events.push({ ...ev, day: i === 0 ? 'today' : i === 1 ? 'tomorrow' : 'later', dayStart: starts[i], snoozed: !!snoozed[ev.id] });
      }
    }
    events.sort((a, b) => a.start - b.start || (a.allDay ? -1 : 1));
    const next = events.find((e) => !e.allDay && e.end > now && e.day !== 'later') || null;
    this.setState({ events, nextId: next ? next.id : null, alertMinutes: this.cfg.alertMinutes || 5, timezone: this.tz, snoozed: Object.keys(snoozed) }, { touch: !!touch });
  }

  find(id) {
    for (const store of this.events.values()) if (store.has(id)) return store.get(id);
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

function firstUrl(text) {
  const m = /https?:\/\/[^\s<>"']+/.exec(String(text || ''));
  return m ? m[0] : null;
}

module.exports = { CalendarService };

if (require.main === module) {
  require('./standalone').runStandalone(CalendarService, { waitMs: 20000 });
}
