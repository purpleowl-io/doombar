const $ = (id) => document.getElementById(id);
const S = window.setup;

function msg(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = `msg ${cls}`; }
function busy(btn, on) { btn.disabled = on; }

async function refresh() {
  const st = await S.status();
  $('dataDir').textContent = st.dataDir;
  const banner = $('storageBanner');
  if (st.storageProblem) {
    banner.hidden = false;
    banner.textContent = `Encrypted storage is not available here: ${st.storageProblem}. You can still test tokens. On the Windows workstation this works out of the box; on a dev box, keep secrets in .env.local instead.`;
  } else banner.hidden = true;
  for (const [name, where] of Object.entries(st.names)) {
    const el = $(`st-${name}`);
    if (!el) continue;
    el.textContent = where ? `configured (${where})` : 'not configured';
    el.className = `state ${where ? 'set' : ''}`;
  }
}

async function saveAll(entries, msgId) {
  const errors = [];
  for (const [name, value] of entries) {
    if (!value) continue;
    const r = await S.save(name, value);
    if (r.error) errors.push(r.error);
  }
  if (errors.length) { msg(msgId, errors[0], 'err'); return false; }
  return true;
}

document.querySelectorAll('button[data-open]').forEach((b) => b.addEventListener('click', () => S.open(b.dataset.open)));
$('openDataDir').addEventListener('click', () => S.openDataDir());

$('saveAnthropic').addEventListener('click', async () => {
  const key = $('anthropicKey').value.trim();
  if (!key) return msg('msg-anthropic', 'paste a key first', 'err');
  busy($('saveAnthropic'), true); msg('msg-anthropic', 'testing…', 'busy');
  const r = await S.testAnthropic(key);
  if (r.error) msg('msg-anthropic', r.error, 'err');
  else if (await saveAll([['ANTHROPIC_API_KEY', key]], 'msg-anthropic')) { msg('msg-anthropic', `${r.detail}, stored`, 'ok'); $('anthropicKey').value = ''; }
  busy($('saveAnthropic'), false); refresh();
});

$('saveSlack').addEventListener('click', async () => {
  const appToken = $('slackApp').value.trim(), userToken = $('slackUser').value.trim(), botToken = $('slackBot').value.trim();
  if (!appToken || !userToken) return msg('msg-slack', 'app-level and user tokens are both required', 'err');
  busy($('saveSlack'), true); msg('msg-slack', 'testing…', 'busy');
  const r = await S.testSlack({ appToken, userToken, botToken });
  if (r.error) msg('msg-slack', r.error, 'err');
  else if (await saveAll([['SLACK_APP_TOKEN', appToken], ['SLACK_USER_TOKEN', userToken], ['SLACK_BOT_TOKEN', botToken]], 'msg-slack')) {
    msg('msg-slack', `${r.detail}; stored`, 'ok'); for (const id of ['slackApp', 'slackUser', 'slackBot']) $(id).value = '';
  }
  busy($('saveSlack'), false); refresh();
});

let googleUrl = '';
S.onGoogleUrl((url) => { googleUrl = url; $('googleUrl').textContent = url; $('googleUrlBox').hidden = false; });
$('openGoogleUrl').addEventListener('click', () => googleUrl && S.open(googleUrl));
$('copyGoogleUrl').addEventListener('click', async () => { await S.copy(googleUrl); msg('msg-google', 'link copied', 'ok'); });

$('connectGoogle').addEventListener('click', async () => {
  const clientId = $('googleId').value.trim(), clientSecret = $('googleSecret').value.trim();
  if (!clientId || !clientSecret) return msg('msg-google', 'client ID and secret are both required', 'err');
  busy($('connectGoogle'), true); msg('msg-google', 'waiting for you to approve in the browser (5 min)…', 'busy');
  $('googleUrlBox').hidden = true;
  const r = await S.google({ clientId, clientSecret });
  if (r.error) msg('msg-google', r.error, 'err');
  else { msg('msg-google', r.detail, 'ok'); if (r.refreshToken) { $('googleUrl').textContent = `GOOGLE_REFRESH_TOKEN=${r.refreshToken}`; googleUrl = r.refreshToken; $('googleUrlBox').hidden = false; } else { $('googleUrlBox').hidden = true; $('googleSecret').value = ''; } }
  busy($('connectGoogle'), false); refresh();
});

