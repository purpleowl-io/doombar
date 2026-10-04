'use strict';
// Microsoft 365 calendar source for one account (Graph calendarView). A week of
// one calendar is a single request, so every poll is a full fetch; no delta state.
const tz = require('../tz');
const { firstUrl } = require('./cal-util');

const FIELDS = 'id,iCalUId,subject,start,end,isAllDay,isCancelled,location,attendees,onlineMeeting,onlineMeetingUrl,webLink,responseStatus,bodyPreview';
// Times come back as UTC; all-day events are midnight-to-midnight in any zone, so
// their date part is the calendar date.
const UTC = { Prefer: 'outlook.timezone="UTC"' };

// Graph response -> Google's vocabulary, which the panel already speaks.
const RESPONSE = { declined: 'declined', accepted: 'accepted', organizer: 'accepted', tentativelyAccepted: 'tentative', notResponded: 'needsAction', none: null };

class OutlookCalendarSource {
  constructor({ account, auth }) {
    this.account = account;
    this.graph = auth;
  }

  async sync(c, { timezone }) {
    const from = tz.startOfDay(new Date(), timezone).toISOString();
    const to = tz.startOfDay(new Date(), timezone, 7).toISOString();
    const base = c.id === 'primary' ? '/me/calendar' : `/me/calendars/${encodeURIComponent(c.id)}`;
    const items = await this.graph.list(`${base}/calendarView?startDateTime=${from}&endDateTime=${to}&$top=250&$select=${FIELDS}`, { headers: UTC, limit: 1000 });
    return items.filter((ev) => !ev.isCancelled).map((ev) => this.normalize(ev, c, timezone));
  }

  normalize(ev, c, timezone) {
    const allDay = !!ev.isAllDay;
    const at = (t) => (allDay
      ? tz.startOfDay(new Date(t.dateTime.slice(0, 10) + 'T12:00:00Z'), timezone).getTime()
      : Date.parse(t.dateTime.endsWith('Z') ? t.dateTime : t.dateTime + 'Z'));
    const location = (ev.location && ev.location.displayName) || '';
    return {
      id: `${this.account.id}:${ev.id}`,
      uid: ev.iCalUId || ev.id,
      calendarId: c.id,
      calendarName: c.name || c.id,
      color: c.color || '#7c9cff',
      title: ev.subject || '(untitled)',
      start: at(ev.start), end: at(ev.end), allDay,
      location,
      attendees: (ev.attendees || []).filter((a) => a.type !== 'resource').length,
      meetingUrl: (ev.onlineMeeting && ev.onlineMeeting.joinUrl) || ev.onlineMeetingUrl || firstUrl(location) || firstUrl(ev.bodyPreview) || null,
      htmlLink: ev.webLink,
      responseStatus: RESPONSE[ev.responseStatus && ev.responseStatus.response] ?? null,
    };
  }

  async calendars() {
    const list = await this.graph.list('/me/calendars?$select=id,name,hexColor,isDefaultCalendar&$top=100', { limit: 250 });
    return list.map((c) => ({ id: c.isDefaultCalendar ? 'primary' : c.id, altId: c.id, name: c.name, color: c.hexColor || null, primary: !!c.isDefaultCalendar }));
  }
}

module.exports = { OutlookCalendarSource };
