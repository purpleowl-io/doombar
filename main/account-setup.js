'use strict';
// Mail/calendar account management shared by the setup window and the setup CLI:
// register the Microsoft app, sign accounts in (browser consent), list and remove
// them. Accounts go into config.accounts (user config.json); refresh tokens into
// secrets as TOKEN_<ID>. A running dashboard picks both up via config hot-reload.
const secrets = require('./secrets');
const { Config } = require('./config');
const { scoped } = require('./log');
const accounts = require('../services/accounts');

const log = scoped('accounts');

// Azure CLI's public client: preauthorised for Graph directory access, so it can
// create the app registration on the signed-in user's behalf (as `az ad app create`
// would). Used only for that one call.
const AZ_CLI_CLIENT = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const GRAPH_APP = '00000003-0000-0000-c000-000000000000';
// Delegated Graph permission ids.
const SCOPE_IDS = {
  'User.Read': 'e1fe6dd8-ba31-4d61-89e7-88639da4683d',
  'Mail.ReadWrite': 'e383f46e-2787-4529-855e-0e479a3ffac0',
  'Calendars.Read': '465a38f9-76ea-45b9-9f34-9e8b0d4b0b42',
  offline_access: '7427e0e9-2fba-42fe-b0c0-848c9e6a8182',
  openid: '37f7f235-527c-4136-accd-4a02d197296e',
  profile: '14dad69e-099b-42c9-810b-d002981feec1',
};
const APP_NAME = 'Doombar';

let shared = null;
const config = () => { shared ||= new Config(); shared.reload(); return shared; };

// Creates (or finds) the multi-tenant "Doombar" app registration in the signed-in
// user's directory and stores its client ID. Needs a user allowed to register apps.
async function registerMicrosoftApp({ openUrl }) {
  const ms = require('../services/microsoft');
  const signin = await ms.authorizeInteractive({
    clientId: AZ_CLI_CLIENT, openUrl, scopes: ['openid', 'profile', 'offline_access', 'https://graph.microsoft.com/.default'],
  });
  const graph = (method, path, body) => fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method, headers: { Authorization: `Bearer ${signin.accessToken}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Graph ${r.status}: ${data.error ? data.error.message : r.statusText}`);
    return data;
  });

  const existing = await graph('GET', `/applications?$filter=${encodeURIComponent(`displayName eq '${APP_NAME}'`)}&$select=id,appId,publicClient`);
  let app = (existing.value || [])[0];
  const spec = {
    isFallbackPublicClient: true,
    publicClient: { redirectUris: ['http://localhost'] },
    requiredResourceAccess: [{ resourceAppId: GRAPH_APP, resourceAccess: Object.values(SCOPE_IDS).map((id) => ({ id, type: 'Scope' })) }],
  };
  if (app) {
    await graph('PATCH', `/applications/${app.id}`, spec);
    log.info(`reusing app registration ${app.appId}`);
  } else {
    app = await graph('POST', '/applications', {
      displayName: APP_NAME,
      signInAudience: 'AzureADandPersonalMicrosoftAccount',
      api: { requestedAccessTokenVersion: 2 },
      ...spec,
    });
    log.info(`created app registration ${app.appId} in tenant ${signin.tenantId}`);
  }
  secrets.set('MICROSOFT_CLIENT_ID', app.appId);
  return { clientId: app.appId, created: !existing.value.length, by: signin.email, tenantId: signin.tenantId };
}

// The legacy Google account's address, so materialising it gives it a real id.
async function googleEmail(refreshToken) {
  const { OAuth2Client } = require('google-auth-library');
  const auth = new OAuth2Client({ clientId: secrets.get('GOOGLE_CLIENT_ID'), clientSecret: secrets.get('GOOGLE_CLIENT_SECRET') });
  auth.setCredentials({ refresh_token: refreshToken });
  const { gmail } = require('@googleapis/gmail');
  const p = await gmail({ version: 'v1', auth }).users.getProfile({ userId: 'me' });
  return String(p.data.emailAddress || '').toLowerCase();
}

