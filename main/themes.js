'use strict';
// Named palettes. The colours live in renderer/styles.css ([data-theme] blocks);
// this list is what main needs: which exist, whether each is dark or light (for
// nativeTheme and form controls), and the window background for the first frame.
//
// config.display: theme is "system" (follow Windows app mode) or a theme id.
// In system mode darkTheme / lightTheme pick the pair. The old values "dark" and
// "light" still work and mean "pin the current dark / light pick".
const THEMES = [
  { id: 'midnight', name: 'Midnight', mode: 'dark', bg: '#0b0b10' },
  { id: 'nord', name: 'Nord', mode: 'dark', bg: '#242933' },
  { id: 'rose', name: 'Rosé', mode: 'dark', bg: '#191724' },
  { id: 'oled', name: 'OLED', mode: 'dark', bg: '#000000' },
  { id: 'abyss', name: 'Abyss', mode: 'dark', bg: '#070b14' },
  { id: 'daylight', name: 'Daylight', mode: 'light', bg: '#e9e9ef' },
  { id: 'paper', name: 'Paper', mode: 'light', bg: '#efe9df' },
];
const byId = new Map(THEMES.map((t) => [t.id, t]));
const DEFAULTS = { dark: 'midnight', light: 'daylight' };

function pick(id, mode) {
  const t = byId.get(id);
  return t && t.mode === mode ? t.id : DEFAULTS[mode];
}

// -> { id, source } where source is what nativeTheme.themeSource should be.
function resolveTheme(display, osDark) {
  const d = display || {};
  const dark = pick(d.darkTheme, 'dark');
  const light = pick(d.lightTheme, 'light');
  const t = d.theme || 'system';
  if (t === 'dark') return { id: dark, source: 'dark' };
  if (t === 'light') return { id: light, source: 'light' };
  if (byId.has(t)) return { id: t, source: byId.get(t).mode };
  return { id: osDark ? dark : light, source: 'system' };
}

// A tap in the picker. With auto on, a swatch sets the dark or light slot and
// stays on auto; with auto off it pins that theme. Returns a display patch or null.
function themePatch(req, display, osDark) {
  if (!req || typeof req !== 'object') return null;
  if (req.auto === true) return { theme: 'system' };
  // Auto switched off: pin whatever is showing now.
  if (req.auto === false) return { theme: resolveTheme(display, osDark).id };
  const t = byId.get(req.theme);
  if (!t) return null;
  const auto = ((display && display.theme) || 'system') === 'system';
  if (auto) return t.mode === 'dark' ? { darkTheme: t.id } : { lightTheme: t.id };
  return { theme: t.id };
}

// What the renderer needs to paint and to draw the picker.
function themeInfo(display, osDark) {
  const d = display || {};
  return {
    themes: THEMES.map(({ id, name, mode }) => ({ id, name, mode })),
    active: resolveTheme(d, osDark).id,
    auto: (d.theme || 'system') === 'system',
    dark: pick(d.darkTheme, 'dark'),
    light: pick(d.lightTheme, 'light'),
  };
}

module.exports = { THEMES, resolveTheme, themePatch, themeInfo };
