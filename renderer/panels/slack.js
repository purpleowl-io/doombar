import { Panel, h, relTime } from './base.js';

// Views (header tap): normal = channels active within slack.activeDays, latest
// line each; focus = unread or mentioned only; more = every watched channel with
// its recent messages inline.
export class SlackPanel extends Panel {
  constructor(name, config) { super(name, config, 'Slack'); this.enableViews({ focus: 'Unread', more: 'More' }); }

  render(d) {
    const active = d.channels.filter((c) => !c.quiet);
    // Channels where a teammate already answered the customer (c.handled) stay
    // unread but leave the tint, sweep and attention alone, like handled email.
    const anyMention = active.some((c) => c.mentioned && !c.handled);
    this.el.classList.toggle('attention', anyMention);
    const alerts = (c) => c.alerts ?? c.unread ?? 0;
    const since = active.filter((c) => alerts(c)).map((c) => c.alertSince ?? c.unreadSince).filter(Boolean);
    this.setUnreadSince(since.length ? Math.min(...since) : null, active.reduce((n, c) => n + alerts(c), 0));

    const view = this.view;
    const shown = view === 'more' ? d.channels : view === 'focus' ? active.filter((c) => c.unread || c.mentioned) : active;
    if (!shown.length) {
      const text = !d.watched ? 'No watched channels. Pick some in setup (Doombar.exe --setup)'
        : view === 'focus' ? 'All caught up'
          : `Nothing in the last ${d.activeDays} days`;
      this.body.replaceChildren(h('div', { class: 'empty', text }));
      return;
    }

    const rows = shown.map((c) => {
      const prefix = c.type === 'im' ? '@' : c.type === 'mpim' ? '' : '#';
      const latest = c.latest;
      const line = (m) => h('div', { class: 'row-sub' }, h('b', { text: `${m.author}: ` }), m.text || '');
      const body = !latest ? [h('div', { class: 'row-sub', text: 'no messages yet' })]
        : view === 'more' ? [h('div', { class: 'msgs' }, ...c.messages.slice(-5).map((m) => h('div', { class: 'msg' },
          h('span', { class: 'time', text: relTime(m.time, this.tz) }), h('b', { text: ` ${m.author}: ` }), m.text || '')))]
          : [line(latest)];
      return this.row({
        key: c.id,
        classes: `${c.unread ? 'unread' : ''} ${c.mentioned ? 'mention' : ''} ${c.quiet ? 'quiet' : ''}`,
        swipeLabel: 'Read',
        onSwipe: () => this.action('markRead', { channel: c.id }),
        content: [
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' },
              h('span', { class: 'name', text: `${prefix}${c.name}` }),
              c.handled && c.unread ? h('span', { class: 'pill', text: `↩ ${c.handled.name}` }) : null,
              latest && view !== 'more' ? h('span', { class: 'time', text: relTime(latest.time, this.tz) }) : null),
            ...body),
          c.unread ? h('span', { class: 'badge', text: c.unread > 99 ? '99+' : String(c.unread) }) : null,
        ],
        actions: [
          view === 'more' ? null : h('div', { class: 'expanded' }, ...c.messages.slice(-5).map((m) => h('div', {}, h('b', { text: `${m.author} ` }), h('span', { class: 'pill', text: relTime(m.time, this.tz) }), ' ', m.text))),
          c.unread ? h('button', { class: 'btn', text: 'Mark read', onClick: () => this.action('markRead', { channel: c.id }) }) : null,
          h('button', { class: 'btn primary', text: 'Open in Slack', onClick: () => this.action('open', { channel: c.id }) }),
          h('button', { class: 'btn ghost', text: 'Refresh', onClick: () => this.action('expand', { channel: c.id }) }),
        ],
      });
    });
    this.body.replaceChildren(h('div', { class: 'rows' }, ...rows));
  }
}
