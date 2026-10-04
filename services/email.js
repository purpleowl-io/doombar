'use strict';
// Email panel: every mail account in config.accounts (Gmail and Microsoft 365),
// filtered to configured client/prospect senders and merged into one list, with
// on-demand Claude summaries (automatic for long messages from prospects).
// Each account is a source (services/sources/) with its own change detection; an
// account that fails is reported in the state while the others keep updating.
// Message ids are "<accountId>:<providerId>". The same message delivered to two
// accounts (same Message-ID) shows once; actions apply to every copy.
const { Service } = require('./base');
const { listAccounts, clientFor } = require('./accounts');
const { Summarizer } = require('./summarizer');
const util = require('./mail-util');

const { matchesSender, groupMessages, handledBy, userLabels } = util;

// Fold copies of one message (same Message-ID) into the first account's copy.
// It counts as unread only while every copy is: reading it anywhere clears it.
// Returns { messages: [...], copies: Map(headId -> [otherIds]) }.
function dedupe(list) {
  const byKey = new Map();
  const copies = new Map();
  const messages = [];
  for (const m of list) {
    const key = m.messageId && String(m.messageId).trim().toLowerCase();
    const head = key && byKey.get(key);
    if (!head) { if (key) byKey.set(key, m); messages.push(m); continue; }
    copies.set(head.id, [...(copies.get(head.id) || []), m.id]);
    head.unread = head.unread && m.unread;
  }
  return { messages, copies };
}

class EmailService extends Service {
  constructor(opts) {
    const cfg = (opts.config && opts.config.email) || {};
    super('email', { ...opts, pollMs: (cfg.pollSeconds || 60) * 1000 });
    this.cfg = cfg;
    this.openExternal = opts.openExternal || (async (url) => this.log.info('open', url));
    this.sources = new Map(); // accountId -> { account, src, started, loaded, byRaw, error }
    this.messages = new Map(); // id -> parsed, deduplicated across accounts
    this.copies = new Map();   // id -> ids of the same message in other accounts
    this.polling = false;
    this.summarizer = new Summarizer({ db: this.db, model: cfg.summaryModel, maxInputChars: cfg.summaryMaxInputChars, context: cfg.summaryContext });
    this.summarizing = new Set();
    this.sendersKey = this.filterKey();
    this.accountsKey = '';
    this.state = { messages: [], accounts: [], summariesAvailable: this.summarizer.available(), summaryErrors: {} };
  }

  async onStart() {
    this.buildSources();
    if (!this.sources.size) { this.disable('No mail account connected - open setup (Doombar.exe --setup)'); return; }
    this.startPolling();
  }

  startPolling() {
    if (this.polling) return;
    this.polling = true;
    this.poll(() => this.tick(), this.pollMs);
  }

  mailAccounts() { return listAccounts(this.config).filter((a) => a.mail); }

  buildSources() {
    const accounts = this.mailAccounts();
    this.accountsKey = JSON.stringify(accounts.map((a) => [a.id, a.provider, a.email, a.label]));
    this.sources.clear();
    for (const account of accounts) {
      const entry = { account, src: null, started: false, loaded: false, byRaw: new Map(), error: null };
      try {
        const auth = clientFor(account);
        const opts = { account, auth, db: this.db, log: this.log };
        if (account.provider === 'google') entry.src = new (require('./sources/gmail').GmailSource)(opts);
        else entry.src = new (require('./sources/outlook-mail').OutlookMailSource)(opts);
      } catch (e) { entry.error = e.message; }
      this.sources.set(account.id, entry);
    }
  }

  filterKey() { return JSON.stringify([this.cfg.senders || [], this.cfg.prospects || [], this.cfg.groupBy || 'client']); }

