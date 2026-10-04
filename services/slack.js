'use strict';
// Slack panel: watched channels/DMs with unread counts and latest message,
// live over Socket Mode. User token for everything the panel shows (unread
// state and conversations.mark are per-user); bot token only for health check.
const { Service } = require('./base');
const secrets = require('../main/secrets');

const USER_CACHE_TTL = 24 * 60 * 60 * 1000;

// Arrival time of the oldest unread message we hold (for the panel's unread tint).
// When the unread ones are older than the preview window, the oldest held message
// is the best lower bound we have.
function unreadSince(c) {
  if (!c.unread || !c.messages.length) return null;
  const first = c.messages.find((m) => !c.lastRead || Number(m.ts) > Number(c.lastRead));
  return (first || c.messages[0]).time || null;
}

// What the unread tint should count for a channel, like email's handled mail. Held
// messages carry team: true (this workspace's members, the user included), false
// (customers: Slack Connect users or guests) or null (bots). In a channel with a
// customer in view, only customer messages after the team's last word alert, and
// once a teammate has answered the channel is handled ({ name }). Channels with no
// customer message held alert on every unread message, as before, except unread bot
// messages when ignoreBots (slack.ignoreBots, default on). Unread messages older than
// the held window are unknown and still alert.
function alertOf(c, { ignoreBots = false } = {}) {
  const unread = (m) => !c.lastRead || Number(m.ts) > Number(c.lastRead);
  const msgs = c.messages;
  if (!c.unread) return { alerts: 0, alertSince: null, handled: null };
  if (!msgs.some((m) => m.team === false)) {
    if (!ignoreBots) return { alerts: c.unread, alertSince: unreadSince(c), handled: null };
    const held = msgs.filter(unread);
    const people = held.filter((m) => m.team !== null);
    const older = Math.max(0, c.unread - held.length);
    const alerts = older + people.length;
    const alertSince = !alerts ? null : older && msgs.length ? msgs[0].time : people[0].time;
    return { alerts, alertSince, handled: null };
  }
  let lastTeam = -1;
  msgs.forEach((m, i) => { if (m.team) lastTeam = i; });
  const open = msgs.filter((m, i) => i > lastTeam && m.team === false && unread(m));
  const answered = lastTeam > 0 && msgs.slice(0, lastTeam).some((m) => m.team === false);
  return {
    alerts: open.length,
    alertSince: open.length ? open[0].time : null,
    handled: !open.length && answered ? { name: msgs[lastTeam].author } : null,
  };
}

class SlackService extends Service {
  constructor(opts) {
    const cfg = (opts.config && opts.config.slack) || {};
    super('slack', { ...opts, pollMs: 5 * 60 * 1000 }); // heartbeat cadence for staleness
    this.cfg = cfg;
    this.openExternal = opts.openExternal || (async (url) => this.log.info('open', url));
    this.web = null;
    this.socket = null;
    this.me = null;      // { userId, teamId }
    this.channels = new Map(); // id -> { id, name, type, unread, mentioned, messages: [] }
    this.userNames = new Map();
    this.teamUsers = new Map(); // id -> true (member of this workspace) | false (guest or external)
    this.state = { channels: [], teamId: null, expanded: null };
  }

  async onStart() {
    const appToken = secrets.get('SLACK_APP_TOKEN');
    const userToken = secrets.get('SLACK_USER_TOKEN');
    if (!appToken || !userToken) { this.disable('Slack not connected - open setup (Doombar.exe --setup)'); return; }

    const { WebClient, LogLevel } = require('@slack/web-api');
    const { SocketModeClient } = require('@slack/socket-mode');
    this.web = new WebClient(userToken, { logLevel: LogLevel.ERROR });

    const auth = await this.web.auth.test();
    this.me = { userId: auth.user_id, teamId: auth.team_id };

    const botToken = secrets.get('SLACK_BOT_TOKEN');
    if (botToken) {
      try { await new WebClient(botToken, { logLevel: LogLevel.ERROR }).auth.test(); }
      catch (e) { this.log.warn('bot token health check failed:', e.data?.error || e.message); }
    }

    await this.resolveChannels();
    for (const ch of this.channels.values()) await this.seedChannel(ch);
    this.publish();

    this.socket = new SocketModeClient({ appToken, logLevel: LogLevel.ERROR });
    this.socket.on('message', async ({ event, ack }) => {
      await ack();
      try { await this.onMessage(event); } catch (e) { this.log.warn('event handling failed:', e.message); }
    });
    this.socket.on('connected', () => { this.setStatus('connected'); this.log.info('socket connected'); });
    this.socket.on('disconnected', () => this.setStatus('stale'));
    this.socket.on('error', (e) => this.log.warn('socket error:', e.message));
    await this.socket.start();

    // Periodic reconcile: unread counts can drift if events are missed.
    this.poll(() => this.reconcile(), this.pollMs, { immediate: false });
  }