// Writes the account (and its token) into config/secrets. An account with the same
// provider and address is updated in place, keeping its id, secret and settings.
async function saveAccount(provider, email, refreshToken, extra = {}) {
  const c = config();
  const data = c.get();
  // Give the implicit legacy Google account its address before it is written out.
  const current = accounts.listAccounts(data);
  const legacy = current.find((a) => a.id === 'google' && !a.email && !(data.accounts || []).length);
  if (legacy) {
    try { legacy.email = await googleEmail(secrets.get(legacy.secret)); } catch (e) { log.warn('legacy Google account address unknown:', e.message); }
  }
  const same = current.find((a) => a.provider === provider && a.email && a.email === email);
  const account = same ? { id: same.id, provider, email, ...extra } : { id: accounts.accountSlug(email), provider, email, ...extra };
  if (!same && current.some((a) => a.id === account.id)) account.id = `${account.id}-${provider}`;
  const secret = accounts.tokenSecret(same || account);
  secrets.set(secret, refreshToken);
  let list = accounts.upsertAccount(data, account);
  if (legacy) list = list.map((a) => (a.id === 'google' ? { ...a, email: legacy.email } : a));
  c.save({ accounts: list });
  log.info(`${same ? 'updated' : 'added'} ${provider} account ${email} (${account.id})`);
  return { ...account, updated: !!same };
}

async function addMicrosoftAccount({ openUrl, loginHint }) {
  const clientId = secrets.get('MICROSOFT_CLIENT_ID');
  if (!clientId) throw new Error('register the Microsoft app first');
  const ms = require('../services/microsoft');
  const r = await ms.authorizeInteractive({ clientId, openUrl, loginHint });
  if (!r.email) throw new Error('Microsoft did not say which account signed in');
  return saveAccount('microsoft', r.email, r.refreshToken, r.tenantId ? { tenantId: r.tenantId } : {});
}

async function addGoogleAccount({ openUrl, clientId, clientSecret }) {
  if (clientId && clientSecret) { secrets.set('GOOGLE_CLIENT_ID', clientId); secrets.set('GOOGLE_CLIENT_SECRET', clientSecret); }
  clientId = secrets.get('GOOGLE_CLIENT_ID'); clientSecret = secrets.get('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('Google OAuth client ID and secret are required');
  const { authorizeInteractive } = require('../services/google');
  // select_account so a second Google account can be picked while signed in to the first.
  const refresh = await authorizeInteractive({ clientId, clientSecret, openUrl, prompt: 'consent select_account' });
  return saveAccount('google', await googleEmail(refresh), refresh);
}

// Accounts with whether their token is present. Never returns token values.
function listWithStatus() {
  return accounts.listAccounts(config().get()).map((a) => ({ ...a, signedIn: secrets.has(accounts.tokenSecret(a)) }));
}

// Removes the account from config (and its calendars), then deletes its token.
function removeAccount(id) {
  const c = config();
  const data = c.get();
  const gone = accounts.listAccounts(data).find((a) => a.id === id);
  if (!gone) throw new Error(`no account ${id}`);
  const list = accounts.removeAccount(data, id);
  const cals = (data.calendar && data.calendar.calendars) || [];
  const firstGoogle = (accounts.listAccounts(data).find((a) => a.provider === 'google') || {}).id;
  const keep = cals.filter((x) => (x.account || firstGoogle) !== id);
  // Entries without an account belonged to the first Google account; pin them before it changes.
  const pinned = keep.map((x) => (x.account ? x : { ...x, account: firstGoogle }));
  c.save({ accounts: list, calendar: { calendars: pinned } });
  try { secrets.remove(accounts.tokenSecret(gone)); } catch (e) { log.warn(`token for ${id} not removed: ${e.message}`); }
  log.info(`removed account ${gone.email || id}`);
  return { ok: true };
}

// Mail / calendar switches per account.
function setAccountFlags(id, { mail, calendar, label }) {
  const c = config();
  const data = c.get();
  const list = accounts.removeAccount(data, '\0').map((a) => {
    if (a.id !== id) return a;
    const o = { ...a };
    if (typeof mail === 'boolean') { if (mail) delete o.mail; else o.mail = false; }
    if (typeof calendar === 'boolean') { if (calendar) delete o.calendar; else o.calendar = false; }
    if (typeof label === 'string') { if (label.trim()) o.label = label.trim().slice(0, 24); else delete o.label; }
    return o;
  });
  c.save({ accounts: list });
  return { ok: true };
}

// Every calendar of every signed-in account, for the calendar picker.
async function allCalendars() {
  const out = []; const errors = [];
  for (const a of accounts.listAccounts(config().get())) {
    try {
      const auth = accounts.clientFor(a);
      const Src = a.provider === 'google' ? require('../services/sources/gcal').GoogleCalendarSource : require('../services/sources/outlook-calendar').OutlookCalendarSource;
      for (const cal of await new Src({ account: a, auth }).calendars()) out.push({ ...cal, account: a.id, accountLabel: a.label, accountEmail: a.email });
    } catch (e) { errors.push(`${a.email || a.id}: ${e.message}`); }
  }
  return { calendars: out, errors };
}

module.exports = { registerMicrosoftApp, addMicrosoftAccount, addGoogleAccount, listWithStatus, removeAccount, setAccountFlags, allCalendars };
