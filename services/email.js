'use strict';
// Email panel: Gmail, filtered to configured client/prospect senders, with
// on-demand Claude summaries (automatic for long messages from prospects).
// Incremental polling via users.history.list against a stored historyId.
const { Service } = require('./base');
const { authClient } = require('./google');
const { Summarizer } = require('./summarizer');

function senderDomain(from) {
  const m = /<([^>]+)>/.exec(from || '');
  const addr = (m ? m[1] : from || '').trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  return { addr, domain: at === -1 ? '' : addr.slice(at + 1) };
}

// Entry forms: "acme" (label fragment, matches acme.com / mail.acme.io),
// "globex.com" (domain incl. subdomains), "bob@x.com" (exact address).
// Returns the first entry that matches (the "client"), or null.
function matchedEntry(from, entries) {
  const { addr, domain } = senderDomain(from);
  if (!domain) return null;
  for (const raw of entries || []) {
    const e = String(raw).trim().toLowerCase();
    if (!e) continue;
    if (e.includes('@')) { if (addr === e) return e; continue; }
    if (e.includes('.')) { if (domain === e || domain.endsWith('.' + e)) return e; continue; }
    if (domain.split('.').some((label) => label === e)) return e;
  }
  return null;
}
const matchesSender = (from, entries) => matchedEntry(from, entries) !== null;

// Rows for the panel. groupBy "client" (default) folds all mail matching one
// senders/prospects entry into its newest message; "sender" folds by address;
// "none" lists every message. Each row carries the group's unread ids and the
// arrival of its oldest unread; alertIds/alertSince leave out unread mail the
// team has already handled (m.handled), and drive the unread tint.
function groupMessages(sorted, groupBy, entries) {
  const key = (m) => (groupBy === 'sender' ? senderDomain(m.from).addr : matchedEntry(m.from, entries) || senderDomain(m.from).domain);
  const groups = new Map();
  for (const m of sorted) {
    const k = groupBy === 'none' ? m.id : key(m);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { head: m, unreadIds: [], unreadSince: null, alertIds: [], alertSince: null, total: 0 }));
    g.total++;
    if (!m.unread || m.calendarReply) continue;
    g.unreadIds.push(m.id); g.unreadSince = Math.min(g.unreadSince ?? Infinity, m.date);
    if (!m.handled) { g.alertIds.push(m.id); g.alertSince = Math.min(g.alertSince ?? Infinity, m.date); }
  }
  return [...groups.values()];
}

// Team mail: "example.com" matches that domain and its subdomains.
function isTeam(from, domains) {
  const { domain } = senderDomain(from);
  return !!domain && (domains || []).some((d) => { d = String(d).trim().toLowerCase(); return d && (domain === d || domain.endsWith('.' + d)); });
}

