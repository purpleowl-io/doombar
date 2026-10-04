'use strict';

function firstUrl(text) {
  const m = /https?:\/\/[^\s<>"']+/.exec(String(text || ''));
  return m ? m[0] : null;
}

// One event per meeting when it sits in several calendars or accounts (same iCal
// UID and start): the first calendar in config order wins.
function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((e) => {
    const key = `${e.uid || e.id}|${e.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { firstUrl, dedupeEvents };