$('importEnv').addEventListener('click', async () => {
  busy($('importEnv'), true);
  const r = await S.importEnv();
  if (r.errors.length) msg('msg-import', r.errors[0], 'err');
  else msg('msg-import', r.stored.length ? `stored ${r.stored.join(', ')}` : 'no known variables found', r.stored.length ? 'ok' : '');
  busy($('importEnv'), false); refresh();
});

// --- dashboard settings ----------------------------------------------------------

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'value') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.filter((c) => c != null));
  return e;
}

async function saveSettings(patch, msgId, btn) {
  busy(btn, true);
  const r = await S.saveSettings(patch);
  msg(msgId, r.error || 'saved', r.error ? 'err' : 'ok');
  busy(btn, false);
  return !r.error;
}

// Slack: `selected` holds the strings written to config (channel name, @person,
// mpdm-… or an ID). Once the list is loaded, old entries are mapped onto its keys.
const slack = { items: null, selected: [] };

function slackMatch(entry) {
  const e = String(entry).toLowerCase().replace(/^#/, '');
  return slack.items.find((i) => i.key.toLowerCase() === e || i.id.toLowerCase() === e || (i.type !== 'im' && i.label.toLowerCase() === e));
}

function renderSlack() {
  const list = $('slackList');
  const q = $('slackFilter').value.trim().toLowerCase();
  $('slackCount').textContent = `${slack.selected.length} selected`;
  const row = (key, label, meta, missing) => {
    if (q && !`${label} ${key}`.toLowerCase().includes(q)) return null;
    return el('label', { class: `item${missing ? ' missing' : ''}` },
      el('input', { type: 'checkbox', checked: slack.selected.includes(key), onchange: (e) => {
        slack.selected = e.target.checked ? [...slack.selected, key] : slack.selected.filter((k) => k !== key);
        $('slackCount').textContent = `${slack.selected.length} selected`;
      } }),
      el('span', { class: 'lbl', text: label }), el('span', { class: 'meta', text: meta }));
  };
  const groups = [];
  const add = (title, rows) => { rows = rows.filter(Boolean); if (rows.length) groups.push(el('div', { class: 'group', text: title }), ...rows); };
  if (slack.items) {
    const known = new Set(slack.items.map((i) => i.key));
    add('Not found in Slack', slack.selected.filter((k) => !known.has(k)).map((k) => row(k, k, 'uncheck to drop', true)));
    add('Channels', slack.items.filter((i) => i.type === 'public' || i.type === 'private').map((i) => row(i.key, '#' + i.label, i.type === 'private' ? 'private' : '')));
    add('Direct messages', slack.items.filter((i) => i.type === 'im').map((i) => row(i.key, i.label, 'DM')));
    add('Group DMs', slack.items.filter((i) => i.type === 'mpim').map((i) => row(i.key, i.label, 'group')));
  } else {
    add('Currently watched', slack.selected.map((k) => row(k, k, '')));
  }
  list.replaceChildren(...groups);
  list.hidden = !groups.length;
}

$('loadSlack').addEventListener('click', async () => {
  busy($('loadSlack'), true); msg('msg-slackList', 'loading…', 'busy');
  const r = await S.slackChannels();
  busy($('loadSlack'), false);
  if (r.error) return msg('msg-slackList', r.error, 'err');
  slack.items = r.channels;
  slack.selected = [...new Set(slack.selected.map((k) => slackMatch(k)?.key || k))];
  msg('msg-slackList', `${r.channels.length} conversations`, 'ok');
  $('slackFilter').hidden = false; $('slackFilter').focus();
  renderSlack();
});
$('slackFilter').addEventListener('input', renderSlack);
$('saveSlackSettings').addEventListener('click', () => saveSettings(
  { slack: { channels: slack.selected, previewMessages: Number($('slackPreview').value), activeDays: Number($('slackActiveDays').value) } }, 'msg-slackSettings', $('saveSlackSettings')));

// Email: one entry per line (commas work too).
const lines = (id) => $(id).value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
$('saveEmail').addEventListener('click', () => saveSettings(
  { email: { senders: lines('senders'), prospects: lines('prospects'), groupBy: $('emailGroupBy').value } }, 'msg-email', $('saveEmail')));

// Calendars: rows start from config (all checked); loading from Google adds the rest.
let cals = [];
function renderCals() {
  $('calList').replaceChildren(...cals.map((c) => el('div', { class: `item${c.missing ? ' missing' : ''}` },
    el('input', { type: 'checkbox', checked: c.on, onchange: (e) => { c.on = e.target.checked; } }),
    el('input', { type: 'color', value: c.color, oninput: (e) => { c.color = e.target.value; } }),
    el('input', { class: 'name', value: c.name, placeholder: c.id, oninput: (e) => { c.name = e.target.value; } }),
    el('span', { class: 'meta', text: c.missing ? 'not in your calendar list' : c.id, title: c.id }))));
}
$('loadCalendars').addEventListener('click', async () => {
  busy($('loadCalendars'), true); msg('msg-calList', 'loading…', 'busy');
  const r = await S.googleCalendars();
  busy($('loadCalendars'), false);
  if (r.error) return msg('msg-calList', r.error, 'err');
  const matched = new Set();
  for (const g of r.calendars) {
    const c = cals.find((x) => x.id === g.id || x.id === g.altId);
    if (c) { matched.add(c); c.id = g.id; if (!c.name) c.name = g.name; }
    else { const n = { id: g.id, name: g.name, color: normHex(g.color) || '#7c9cff', on: false }; cals.push(n); matched.add(n); }
  }
  for (const c of cals) c.missing = !matched.has(c);
  msg('msg-calList', `${r.calendars.length} calendars`, 'ok');
  renderCals();
});
$('saveCalendars').addEventListener('click', () => saveSettings(
  { calendar: { calendars: cals.filter((c) => c.on).map(({ id, name, color }) => ({ id, name, color })), alertMinutes: Number($('alertMinutes').value) } },
  'msg-cal', $('saveCalendars')));

function normHex(c) {
  const long = /^#?([0-9a-f]{6})$/i.exec(c || '');
  if (long) return '#' + long[1].toLowerCase();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c || '');
  return short ? '#' + short.slice(1).map((x) => x + x).join('').toLowerCase() : null;
}

