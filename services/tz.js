'use strict';
// Timezone helpers that use Intl with an explicit zone. America/Phoenix has no
// DST; nothing here assumes the machine's local zone matches the display's.

function parts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour % 24, minute: +out.minute, second: +out.second,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(out.weekday),
  };
}

// Offset of tz from UTC in minutes at the given instant.
function offsetMinutes(date, tz) {
  const p = parts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

// Midnight (start of day) in tz for the day containing `date`, plus N days.
function startOfDay(date, tz, plusDays = 0) {
  const p = parts(date, tz);
  const guess = Date.UTC(p.year, p.month - 1, p.day + plusDays, 0, 0, 0);
  // Adjust by the offset at the guessed instant (handles DST zones too).
  const off = offsetMinutes(new Date(guess), tz);
  return new Date(guess - off * 60000);
}

function ymd(date, tz) {
  const p = parts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// "HH:MM" -> minutes since midnight
function hm(str) {
  const [h, m] = String(str).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function isBusinessHours(date, tz, bh) {
  if (!bh) return true;
  const p = parts(date, tz);
  if (Array.isArray(bh.days) && !bh.days.includes(p.weekday)) return false;
  const now = p.hour * 60 + p.minute;
  return now >= hm(bh.start || '00:00') && now < hm(bh.end || '24:00');
}

module.exports = { parts, offsetMinutes, startOfDay, ymd, isBusinessHours };
