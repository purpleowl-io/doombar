import { Panel, h, relTime } from './base.js';

// Views (header tap): normal = email.maxMessages rows from the last
// email.newerThanDays; focus = every row with unread mail; more = everything the
// service published (email.moreDays back, up to email.moreMessages rows).
export class EmailPanel extends Panel {
  constructor(name, config) { super(name, config, 'Email'); this.pending = new Set(); this.enableViews({ focus: 'Unread', more: 'More' }); }

  render(d) {
    // Rows may be groups (config email.groupBy): unreadIds covers the whole group.
    const unreadOf = (m) => m.unreadIds || (m.unread ? [m.id] : []);
    const cutoff = Date.now() - (d.newerThanDays || 7) * 86400000;
    const recent = d.messages.filter((m) => m.date >= cutoff).slice(0, d.maxMessages || 8);
    // The tint keeps to the normal window, whatever the view, and skips unread mail
    // the team already answered or relabelled (alertIds/alertSince from the service).
    const alertOf = (m) => m.alertIds || (m.unread && !m.handled ? [m.id] : []);
    const since = recent.map((m) => ('alertSince' in m ? m.alertSince : m.unread && !m.handled ? m.date : null)).filter(Boolean);
    this.setUnreadSince(since.length ? Math.min(...since) : null, recent.reduce((n, m) => n + alertOf(m).length, 0));
    const view = this.view;
    const shown = view === 'more' ? d.messages : view === 'focus' ? d.messages.filter((m) => unreadOf(m).length) : recent;
    if (!shown.length) {
      this.body.replaceChildren(h('div', { class: 'empty', text: view === 'focus' ? 'All caught up' : view === 'more' ? 'No client mail this month' : 'No client mail this week' }));
      return;
    }
    const rows = shown.map((m) => {
      const summaryEl = m.summary
        ? h('div', { class: 'summary', text: m.summary })
        : d.summaryErrors?.[m.id]
          ? h('div', { class: 'summary error', text: d.summaryErrors[m.id] })
          : this.pending.has(m.id) ? h('div', { class: 'summary pending', text: 'Summarising…' }) : null;
      const unreadIds = unreadOf(m);
      const markRead = () => this.action('markRead', { id: m.id, ids: unreadIds });
      return this.row({
        key: m.id,
        classes: `${unreadIds.length ? 'unread' : ''} ${m.isProspect ? 'mention' : ''}`,
        swipeLabel: unreadIds.length ? 'Read' : 'Archive',
        onSwipe: () => (unreadIds.length ? markRead() : this.action('archive', { id: m.id })),
        content: [
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' },
              h('span', { class: 'name', text: m.fromName }),
              m.attachments ? h('span', { class: 'pill', text: `📎 ${m.attachments}` }) : null,
              m.handled ? h('span', { class: 'pill', text: m.handled.by === 'reply' ? `↩ ${m.handled.name}` : '🏷 labelled' }) : null,
              h('span', { class: 'time', text: relTime(m.date, this.tz) })),
            h('div', { class: 'row-sub', style: { color: m.unread ? 'var(--fg)' : '' }, text: m.subject }),
            h('div', { class: 'row-sub', text: m.snippet })),
          unreadIds.length ? h('span', { class: 'badge', text: unreadIds.length > 99 ? '99+' : String(unreadIds.length) }) : null,
        ],
        actions: [
          summaryEl,
          unreadIds.length ? h('button', { class: 'btn', text: unreadIds.length > 1 ? `Mark ${unreadIds.length} read` : 'Mark read', onClick: markRead }) : null,
          h('button', { class: 'btn', text: 'Archive', onClick: () => this.action('archive', { id: m.id }) }),
          h('button', { class: 'btn', text: 'Open', onClick: () => this.action('open', { id: m.id }) }),
          !m.summary && d.summariesAvailable
            ? h('button', { class: 'btn primary', text: 'Summarise', disabled: this.pending.has(m.id), onClick: () => {
                this.pending.add(m.id); this.render(d);
                this.action('summarize', { id: m.id }).finally(() => { this.pending.delete(m.id); });
              } })
            : null,
          !d.summariesAvailable && !m.summary ? h('span', { class: 'pill', text: 'summaries off: no Claude key' }) : null,
        ],
      });
    });
    this.body.replaceChildren(h('div', { class: 'rows' }, ...rows));
  }
}
