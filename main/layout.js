'use strict';
// Reorder/resize from the renderer may only permute the existing panels and
// change widths; it cannot add panels or set silly sizes.
function sanitizeLayout(next, current) {
  if (!Array.isArray(next) || !Array.isArray(current) || next.length !== current.length) return null;
  const known = new Map(current.map((l) => [l.panel, l]));
  const seen = new Set();
  const out = [];
  for (const item of next) {
    if (!item || !known.has(item.panel) || seen.has(item.panel)) return null;
    seen.add(item.panel);
    const width = Math.round(Number(item.width));
    if (!Number.isFinite(width) || width < 120 || width > 5000) return null;
    out.push({ ...known.get(item.panel), width });
  }
  return out;
}


module.exports = { sanitizeLayout };
