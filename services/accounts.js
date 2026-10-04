'use strict';
// Mail/calendar accounts. config.accounts lists them:
//   { id, provider: "google" | "microsoft", email, label?, mail?: false, calendar?: false, secret? }
// Each account's refresh token lives in secrets under `secret` (default TOKEN_<ID>).
// Without config.accounts, a stored GOOGLE_REFRESH_TOKEN is the one legacy account
// "google", so single-Google installs keep working untouched.
// Google accounts share one OAuth client (GOOGLE_CLIENT_ID/SECRET); Microsoft
// accounts share one multi-tenant app registration (MICROSOFT_CLIENT_ID).
const secrets = require('../main/secrets');

const PROVIDERS = ['google', 'microsoft'];

// "Alex@EWS.contoso.com" -> "alex-ews-contoso-com"
function accountSlug(email) {
  return String(email || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'account';
}

const tokenSecret = (a) => a.secret || `TOKEN_${a.id.toUpperCase().replace(/-/g, '_')}`;

// Short tag for rows when several accounts are merged: label, else the mail domain's
// first label ("alex@ews.contoso.com" -> "ews").
function accountLabel(a) {
  if (a.label) return a.label;
  const domain = String(a.email || '').split('@')[1] || '';
  return domain.split('.')[0] || a.id;
}

// Accounts as configured (ids slugged, duplicates and unknown providers dropped),
// plus the legacy Google account when there is no list.
function configured(config, has = secrets.has) {
  const raw = Array.isArray(config && config.accounts) ? config.accounts : [];
  const out = [];
  for (const a of raw) {
    if (!a || !PROVIDERS.includes(a.provider)) continue;
    const id = accountSlug(a.id || a.email);
    if (out.some((x) => x.id === id)) continue;
    out.push({ ...a, id, email: String(a.email || '').toLowerCase() });
  }
  if (!raw.length && has('GOOGLE_REFRESH_TOKEN')) out.push({ id: 'google', provider: 'google', email: '', secret: 'GOOGLE_REFRESH_TOKEN' });
  return out;
}

// Normalised account list from config. has(name) says whether a secret exists.
function listAccounts(config, has = secrets.has) {
  return configured(config, has).map((a) => ({ ...a, mail: a.mail !== false, calendar: a.calendar !== false, label: accountLabel(a) }));
}

// Authorised client for an account: a google-auth OAuth2Client or a microsoft Graph.
// Throws with a setup hint when credentials are missing.
function clientFor(account, { fresh = true } = {}) {
  const refreshToken = secrets.get(tokenSecret(account), { fresh });
  if (!refreshToken) throw new Error(`${account.email || account.id}: not signed in - open setup (Doombar.exe --setup)`);
  if (account.provider === 'google') {
    const clientId = secrets.get('GOOGLE_CLIENT_ID');
    const clientSecret = secrets.get('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) throw new Error('Google OAuth client not configured - open setup');
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client({ clientId, clientSecret });
    client.setCredentials({ refresh_token: refreshToken });
    return client;
  }
  const clientId = secrets.get('MICROSOFT_CLIENT_ID');
  if (!clientId) throw new Error('Microsoft app not registered - open setup');
  const { Graph } = require('./microsoft');
  return new Graph({
    clientId, refreshToken, tenant: account.tenantId || 'common',
    // Rotated refresh tokens are saved when storage is available (Electron); plain
    // Node keeps using the old one, which stays valid for its 90-day lifetime.
    onRefreshToken: (t) => { if (!secrets.unavailableReason()) secrets.set(tokenSecret(account), t); },
  });
}

// Config list after adding/updating one account (matched by id). Materialises the
// legacy Google account first so it is not lost when config.accounts appears.
function upsertAccount(config, account, has = secrets.has) {
  const list = configured(config, has);
  const i = list.findIndex((a) => a.id === account.id);
  if (i === -1) list.push(account); else list[i] = { ...list[i], ...account };
  return list;
}

// Config list without one account. Its token is the caller's to delete.
function removeAccount(config, id, has = secrets.has) {
  return configured(config, has).filter((a) => a.id !== id);
}

module.exports = { PROVIDERS, accountSlug, accountLabel, tokenSecret, configured, listAccounts, clientFor, upsertAccount, removeAccount };
