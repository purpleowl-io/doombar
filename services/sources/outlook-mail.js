'use strict';
// Microsoft 365 mail source for one account (Graph). Graph cannot search by a
// fragment of the sender's domain, so each poll lists recent inbox headers (cheap:
// no bodies) and filters them with the same matcher Gmail results go through; only
// matching new messages are fetched in full. "Changed" is a fingerprint of that
// listing plus the newest sent item, so a reply sent from Outlook also counts.
const crypto = require('node:crypto');
const { isCalendarReply, senderDomain } = require('../mail-util');

const LIST_FIELDS = 'id,conversationId,internetMessageId,from,subject,receivedDateTime,bodyPreview,isRead,hasAttachments,categories,webLink,lastModifiedDateTime';
const TEXT_BODY = { Prefer: 'outlook.body-content-type="text"' };

const fromString = (f) => {
  const a = (f && f.emailAddress) || {};
  return a.name && a.address ? `"${a.name}" <${a.address}>` : a.address || a.name || '';
};

class OutlookMailSource {
  constructor({ account, auth, log }) {
    this.account = account;
    this.graph = auth;
    this.log = log;
    this.email = account.email || '';
    this.sentId = null;
    this.print = null;
    this.headers = null; // last listing, reused by list() right after changed()
  }

  async start() {
    const [me, sent] = await Promise.all([
      this.email ? null : this.graph.get('/me?$select=mail,userPrincipalName'),
      this.graph.get('/me/mailFolders/sentitems?$select=id'),
    ]);
    if (me) this.email = String(me.mail || me.userPrincipalName || '').toLowerCase();
    this.sentId = sent.id;
  }

  async listHeaders(days, scan) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    return this.graph.list(`/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${since}&$orderby=receivedDateTime desc&$top=100&$select=${LIST_FIELDS}`, { limit: scan });
  }

  async changed({ days, scan }) {
    const [headers, sent] = await Promise.all([
      this.listHeaders(days, scan),
      this.graph.get('/me/mailFolders/sentitems/messages?$top=1&$orderby=sentDateTime desc&$select=id'),
    ]);
    this.headers = headers;
    const print = crypto.createHash('sha1')
      .update(JSON.stringify([headers.map((h) => [h.id, h.isRead, h.lastModifiedDateTime]), (sent.value[0] || {}).id]))
      .digest('hex');
    const changed = print !== this.print;
    this.print = print;
    return changed;
  }

  async list({ days, scan, cached, match }) {
    const headers = this.headers || await this.listHeaders(days, scan);
    this.headers = null;
    const out = [];
    for (const h of headers) {
      const from = fromString(h.from);
      if (!match(from)) continue;
      const prev = cached(h.id);
      if (prev) {
        out.push({ ...prev, unread: !h.isRead, tags: [...(h.categories || [])].sort(), snippet: h.bodyPreview || prev.snippet });
        continue;
      }
      const [full, atts] = await Promise.all([
        this.graph.get(`/me/messages/${h.id}?$select=body`, { headers: TEXT_BODY }),
        h.hasAttachments ? this.graph.get(`/me/messages/${h.id}/attachments?$select=name,isInline`) : { value: [] },
      ]);
      const body = String((full.body && full.body.content) || '').replace(/\r\n/g, '\n').trim();
      const subject = h.subject || '(no subject)';
      out.push({
        id: `${this.account.id}:${h.id}`,
        rawId: h.id,
        threadId: h.conversationId,
        messageId: h.internetMessageId || null,
        from,
        fromName: (h.from && h.from.emailAddress && h.from.emailAddress.name) || senderDomain(from).addr,
        subject,
        // Meeting responses arrive as eventMessage items titled "Accepted: …".
        calendarReply: isCalendarReply(subject, false),
        date: Date.parse(h.receivedDateTime) || Date.now(),
        snippet: (h.bodyPreview || '').trim(),
        unread: !h.isRead,
        tags: [...(h.categories || [])].sort(),
        attachments: atts.value.filter((a) => !a.isInline).length,
        bodyLength: body.length,
        webUrl: h.webLink,
        _body: body,
      });
    }
    return out;
  }

  async thread(m) {
    const filter = encodeURIComponent(`conversationId eq '${m.threadId.replace(/'/g, "''")}'`);
    const items = await this.graph.list(`/me/messages?$filter=${filter}&$select=id,from,receivedDateTime,sentDateTime,parentFolderId,isDraft&$top=50`, { limit: 100 });
    return items.filter((x) => !x.isDraft).map((x) => {
      const from = fromString(x.from);
      return {
        rawId: x.id,
        from,
        date: Date.parse(x.sentDateTime || x.receivedDateTime) || 0,
        sent: x.parentFolderId === this.sentId || (!!this.email && senderDomain(from).addr === this.email),
      };
    });
  }

  async markRead(rawIds) {
    const res = await this.graph.batch(rawIds.map((id) => ({ method: 'PATCH', url: `/me/messages/${id}`, body: { isRead: true } })));
    const bad = res.find((r) => !r || r.status >= 300);
    if (bad) throw new Error(`mark read failed (${bad ? bad.status : 'no response'})`);
  }

  // "archive" is the well-known Archive folder every Exchange Online mailbox has.
  async archive(rawId) {
    await this.graph.request('POST', `/me/messages/${rawId}/move`, { body: { destinationId: 'archive' } });
  }

  url(m) { return m.webUrl || 'https://outlook.office.com/mail/'; }
}

module.exports = { OutlookMailSource, fromString };
