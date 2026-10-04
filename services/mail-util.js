'use strict';
// Provider-neutral mail helpers: sender matching, grouping, "handled" detection,
// and the Gmail MIME/HTML parsing the Gmail source uses. No I/O; tested directly.

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
// when its user labels (Gmail) or categories (Outlook) differ from the ones it had
// when first seen, else null. m.tags holds those; without it, Gmail's Label_ ids.
// thread: [{ from, date, sent?, labels? }] (the other messages of m's thread).
function handledBy(m, thread, baseline, teamDomains) {
  const reply = (thread || []).find((t) => t.date > m.date && (t.sent || (t.labels || []).includes('SENT') || isTeam(t.from, teamDomains)));
  if (reply) return { by: 'reply', name: reply.from.replace(/<.*>/, '').replace(/"/g, '').trim() || senderDomain(reply.from).addr };
  if (baseline) {
    const now = m.tags || userLabels(m.labels);
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

function maxHistory(a, b) {
  if (!b) return a;
  if (!a) return String(b);
  return BigInt(b) > BigInt(a) ? String(b) : a;
}

module.exports = {
  senderDomain, matchedEntry, matchesSender, groupMessages, isTeam, handledBy, userLabels,
  header, decodeB64, decodeEntities, htmlToText, extractBody, isCalendarReply, maxHistory,
};