  // Setup changed the watched list: re-resolve without a restart.
  async onConfig() {
    const key = JSON.stringify(this.cfg.channels || []);
    if (!this.web) return;
    if (key === this.channelsKey) { this.publish(); return; } // e.g. activeDays changed
    this.log.info('channel list changed, re-resolving');
    await this.resolveChannels();
    for (const ch of this.channels.values()) await this.seedChannel(ch);
    this.publish();
  }

  async onStop() {
    if (this.socket) await this.socket.disconnect().catch(() => {});
    this.socket = null;
  }

  async resolveChannels() {
    this.channelsKey = JSON.stringify(this.cfg.channels || []);
    const wanted = (this.cfg.channels || []).map((c) => String(c).trim().replace(/^#/, '')).filter(Boolean);
    const byName = new Map();
    const byId = new Map();
    let cursor;
    do {
      const res = await this.web.conversations.list({ types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 500, cursor });
      for (const c of res.channels || []) {
        byId.set(c.id, c);
        if (c.name) byName.set(c.name.toLowerCase(), c);
        if (c.is_im && c.user) byName.set('@' + (await this.userName(c.user)).toLowerCase(), c);
      }
      cursor = res.response_metadata && res.response_metadata.next_cursor;
    } while (cursor);

    this.channels.clear();
    for (const w of wanted) {
      const c = byId.get(w) || byName.get(w.toLowerCase()) || byName.get('@' + w.toLowerCase());
      if (!c) { this.log.warn(`channel not found: ${w}`); continue; }
      const type = c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private ? 'private' : 'public';
      const name = c.is_im ? await this.userName(c.user) : (c.name || w);
      this.channels.set(c.id, { id: c.id, name, type, unread: 0, mentioned: false, messages: [], lastRead: null });
    }
  }

  async seedChannel(ch) {
    const info = await this.web.conversations.info({ channel: ch.id });
    ch.unread = info.channel.unread_count_display || 0;
    ch.lastRead = info.channel.last_read || null;
    const hist = await this.web.conversations.history({ channel: ch.id, limit: this.cfg.previewMessages || 5 });
    ch.messages = [];
    for (const m of (hist.messages || []).reverse()) ch.messages.push(await this.normalize(m));
    ch.mentioned = ch.messages.some((m) => m.mentionsMe && ch.lastRead && Number(m.ts) > Number(ch.lastRead));
  }

  async reconcile() {
    for (const ch of this.channels.values()) {
      const info = await this.web.conversations.info({ channel: ch.id });
      ch.unread = info.channel.unread_count_display || 0;
      ch.lastRead = info.channel.last_read || null;
    }
    this.publish();
  }

  async onMessage(ev) {
    const ch = this.channels.get(ev.channel);
    if (!ch) return;
    const sub = ev.subtype;
    if (sub === 'message_changed' && ev.message) {
      const idx = ch.messages.findIndex((m) => m.ts === ev.message.ts);
      if (idx !== -1) ch.messages[idx] = await this.normalize(ev.message);
    } else if (sub === 'message_deleted') {
      ch.messages = ch.messages.filter((m) => m.ts !== ev.deleted_ts);
    } else if (!sub || sub === 'thread_broadcast' || sub === 'file_share' || sub === 'bot_message') {
      const msg = await this.normalize(ev);
      ch.messages.push(msg);
      ch.messages = ch.messages.slice(-(this.cfg.previewMessages || 5));
      if (ev.user !== this.me.userId) {
        ch.unread += 1;
        if (msg.mentionsMe) ch.mentioned = true;
      } else {
        // The user posted: Slack treats that as read.
        ch.unread = 0; ch.mentioned = false; ch.lastRead = ev.ts;
      }
    } else {
      return;
    }
    this.publish();
  }

  async normalize(m) {
    const author = m.user ? await this.userName(m.user) : (m.username || m.bot_profile?.name || 'bot');
    const text = await this.mrkdwnToText(m.text || (m.files ? `[${m.files.length} file(s)]` : ''));
    return {
      ts: m.ts,
      author,
      team: await this.isTeam(m),
      text,
      time: Math.round(Number(m.ts) * 1000),
      // Bots @-ing the channel do not count as mentions when slack.ignoreBots (default on).
      mentionsMe: !!(this.me && m.text && !(this.cfg.ignoreBots !== false && (m.bot_id || !m.user))
        && (m.text.includes(`<@${this.me.userId}>`) || /<!(here|channel|everyone)>/.test(m.text))),
    };
  }

  async userName(id) {
    if (this.userNames.has(id)) return this.userNames.get(id);
    if (this.db) {
      const row = this.db.get('SELECT name, updated_at FROM slack_users WHERE id = ?', id);
      if (row && Date.now() - row.updated_at < USER_CACHE_TTL) { this.userNames.set(id, row.name); return row.name; }
    }
    let name = id;
    try {
      const res = await this.web.users.info({ user: id });
      const u = res.user || {};
      name = u.profile?.display_name || u.real_name || u.name || id;
    } catch (e) {
      this.log.warn(`users.info failed for ${id}: ${e.data?.error || e.message}`);
    }
    this.userNames.set(id, name);
    if (this.db) this.db.run('INSERT OR REPLACE INTO slack_users (id, name, updated_at) VALUES (?, ?, ?)', id, name, Date.now());
    return name;
  }

  // Customer or colleague? Slack Connect messages name the author's workspace
  // (user_team); guests of this workspace need users.info. Bots are null.
  async isTeam(m) {
    if (!this.me || !m.user || m.bot_id) return null;
    if (m.user === this.me.userId) return true;
    if (m.user_team && m.user_team !== this.me.teamId) return false;
    if (this.teamUsers.has(m.user)) return this.teamUsers.get(m.user);
    let team = true;
    try {
      const u = (await this.web.users.info({ user: m.user })).user || {};
      team = u.team_id === this.me.teamId && !u.is_restricted && !u.is_ultra_restricted && !u.is_stranger;
    } catch (e) {
      this.log.warn(`users.info failed for ${m.user}: ${e.data?.error || e.message}`);
    }
    this.teamUsers.set(m.user, team);
    return team;
  }

  async mrkdwnToText(text) {
    let t = String(text);
    const ids = [...t.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
    for (const id of new Set(ids)) t = t.split(`<@${id}>`).join('@' + await this.userName(id));
    t = t.replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1');
    t = t.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1').replace(/<#([A-Z0-9]+)>/g, '#$1');
    t = t.replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1');
    t = t.replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '$1');
    t = t.replace(/<([^|>]+)\|([^>]+)>/g, '$2').replace(/<((?:https?|mailto):[^>]+)>/g, '$1');
    t = t.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    t = t.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, '$1$2').replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, '$1$2').replace(/~([^~\n]+)~/g, '$1');
    t = t.replace(/```/g, '').replace(/`([^`]+)`/g, '$1');
    return t.replace(/\s+\n/g, '\n').trim();
  }

  publish() {
    // Channels with nothing newer than activeDays (default 14, 0 = keep all) are
    // flagged quiet: the panel leaves them out (unread tint included) except in its
    // "more" view. reconcile() republishes, so they age out.
    const days = Number(this.cfg.activeDays ?? 14);
    const cutoff = days > 0 ? Date.now() - days * 86400000 : -Infinity;
    const channels = [...this.channels.values()].filter((c) => c.messages.length).map((c) => ({
      id: c.id, name: c.name, type: c.type, unread: c.unread, mentioned: c.mentioned,
      latest: c.messages[c.messages.length - 1] || null,
      messages: c.messages,
      unreadSince: unreadSince(c),
      ...alertOf(c, { ignoreBots: this.cfg.ignoreBots !== false }), // alerts, alertSince, handled
      quiet: c.messages[c.messages.length - 1].time < cutoff,
    }));
    // Unread first, mentions on top, then by latest activity.
    channels.sort((a, b) => (b.mentioned - a.mentioned) || ((b.unread > 0) - (a.unread > 0)) || ((b.latest?.time || 0) - (a.latest?.time || 0)));
    this.setState({ channels, teamId: this.me ? this.me.teamId : null, activeDays: days, watched: this.channels.size });
  }

  actions = {
    markRead: async ({ channel }) => {
      const ch = this.channels.get(channel);
      if (!ch) throw new Error('unknown channel');
      const latest = ch.messages[ch.messages.length - 1];
      if (latest) await this.web.conversations.mark({ channel, ts: latest.ts });
      ch.unread = 0; ch.mentioned = false; ch.lastRead = latest ? latest.ts : ch.lastRead;
      this.publish();
    },
    open: async ({ channel }) => {
      await this.openExternal(`slack://channel?team=${this.me.teamId}&id=${channel}`);
    },
    expand: async ({ channel }) => {
      // Messages are already in state; the renderer toggles the expanded view.
      // Refresh the last 5 so an expanded view is current.
      const ch = this.channels.get(channel);
      if (ch) { await this.seedChannel(ch); this.publish(); }
    },
    refresh: async () => { await this.reconcile(); },
  };
}

module.exports = { SlackService, alertOf };

if (require.main === module) {
  require('./standalone').runStandalone(SlackService, { waitMs: 20000 });
}
