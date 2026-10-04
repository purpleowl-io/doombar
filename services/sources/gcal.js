'use strict';
// Google Calendar source for one account. Incremental fetch per calendar via
// syncToken; the caller asks for a full resync hourly.
const tz = require('../tz');
const { firstUrl } = require('./cal-util');

class GoogleCalendarSource {
  constructor({ account, auth }) {
    this.account = account;
    const { calendar } = require('@googleapis/calendar');
    this.cal = calendar({ version: 'v3', auth });
    this.stores = new Map(); // calendarId -> Map(eventId -> event)
    this.syncTokens = new Map();
  }

  // Events of calendar c ({ id, name, color }) from the start of today for 7 days.
  async sync(c, { full, timezone }) {
    const token = full ? null : this.syncTokens.get(c.id);
    const store = full || !this.stores.has(c.id) ? new Map() : this.stores.get(c.id);
    let pageToken;
    const params = { calendarId: c.id, singleEvents: true, showDeleted: true, maxResults: 250 };
    if (token) params.syncToken = token;
    else {
      params.timeMin = tz.startOfDay(new Date(), timezone).toISOString();
      params.timeMax = tz.startOfDay(new Date(), timezone, 7).toISOString();
      params.orderBy = 'startTime';
    }
    try {
      do {
        const res = await this.cal.events.list({ ...params, pageToken });
        for (const ev of res.data.items || []) {
          if (ev.status === 'cancelled') store.delete(ev.id);
          else store.set(ev.id, this.normalize(ev, c, timezone));
        }
        pageToken = res.data.nextPageToken;
        if (res.data.nextSyncToken) this.syncTokens.set(c.id, res.data.nextSyncToken);
      } while (pageToken);
      this.stores.set(c.id, store);
    } catch (e) {
      if (e.code === 410 || e.status === 410) {
        this.syncTokens.delete(c.id);
        return this.sync(c, { full: true, timezone });
      }
      throw e;
    }
    return [...store.values()];
  }

  normalize(ev, c, timezone) {
    const allDay = !!(ev.start && ev.start.date);
    const start = allDay ? tz.startOfDay(new Date(ev.start.date + 'T12:00:00Z'), timezone).getTime() : Date.parse(ev.start.dateTime);
    const end = allDay ? tz.startOfDay(new Date(ev.end.date + 'T12:00:00Z'), timezone).getTime() : Date.parse(ev.end.dateTime);
    const link = ev.hangoutLink
      || (ev.conferenceData && ev.conferenceData.entryPoints || []).find((p) => p.entryPointType === 'video')?.uri
      || firstUrl(ev.location) || firstUrl(ev.description) || null;
    return {
      id: `${this.account.id}:${ev.id}`,
      uid: ev.iCalUID || ev.id,
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

  // For setup: { id, name, color, primary }. The primary calendar is "primary".
  async calendars() {
    const res = await this.cal.calendarList.list({ maxResults: 250 });
    return (res.data.items || []).map((c) => ({ id: c.primary ? 'primary' : c.id, altId: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || null, primary: !!c.primary }));
  }
}

module.exports = { GoogleCalendarSource };