  // Accounts added or removed in setup: rebuild the sources. Sender lists or
  // grouping changed: cached messages were filtered by the old lists.
  async onConfig() {
    const accounts = this.mailAccounts();
    if (JSON.stringify(accounts.map((a) => [a.id, a.provider, a.email, a.label])) !== this.accountsKey) {
      this.log.info(`mail accounts changed: ${accounts.map((a) => a.email || a.id).join(', ') || 'none'}`);
      this.buildSources();
      this.sendersKey = this.filterKey();
      this.messages.clear(); this.copies.clear();
      if (!this.sources.size) { this.setState({ messages: [], accounts: [] }); this.disable('No mail account connected - open setup (Doombar.exe --setup)'); return; }
      if (!this.polling) { this.setStatus('starting'); this.startPolling(); } else await this.tick(true);
      return;
    }
    const key = this.filterKey();
    if (key === this.sendersKey || !this.polling) return;
    this.sendersKey = key;
    for (const e of this.sources.values()) e.byRaw.clear();
    await this.tick(true);
  }

  // The panel's normal view covers newerThanDays and maxMessages rows; its "more"
  // view reaches back moreDays (30) for up to moreMessages (30) rows, so that is
  // what gets fetched and published. The panel applies the normal limits itself.
  days() { return this.cfg.newerThanDays || 7; }

  entries() { return [...(this.cfg.senders || []), ...(this.cfg.prospects || [])]; }

  listContext() {
    // Grouped rows need the older mail too, to count unread per client.
    const per = (this.cfg.groupBy || 'client') === 'none' ? 2 : 6;
    const entries = this.entries();
    return {
      terms: entries.map((s) => String(s).trim()).filter(Boolean),
      days: Math.max(this.days(), this.cfg.moreDays || 30),
      max: Math.min(100, Math.max(20, (this.cfg.moreMessages || 30) * per)),
      scan: this.cfg.scanMessages || 300, // Outlook: inbox headers checked per poll
      match: (from) => matchesSender(from, entries),
    };
  }

  // force: relist every account even if its change check says nothing happened.
  async tick(force = false) {
    const ctx = this.listContext();
    const changed = [];
    await Promise.all([...this.sources.values()].map(async (e) => {
      if (!e.src) return;
      try {
        if (!e.started) { await e.src.start(); e.started = true; }
        if (!force && e.loaded && !(await e.src.changed(ctx))) { e.error = null; return; }
        const list = await e.src.list({ ...ctx, cached: (raw) => e.byRaw.get(raw) });
        e.byRaw = new Map(list.map((m) => [m.rawId, { ...m, account: e.account.id, accountLabel: e.account.label }]));
        e.loaded = true; e.error = null;
        changed.push(e);
      } catch (err) {
        e.error = (err && err.message) || String(err);
        this.log.warn(`${e.account.email || e.account.id}: ${e.error}`);
      }
    }));
    const all = [...this.sources.values()];
    if (!all.some((e) => e.loaded && !e.error)) throw new Error(all.map((e) => e.error).filter(Boolean).join('; ') || 'no mail account reachable');

    if (!changed.length && !force) { this.publish(); return; }
    await this.markHandled(changed);
    const merged = dedupe(all.flatMap((e) => [...e.byRaw.values()].map((m) => ({ ...m }))));
    this.messages = new Map(merged.messages.map((m) => [m.id, m]));
    this.copies = merged.copies;
    this.publish();
    this.maybeAutoSummarize();
  }

  // Sets m.handled on unread mail of the changed accounts (see handledBy). Label
  // baselines persist in kv so a restart does not forget what a message looked like
  // when it arrived; they are pruned to the messages currently listed.
  async markHandled(changed) {
    const team = this.cfg.teamDomains || [];
    const stored = (this.db && this.db.kvGet('email.labelBaseline', {})) || {};
    const baselines = {};
    for (const e of this.sources.values()) for (const m of e.byRaw.values()) baselines[m.id] = stored[m.id] || m.tags || userLabels(m.labels);
    if (this.db) this.db.kvSet('email.labelBaseline', baselines);

    for (const e of changed) {
      const threads = new Map();
      for (const m of e.byRaw.values()) {
        m.handled = null;
        if (!m.unread || m.calendarReply) continue;
        if (!threads.has(m.threadId)) {
          try { threads.set(m.threadId, await e.src.thread(m)); } catch (err) {
            this.log.warn(`thread ${m.threadId}: ${err.message}`);
            threads.set(m.threadId, []);
          }
        }
        m.handled = handledBy(m, threads.get(m.threadId).filter((t) => t.rawId !== m.rawId), baselines[m.id], team);
      }
    }
  }