// Theme & visualizer.
const THEME_STOPS = ['#7c9cff', '#b388ff', '#f5b950', '#ff5f6d']; // Midnight's, as a starting point
let stops = [];
const show = (id, on) => { $(id).style.display = on ? '' : 'none'; };
function renderStops() {
  const custom = !$('energyTheme').checked;
  show('stopsRow', custom); show('previewRow', custom);
  $('energyStops').replaceChildren(
    ...stops.map((c, i) => el('input', { type: 'color', value: c, oninput: (e) => { stops[i] = e.target.value; preview(); } })),
    stops.length < 6 ? el('button', { class: 'small', text: '+', title: 'add a stop', onclick: () => { stops.push(stops[stops.length - 1]); renderStops(); } }) : null,
    stops.length > 2 ? el('button', { class: 'small', text: '−', title: 'remove the last stop', onclick: () => { stops.pop(); renderStops(); } }) : null);
  preview();
}
function preview() { $('energyPreview').style.background = `linear-gradient(90deg, ${stops.join(', ')})`; }
$('energyTheme').addEventListener('change', renderStops);
$('themeMode').addEventListener('change', () => show('pairRow', $('themeMode').value === 'system'));

$('saveLook').addEventListener('click', () => {
  const mode = $('themeMode').value;
  const display = { theme: mode };
  if (mode === 'system') { display.darkTheme = $('darkTheme').value; display.lightTheme = $('lightTheme').value; }
  const vizColor = (document.querySelector('input[name="vizColor"]:checked') || {}).value;
  saveSettings({
    display,
    audio: { visual: $('visual').value, visualizer: $('visual').value !== 'none', vizColor, energySeconds: Number($('energySeconds').value), sustainSeconds: Number($('sustainSeconds').value), energyColors: $('energyTheme').checked ? null : stops },
    unreadAlert: {
      enabled: $('unreadOn').checked, sweep: $('sweepOn').checked,
      sweepSeconds: Number($('sweepSeconds').value), sweepEverySeconds: Number($('sweepEvery').value),
      sweepEveryBreathingSeconds: Number($('sweepEveryBreathing').value), breatheSeconds: Number($('breatheSeconds').value),
      redAfterMinutes: Number($('redAfter').value), pulseAfterMinutes: Number($('pulseAfter').value) },
  }, 'msg-look', $('saveLook'));
});

