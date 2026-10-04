'use strict';
// Gmail mail source for one account. Change detection via users.history.list
// against a stored historyId; candidates come from a from:(...) search, so only
// client mail is ever fetched in full.
const { header, extractBody, decodeEntities, isCalendarReply, senderDomain, userLabels, maxHistory } = require('../mail-util');

class GmailSource {
  constructor({ account, auth, db, log }) {
    this.account = account;
    this.db = db;
    this.log = log;
    const { gmail } = require('@googleapis/gmail');
    this.gmail = gmail({ version: 'v1', auth });
    // The legacy single account keeps its old key so an upgrade does not refetch.
    this.kvKey = account.id === 'google' ? 'email.historyId' : `email.historyId.${account.id}`;
    this.email = account.email || '';
  }

  async start() {
    if (this.email) return;
    const p = await this.gmail.users.getProfile({ userId: 'me' });
    this.email = String(p.data.emailAddress || '').toLowerCase();
  }

  // Has anything changed since the last list? (No stored historyId: yes.)
  async changed() {
    const last = this.db ? this.db.kvGet(this.kvKey) : null;
    if (!last) return true;
    try {
      const res = await this.gmail.users.history.list({ userId: 'me', startHistoryId: last, maxResults: 200 });
      if (res.data.historyId && this.db) this.db.kvSet(this.kvKey, res.data.historyId);
      return !!(res.data.history && res.data.history.length);
    } catch (e) {
      if (e.code === 404 || e.status === 404) return true; // historyId expired: full refresh
      throw e;
    }
  }

  // Inbox mail from configured senders in the last `days`. cached(rawId) returns the
  // previous parse, refreshed here with a cheap metadata call; match(from) filters.
  async list({ terms, days, max, cached, match }) {
    const from = terms.length ? `from:(${terms.join(' OR ')}) ` : '';
    const res = await this.gmail.users.messages.list({ userId: 'me', q: `${from}in:inbox newer_than:${days}d`, maxResults: max });
    const out = [];
    let latest = null;
    for (const { id } of res.data.messages || []) {
      let m = cached(id);
      if (!m) {
        const full = await this.gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        m = this.parse(full.data);
        if (!match(m.from)) continue;
      } else {
        const min = await this.gmail.users.messages.get({ userId: 'me', id, format: 'minimal' });
        const labels = min.data.labelIds || [];
        m = { ...m, unread: labels.includes('UNREAD'), labels, tags: userLabels(labels), historyId: min.data.historyId };
      }
      if (!m.labels.includes('INBOX')) continue;
      latest = maxHistory(latest, m.historyId);
      out.push(m);
    }
    if (latest && this.db) this.db.kvSet(this.kvKey, latest);
    return out;
  }

  // Every message of m's thread (the caller drops m itself), for handledBy.
  async thread(m) {
    const t = await this.gmail.users.threads.get({ userId: 'me', id: m.threadId, format: 'metadata', metadataHeaders: ['From'] });
    return (t.data.messages || []).map((x) => {
      const labels = x.labelIds || [];
      return { rawId: x.id, from: header(x, 'From'), date: Number(x.internalDate) || 0, sent: labels.includes('SENT'), labels };
    });
  }

  parse(data) {
    const from = header(data, 'From');
    const { body, attachments, calendarReply } = extractBody(data.payload);
    const subject = header(data, 'Subject') || '(no subject)';
    const labels = data.labelIds || [];
    return {
      id: `${this.account.id}:${data.id}`,
      rawId: data.id,
      threadId: data.threadId,
      messageId: header(data, 'Message-ID') || null,
      historyId: data.historyId,
      from,
      fromName: from.replace(/<.*>/, '').replace(/"/g, '').trim() || senderDomain(from).addr,
      subject,
      calendarReply: isCalendarReply(subject, calendarReply),
      date: Number(data.internalDate) || Date.parse(header(data, 'Date')) || Date.now(),
      snippet: decodeEntities(data.snippet || '').trim(), // Gmail sends snippets HTML-escaped
      unread: labels.includes('UNREAD'),
      labels,
      tags: userLabels(labels),
      attachments: attachments.length,
      bodyLength: body.length,
      _body: body, // never sent to the renderer, never logged
    };
  }

  async markRead(rawIds) {
    if (rawIds.length === 1) await this.gmail.users.messages.modify({ userId: 'me', id: rawIds[0], requestBody: { removeLabelIds: ['UNREAD'] } });
    else await this.gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids: rawIds, removeLabelIds: ['UNREAD'] } });
  }

  async archive(rawId) {
    await this.gmail.users.messages.modify({ userId: 'me', id: rawId, requestBody: { removeLabelIds: ['INBOX'] } });
  }

  // authuser picks the right signed-in Google account in the browser.
  url(m) {
    const user = this.email ? `?authuser=${encodeURIComponent(this.email)}` : '';
    return `https://mail.google.com/mail/u/${user}#inbox/${m.threadId}`;
  }
}

module.exports = { GmailSource };