  view(m) {
    const { _body, labels, tags, historyId, messageId, rawId, threadId, webUrl, ...rest } = m;
    return { ...rest, isProspect: this.isProspect(m), summary: this.summarizer.cached(m.id) };
  }

  publish() {
    const sorted = [...this.messages.values()].sort((a, b) => b.date - a.date);
    const multi = this.sources.size > 1;
    const messages = groupMessages(sorted, this.cfg.groupBy || 'client', this.entries())
      .slice(0, Math.max(this.cfg.maxMessages || 8, this.cfg.moreMessages || 30))
      .map((g) => ({ ...this.view(g.head), accountLabel: multi ? g.head.accountLabel : null, unreadIds: g.unreadIds, unreadSince: g.unreadSince, alertIds: g.alertIds, alertSince: g.alertSince, groupTotal: g.total }));
    const accounts = [...this.sources.values()].map((e) => ({ id: e.account.id, label: e.account.label, email: e.src?.email || e.account.email, provider: e.account.provider, error: e.error }));
    this.setState({ messages, accounts, summariesAvailable: this.summarizer.available(), maxMessages: this.cfg.maxMessages || 8, newerThanDays: this.days() });
  }

  maybeAutoSummarize() {
    const limit = this.cfg.autoSummarizeProspectsOverChars;
    if (!limit || !this.summarizer.available()) return;
    const since = Date.now() - this.days() * 86400000; // not the older mail fetched for "more"
    for (const m of this.messages.values()) {
      if (this.isProspect(m) && m.unread && !m.calendarReply && m.date >= since && m.bodyLength > limit && !this.summarizer.cached(m.id)) {
        this.summarize(m.id).catch(() => {});
      }
    }
  }

  isProspect(m) { return matchesSender(m.from, this.cfg.prospects || []); }

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

  // ids plus their copies in other accounts, as Map(accountId -> [providerIds]).
  byAccount(ids) {
    const out = new Map();
    for (const id of ids.flatMap((i) => [i, ...(this.copies.get(i) || [])])) {
      const cut = id.indexOf(':');
      if (cut === -1) continue;
      const acct = id.slice(0, cut);
      if (!out.has(acct)) out.set(acct, []);
      out.get(acct).push(id.slice(cut + 1));
    }
    return out;
  }

  source(accountId) {
    const e = this.sources.get(accountId);
    if (!e || !e.src) throw new Error(`mail account ${accountId} is not connected`);
    return e;
  }

  actions = {
    // { id } for one message, { ids } for a grouped row.
    markRead: async ({ id, ids }) => {
      const list = Array.isArray(ids) && ids.length ? ids.map(String) : [String(id)];
      for (const [acct, raw] of this.byAccount(list)) {
        const e = this.source(acct);
        await e.src.markRead(raw);
        for (const r of raw) { const m = e.byRaw.get(r); if (m) m.unread = false; }
      }
      for (const i of list) { const m = this.messages.get(i); if (m) m.unread = false; }
      this.publish();
    },
    archive: async ({ id }) => {
      for (const [acct, raw] of this.byAccount([String(id)])) {
        const e = this.source(acct);
        for (const r of raw) { await e.src.archive(r); e.byRaw.delete(r); }
      }
      this.messages.delete(id);
      this.publish();
    },
    open: async ({ id }) => {
      const m = this.messages.get(id);
      if (!m) return;
      await this.openExternal(this.source(m.account).src.url(m));
    },
    summarize: async ({ id }) => ({ summary: await this.summarize(id) }),
    refresh: async () => { await this.tick(true); },
  };
}

module.exports = { EmailService, dedupe, ...util };

if (require.main === module) {
  require('./standalone').runStandalone(EmailService, { waitMs: 30000 });
}