async function loadSettings() {
  const { slack: sl = {}, email = {}, calendar = {}, audio = {}, display = {}, unreadAlert = {}, themes } = await S.settings();
  $('unreadOn').checked = unreadAlert.enabled !== false;
  $('sweepOn').checked = unreadAlert.sweep !== false;
  $('sweepSeconds').value = unreadAlert.sweepSeconds || 1.1;
  $('sweepEvery').value = unreadAlert.sweepEverySeconds || 30;
  $('sweepEveryBreathing').value = unreadAlert.sweepEveryBreathingSeconds || 12;
  $('breatheSeconds').value = unreadAlert.breatheSeconds || 3.5;
  $('redAfter').value = unreadAlert.redAfterMinutes || 30;
  $('pulseAfter').value = unreadAlert.pulseAfterMinutes || 60;

  slack.selected = [...new Set((sl.channels || []).map(String))];
  $('slackPreview').value = sl.previewMessages || 5;
  $('slackActiveDays').value = sl.activeDays ?? 14;
  renderSlack();

  $('senders').value = (email.senders || []).join('\n');
  $('prospects').value = (email.prospects || []).join('\n');
  $('emailGroupBy').value = email.groupBy || 'client';

  cals = (calendar.calendars || []).map((c) => (typeof c === 'string' ? { id: c } : c))
    .map((c) => ({ id: c.id, name: c.name || '', color: normHex(c.color) || '#7c9cff', on: true }));
  $('alertMinutes').value = calendar.alertMinutes ?? 5;
  renderCals();

  const opt = (value, text) => el('option', { value, text });
  const dark = themes.filter((t) => t.mode === 'dark'); const light = themes.filter((t) => t.mode === 'light');
  const pickDark = dark.some((t) => t.id === display.darkTheme) ? display.darkTheme : dark[0].id;
  const pickLight = light.some((t) => t.id === display.lightTheme) ? display.lightTheme : light[0].id;
  $('themeMode').replaceChildren(opt('system', 'Follow Windows'), ...themes.map((t) => opt(t.id, `Always ${t.name}`)));
  $('darkTheme').replaceChildren(...dark.map((t) => opt(t.id, t.name)));
  $('lightTheme').replaceChildren(...light.map((t) => opt(t.id, t.name)));
  // Legacy "dark"/"light" mean "pin the current pick".
  const mode = display.theme === 'dark' ? pickDark : display.theme === 'light' ? pickLight : (display.theme || 'system');
  $('themeMode').value = mode; $('darkTheme').value = pickDark; $('lightTheme').value = pickLight;
  show('pairRow', mode === 'system');

  $('visual').value = ['spectrum', 'art', 'none'].includes(audio.visual) ? audio.visual : audio.visualizer === false ? 'none' : 'spectrum';
  const vc = document.querySelector(`input[name="vizColor"][value="${['energy', 'sustain'].includes(audio.vizColor) ? audio.vizColor : 'accent'}"]`);
  if (vc) vc.checked = true;
  $('energySeconds').value = audio.energySeconds || 8;
  $('sustainSeconds').value = audio.sustainSeconds || 10;
  const custom = Array.isArray(audio.energyColors) ? audio.energyColors.map(normHex).filter(Boolean) : [];
  $('energyTheme').checked = custom.length < 2;
  stops = custom.length >= 2 ? custom : [...THEME_STOPS];
  renderStops();
}

refresh();
loadSettings();
