import { Panel, h, timeShort } from './base.js';

function countdown(ms) {
  const m = Math.round(ms / 60000);
  if (ms <= 0) return 'now';
  if (m < 1) return '<1 min';
  if (m < 60) return `in ${m} min`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return `in ${hh}h${mm ? ` ${mm}m` : ''}`;
}

export class CalendarPanel extends Panel {
  constructor(name, config) { super(name, config, 'Calendar'); this.next = null; this.whenEl = null; this.enableViews({ focus: 'Next', more: 'Week' }); }

  render(d) {
    const tz = d.timezone || this.tz;
    const view = this.view;
    const next = d.events.find((e) => e.id === d.nextId) || null;
    this.next = next;
    const parts = [];

    // Focus view: only today's next meeting, and only once it is within
    // calendar.focusHours (4); nothing else.
    const focusHours = Number(this.config?.calendar?.focusHours) > 0 ? Number(this.config.calendar.focusHours) : 4;
    const shown = view !== 'focus' ? next
      : next && next.day === 'today' && next.start - Date.now() <= focusHours * 3600000 ? next : null;
    // A hidden meeting appears on the tick it enters the window.
    this.focusAt = view === 'focus' && next && next.day === 'today' && !shown ? next.start - focusHours * 3600000 : null;

    if (shown) {
      this.whenEl = h('div', { class: 'when' });
      parts.push(h('div', { class: 'cal-next', style: { borderLeft: `6px solid ${next.color}` } },
        this.whenEl,
        h('div', { class: 'title', text: next.title }),
        h('div', { class: 'meta' },
          h('span', { text: `${timeShort(next.start, tz)} – ${timeShort(next.end, tz)}` }),
          next.attendees ? h('span', { class: 'pill', text: `${next.attendees} people` }) : null,
          next.snoozed ? h('span', { class: 'pill', text: 'snoozed' }) : null),
        h('div', { class: 'actions' },
          next.meetingUrl ? h('button', { class: 'btn primary', text: 'Join', onClick: () => this.action('join', { id: next.id }) }) : null,
          h('button', { class: 'btn', text: 'Open', onClick: () => this.action('open', { id: next.id }) }),
          h('button', { class: 'btn ghost', text: 'Snooze', onClick: () => this.action('snooze', { id: next.id, minutes: 10 }) }))));
    } else {
      this.whenEl = null;
      parts.push(h('div', { class: 'empty cal-none', text: view === 'focus' && next && next.day === 'today'
        ? `Nothing in the next ${focusHours} h` : 'No more meetings today' }));
    }
    if (view === 'focus') { this.body.replaceChildren(...parts); this.onTick(); return; }

    // Views (header tap): normal = today and tomorrow, 5 each; focus = the next
    // meeting only (above); more = the whole week, uncapped.
    const days = [{ key: 'today' }, { key: 'tomorrow' }];
    if (view === 'more') {
      const later = [...new Set(d.events.filter((e) => e.day === 'later').map((e) => e.dayStart))];
      for (const start of later) days.push({ key: start, label: new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: tz }).format(new Date(start)) });
    }
    for (const day of days) {
      const evs = d.events.filter((e) => (typeof day.key === 'number' ? e.day === 'later' && e.dayStart === day.key : e.day === day.key) && e.id !== d.nextId);
      if (!evs.length && day.key === 'today') continue;
      // Without a "next" card only all-day events can remain today, so "Later" would mislead.
      const label = day.label || (day.key === 'tomorrow' ? 'Tomorrow' : next ? 'Later today' : 'Today');
      parts.push(h('div', { class: 'cal-day-label', text: label }));
      if (!evs.length) { parts.push(h('div', { class: 'empty cal-clear', text: 'Clear' })); continue; }
      for (const e of view === 'more' ? evs : evs.slice(0, 5)) {
        parts.push(this.row({
          key: e.id,
          classes: `cal-row ${e.end < Date.now() ? 'past' : ''}`,
          content: [
            h('span', { class: 'cal-bar', style: { background: e.color } }),
            h('span', { class: 't', text: e.allDay ? 'all day' : timeShort(e.start, tz) }),
            h('span', { class: 'n', text: e.title }),
            e.meetingUrl ? h('span', { class: 'pill', text: 'video' }) : null,
          ],
          actions: [
            e.meetingUrl ? h('button', { class: 'btn primary', text: 'Join', onClick: () => this.action('join', { id: e.id }) }) : null,
            h('button', { class: 'btn', text: 'Open', onClick: () => this.action('open', { id: e.id }) }),
          ],
        }));
      }
    }
    this.body.replaceChildren(...parts);
    this.onTick();
  }

  onTick() {
    if (this.focusAt && Date.now() >= this.focusAt && this.state?.data) { this.render(this.state.data); return; }
    if (!this.next || !this.whenEl) { this.el.classList.remove('alert', 'attention'); return; }
    const until = this.next.start - Date.now();
    this.whenEl.textContent = until <= 0 && this.next.end > Date.now() ? 'now' : countdown(until);
    const alertMs = ((this.state?.data?.alertMinutes) || 5) * 60000;
    const soon = until <= alertMs && until > -60000 && !this.next.snoozed;
    this.el.classList.toggle('alert', soon);
    this.el.classList.toggle('attention', !soon && until <= 30 * 60000 && until > 0);
  }
}
