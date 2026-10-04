'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { THEMES, resolveTheme, themePatch, themeInfo } = require('../main/themes');

test('every theme has a palette block in styles.css', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  for (const t of THEMES) {
    const m = css.match(new RegExp(`\\[data-theme="${t.id}"\\][^{]*\\{([^}]*)\\}`));
    assert.ok(m, `no block for ${t.id}`);
    assert.match(m[1], new RegExp(`color-scheme:\\s*${t.mode}`), `${t.id} color-scheme`);
    assert.match(m[1], new RegExp(`--bg:\\s*${t.bg}`, 'i'), `${t.id} bg matches main`);
  }
});

test('resolveTheme: auto follows the OS between the dark and light picks', () => {
  assert.deepEqual(resolveTheme({}, true), { id: 'midnight', source: 'system' });
  assert.deepEqual(resolveTheme({}, false), { id: 'daylight', source: 'system' });
  const d = { theme: 'system', darkTheme: 'nord', lightTheme: 'paper' };
  assert.equal(resolveTheme(d, true).id, 'nord');
  assert.equal(resolveTheme(d, false).id, 'paper');
});

test('resolveTheme: pinned themes, legacy dark/light, and junk', () => {
  assert.deepEqual(resolveTheme({ theme: 'oled' }, false), { id: 'oled', source: 'dark' });
  assert.deepEqual(resolveTheme({ theme: 'paper' }, true), { id: 'paper', source: 'light' });
  assert.deepEqual(resolveTheme({ theme: 'dark', darkTheme: 'rose' }, false), { id: 'rose', source: 'dark' });
  assert.deepEqual(resolveTheme({ theme: 'light' }, true), { id: 'daylight', source: 'light' });
  // A light theme in the dark slot falls back rather than showing the wrong mode.
  assert.equal(resolveTheme({ darkTheme: 'paper' }, true).id, 'midnight');
  assert.equal(resolveTheme({ theme: 'nope' }, true).source, 'system');
});

test('themePatch: swatch fills a slot in auto, pins otherwise', () => {
  assert.deepEqual(themePatch({ theme: 'nord' }, { theme: 'system' }, true), { darkTheme: 'nord' });
  assert.deepEqual(themePatch({ theme: 'paper' }, {}, true), { lightTheme: 'paper' });
  assert.deepEqual(themePatch({ theme: 'paper' }, { theme: 'oled' }, true), { theme: 'paper' });
  assert.deepEqual(themePatch({ auto: true }, { theme: 'oled' }, true), { theme: 'system' });
  assert.deepEqual(themePatch({ auto: false }, { darkTheme: 'rose' }, true), { theme: 'rose' });
  assert.equal(themePatch({ theme: 'nope' }, {}, true), null);
  assert.equal(themePatch(null, {}, true), null);
});

test('themeInfo reports the picker state', () => {
  const i = themeInfo({ theme: 'system', lightTheme: 'paper' }, false);
  assert.equal(i.active, 'paper');
  assert.equal(i.auto, true);
  assert.equal(i.dark, 'midnight');
  assert.equal(i.themes.length, THEMES.length);
  assert.equal(themeInfo({ theme: 'nord' }, false).auto, false);
});