// Has someone dealt with message m? { by: 'reply', name } when a later message in
// its thread came from a team domain (or was sent from this mailbox), { by: 'label' }
// when its user labels differ from the ones it had when first seen, else null.
// thread: [{ from, date, labels }] (the other messages of m's thread).
function handledBy(m, thread, baseline, teamDomains) {
  const reply = (thread || []).find((t) => t.date > m.date && (t.labels.includes('SENT') || isTeam(t.from, teamDomains)));
  if (reply) return { by: 'reply', name: reply.from.replace(/<.*>/, '').replace(/"/g, '').trim() || senderDomain(reply.from).addr };
  if (baseline) {
    const now = userLabels(m.labels);
    if (now.length !== baseline.length || now.some((l) => !baseline.includes(l))) return { by: 'label' };
  }
  return null;
}
const userLabels = (labels) => (labels || []).filter((l) => l.startsWith('Label_')).sort();

function header(msg, name) {
  const h = (msg.payload && msg.payload.headers) || [];
  const found = h.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

function decodeB64(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// One pass, so "&amp;lt;" stays "&lt;" instead of becoming "<".
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Walk MIME parts: prefer text/plain, fall back to text/html. Collect attachments.
// calendarReply: an iCalendar part with METHOD:REPLY (an attendee's accept/decline).
function extractBody(payload) {
  let plain = '';
  let html = '';
  let calendarReply = false;
  const attachments = [];
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || '';
    if (mime === 'text/calendar' || mime === 'application/ics') {
      const ct = header(part, 'Content-Type');
      if (/method="?reply/i.test(ct) || (part.body && part.body.data && /^METHOD:REPLY\s*$/im.test(decodeB64(part.body.data)))) calendarReply = true;
    }
    if (part.filename && part.body && (part.body.attachmentId || part.body.size)) {
      attachments.push({ name: part.filename, size: part.body.size || 0 });
    } else if (mime === 'text/plain' && part.body && part.body.data && !plain) {
      plain = decodeB64(part.body.data);
    } else if (mime === 'text/html' && part.body && part.body.data && !html) {
      html = decodeB64(part.body.data);
    }
    for (const p of part.parts || []) walk(p);
  };
  walk(payload);
  return { body: plain || (html ? htmlToText(html) : ''), attachments, calendarReply };
}

// Calendar RSVP notifications ("Accepted: Standup @ ...") never count as unread.
const RSVP_SUBJECT = /^(accepted|declined|tentatively accepted|tentative|new time proposed)\s*:/i;
const isCalendarReply = (subject, calendarReply) => calendarReply || RSVP_SUBJECT.test(String(subject || '').trim());

class EmailService extends Service {
  constructor(opts) {
    const cfg = (opts.config && opts.config.email) || {};
    super('email', { ...opts, pollMs: (cfg.pollSeconds || 60) * 1000 });
    this.cfg = cfg;
    this.openExternal = opts.openExternal || (async (url) => this.log.info('open', url));
    this.gmail = null;
    this.messages = new Map(); // id -> parsed
    this.summarizer = new Summarizer({ db: this.db, model: cfg.summaryModel, maxInputChars: cfg.summaryMaxInputChars, context: cfg.summaryContext });
    this.summarizing = new Set();
    this.sendersKey = JSON.stringify([cfg.senders || [], cfg.prospects || [], cfg.groupBy || 'client']);
    this.state = { messages: [], summariesAvailable: this.summarizer.available(), summaryErrors: {} };
  }

  async onStart() {
    const auth = authClient();
    if (!auth) { this.disable('Google not connected - open setup (Doombar.exe --setup)'); return; }
    const { gmail } = require('@googleapis/gmail');
    this.gmail = gmail({ version: 'v1', auth });
    this.poll(() => this.tick(), this.pollMs);
  }

  // Sender lists or grouping changed in setup: cached messages were filtered by the old lists.
  async onConfig() {
    const key = JSON.stringify([this.cfg.senders || [], this.cfg.prospects || [], this.cfg.groupBy || 'client']);
    if (!this.gmail || key === this.sendersKey) return;
    this.sendersKey = key;
    this.messages.clear();
    await this.refreshList();
  }

  query() {
    const terms = (this.cfg.senders || []).concat(this.cfg.prospects || []).map((s) => String(s).trim()).filter(Boolean);
    const from = terms.length ? `from:(${terms.join(' OR ')}) ` : '';
    return `${from}in:inbox newer_than:${Math.max(this.days(), this.cfg.moreDays || 30)}d`;
  }

  // The panel's normal view covers newerThanDays and maxMessages rows; its "more"
  // view reaches back moreDays (30) for up to moreMessages (30) rows, so that is
  // what gets fetched and published. The panel applies the normal limits itself.
  days() { return this.cfg.newerThanDays || 7; }

  async tick() {
    const kvKey = 'email.historyId';
    const lastHistory = this.db ? this.db.kvGet(kvKey) : null;
    let changed = !lastHistory || this.messages.size === 0;

    if (lastHistory && !changed) {
      try {
        const res = await this.gmail.users.history.list({ userId: 'me', startHistoryId: lastHistory, maxResults: 200 });
        changed = !!(res.data.history && res.data.history.length);
        if (res.data.historyId && this.db) this.db.kvSet(kvKey, res.data.historyId);
      } catch (e) {
        if (e.code === 404 || e.status === 404) changed = true; // historyId expired: full refresh
        else throw e;
      }
    }

    if (changed) await this.refreshList();
    else this.setState({}); // heartbeat so the panel does not go stale
  }

  async refreshList() {
    // Grouped rows need the older mail too, to count unread per client.
    const per = (this.cfg.groupBy || 'client') === 'none' ? 2 : 6;
    const list = await this.gmail.users.messages.list({ userId: 'me', q: this.query(), maxResults: Math.min(100, Math.max(20, (this.cfg.moreMessages || 30) * per)) });
    const ids = (list.data.messages || []).map((m) => m.id);
    const next = new Map();
    let latestHistory = null;

    for (const id of ids) {
      let parsed = this.messages.get(id);
      if (!parsed) {
        const full = await this.gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        parsed = this.parse(full.data);
        if (!matchesSender(parsed.from, [...(this.cfg.senders || []), ...(this.cfg.prospects || [])])) continue;
      } else {
        const min = await this.gmail.users.messages.get({ userId: 'me', id, format: 'minimal' });
        parsed = { ...parsed, unread: (min.data.labelIds || []).includes('UNREAD'), labels: min.data.labelIds || [] };
        latestHistory = maxHistory(latestHistory, min.data.historyId);
      }
      if (!parsed.labels.includes('INBOX')) continue;
      latestHistory = maxHistory(latestHistory, parsed.historyId);
      next.set(id, parsed);
    }

    await this.markHandled(next);
    this.messages = next;
    if (latestHistory && this.db) this.db.kvSet('email.historyId', latestHistory);
    this.publish();
    this.maybeAutoSummarize();
  }

  // Sets m.handled on unread mail (see handledBy). Label baselines persist in kv so a
  // restart does not forget what a message looked like when it arrived.
  async markHandled(msgs) {
    const team = this.cfg.teamDomains || [];
    const stored = (this.db && this.db.kvGet('email.labelBaseline', {})) || {};
    const baselines = {};
    for (const m of msgs.values()) baselines[m.id] = stored[m.id] || userLabels(m.labels);
    if (this.db) this.db.kvSet('email.labelBaseline', baselines); // pruned to the current list

    const threads = new Map();
    for (const m of msgs.values()) {
      m.handled = null;
      if (!m.unread || m.calendarReply) continue;
      if (!threads.has(m.threadId)) {
        try {
          const t = await this.gmail.users.threads.get({ userId: 'me', id: m.threadId, format: 'metadata', metadataHeaders: ['From'] });
          threads.set(m.threadId, (t.data.messages || []).map((x) => ({ id: x.id, from: header(x, 'From'), date: Number(x.internalDate) || 0, labels: x.labelIds || [] })));
        } catch (e) {
          this.log.warn(`thread ${m.threadId}: ${e.message}`);
          threads.set(m.threadId, []);
        }
      }
      m.handled = handledBy(m, threads.get(m.threadId).filter((x) => x.id !== m.id), baselines[m.id], team);
    }
  }

  parse(data) {
    const from = header(data, 'From');
    const { body, attachments, calendarReply } = extractBody(data.payload);
    const subject = header(data, 'Subject') || '(no subject)';
    return {
      id: data.id,
      threadId: data.threadId,
      historyId: data.historyId,
      from,
      fromName: from.replace(/<.*>/, '').replace(/"/g, '').trim() || senderDomain(from).addr,
      subject,
      calendarReply: isCalendarReply(subject, calendarReply),
      date: Number(data.internalDate) || Date.parse(header(data, 'Date')) || Date.now(),
      snippet: decodeEntities(data.snippet || '').trim(), // Gmail sends snippets HTML-escaped
      unread: (data.labelIds || []).includes('UNREAD'),
      labels: data.labelIds || [],
      attachments: attachments.length,
      bodyLength: body.length,
      isProspect: matchesSender(from, this.cfg.prospects || []),
      _body: body, // never sent to the renderer, never logged
    };
  }

  view(m) {
    const { _body, ...rest } = m;
    return { ...rest, summary: this.summarizer.cached(m.id) };
  }

  publish() {
    const sorted = [...this.messages.values()].sort((a, b) => b.date - a.date);
    const entries = [...(this.cfg.senders || []), ...(this.cfg.prospects || [])];
    const messages = groupMessages(sorted, this.cfg.groupBy || 'client', entries)
      .slice(0, Math.max(this.cfg.maxMessages || 8, this.cfg.moreMessages || 30))
      .map((g) => ({ ...this.view(g.head), unreadIds: g.unreadIds, unreadSince: g.unreadSince, alertIds: g.alertIds, alertSince: g.alertSince, groupTotal: g.total }));
    this.setState({ messages, summariesAvailable: this.summarizer.available(), maxMessages: this.cfg.maxMessages || 8, newerThanDays: this.days() });
  }

  maybeAutoSummarize() {
    const limit = this.cfg.autoSummarizeProspectsOverChars;
    if (!limit || !this.summarizer.available()) return;
    const since = Date.now() - this.days() * 86400000; // not the older mail fetched for "more"
    for (const m of this.messages.values()) {
      if (m.isProspect && m.unread && !m.calendarReply && m.date >= since && m.bodyLength > limit && !this.summarizer.cached(m.id)) {
        this.summarize(m.id).catch(() => {});
      }
    }
  }

  async summarize(id) {
    const m = this.messages.get(id);
    if (!m) throw new Error('message not loaded');
    if (this.summarizing.has(id)) return null;
    this.summarizing.add(id);
    try {
      const text = await this.summarizer.summarize({ id, from: m.from, subject: m.subject, date: new Date(m.date).toISOString(), body: m._body });
      this.setState((s) => ({ ...s, summaryErrors: { ...s.summaryErrors, [id]: undefined } }), { touch: false });
      this.publish();
      return text;
    } catch (e) {
      this.log.warn(`summary failed for ${id}: ${e.message}`);
      this.setState((s) => ({ ...s, summaryErrors: { ...s.summaryErrors, [id]: e.message } }), { touch: false });
      throw e;
    } finally {
      this.summarizing.delete(id);
    }
  }

  async modify(id, addLabelIds, removeLabelIds) {
    await this.gmail.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds, removeLabelIds } });
  }

  actions = {
    // { id } for one message, { ids } for a grouped row.
    markRead: async ({ id, ids }) => {
      const list = Array.isArray(ids) && ids.length ? ids.map(String) : [id];
      if (list.length === 1) await this.modify(list[0], [], ['UNREAD']);
      else await this.gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids: list, removeLabelIds: ['UNREAD'] } });
      for (const i of list) {
        const m = this.messages.get(i);
        if (m) { m.unread = false; m.labels = m.labels.filter((l) => l !== 'UNREAD'); }
      }
      this.publish();
    },
    archive: async ({ id }) => {
      await this.modify(id, [], ['INBOX']);
      this.messages.delete(id);
      this.publish();
    },
    open: async ({ id }) => {
      const m = this.messages.get(id);
      await this.openExternal(`https://mail.google.com/mail/u/0/#inbox/${m ? m.threadId : id}`);
    },
    summarize: async ({ id }) => ({ summary: await this.summarize(id) }),
    refresh: async () => { await this.refreshList(); },
  };
}

function maxHistory(a, b) {
  if (!b) return a;
  if (!a) return String(b);
  return BigInt(b) > BigInt(a) ? String(b) : a;
}

module.exports = { EmailService, matchesSender, matchedEntry, groupMessages, handledBy, extractBody, isCalendarReply, htmlToText, decodeEntities };

if (require.main === module) {
  require('./standalone').runStandalone(EmailService, { waitMs: 20000 });
}
