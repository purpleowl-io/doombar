'use strict';
// Microsoft 365 (Entra ID) OAuth and a small Graph client. Public-client flow:
// authorization code + PKCE with a loopback redirect, no client secret. The app
// registration is multi-tenant, so one client ID serves any number of accounts in
// any organisation (scripts/setup.js --register-microsoft creates it).
// Refresh tokens rotate on every use; Graph#onRefreshToken persists the new one.
const http = require('node:http');
const crypto = require('node:crypto');

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['offline_access', 'openid', 'profile', 'User.Read', 'Mail.ReadWrite', 'Calendars.Read'];

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString('utf8')); } catch { return {}; }
}

async function tokenRequest(tenant, form) {
  const res = await fetch(`${LOGIN}/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error_description ? body.error_description.split('\r\n')[0] : `token endpoint ${res.status}`);
    err.code = body.error; err.status = res.status;
    throw err;
  }
  return body;
}

// Interactive sign-in. openUrl gets the consent URL (caller opens/prints it); the
// redirect lands on http://localhost:<port> (Entra accepts any port for a registered
// http://localhost). Resolves with { refreshToken, accessToken, email, name, tenantId }.
async function authorizeInteractive({ clientId, openUrl, tenant = 'common', scopes = SCOPES, loginHint, timeoutMs = 5 * 60 * 1000 }) {
  const server = http.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const redirectUri = `http://localhost:${server.address().port}`;
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  const q = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
    scope: scopes.join(' '), state, prompt: 'select_account',
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  });
  if (loginHint) q.set('login_hint', loginHint);
  const url = `${LOGIN}/${tenant}/oauth2/v2.0/authorize?${q}`;

  const codePromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => { server.close(); reject(new Error('timed out waiting for the Microsoft redirect')); }, timeoutMs);
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/' || (!u.searchParams.has('code') && !u.searchParams.has('error'))) { res.writeHead(404).end(); return; }
      const err = u.searchParams.get('error') && `${u.searchParams.get('error')}: ${u.searchParams.get('error_description') || ''}`.trim();
      const bad = !err && u.searchParams.get('state') !== state ? 'state mismatch' : null;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(err || bad ? '<h2>Microsoft sign-in failed. You can close this tab.</h2>' : '<h2>Doombar is connected. You can close this tab.</h2>');
      clearTimeout(t);
      server.close();
      if (err || bad) reject(new Error(err || bad)); else resolve(u.searchParams.get('code'));
    });
  });
  codePromise.catch(() => {});

  await openUrl(url);
  const code = await codePromise;
  const tok = await tokenRequest(tenant, {
    client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    code_verifier: verifier, scope: scopes.join(' '),
  });
  if (!tok.refresh_token) throw new Error('Microsoft did not return a refresh token (offline_access missing?)');
  const id = decodeJwt(tok.id_token);
  return {
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    email: String(id.preferred_username || id.email || '').toLowerCase(),
    name: id.name || '',
    tenantId: id.tid || null,
  };
}

// Graph client for one account. token() refreshes as needed (one request in flight).
class Graph {
  constructor({ clientId, refreshToken, tenant = 'common', onRefreshToken = () => {}, scopes = SCOPES }) {
    this.clientId = clientId;
    this.refreshToken = refreshToken;
    this.tenant = tenant;
    this.scopes = scopes;
    this.onRefreshToken = onRefreshToken;
    this.access = null;
    this.expires = 0;
    this.inflight = null;
  }

  async token() {
    if (this.access && Date.now() < this.expires - 60000) return this.access;
    this.inflight ||= tokenRequest(this.tenant, {
      client_id: this.clientId, grant_type: 'refresh_token', refresh_token: this.refreshToken, scope: this.scopes.join(' '),
    }).then((t) => {
      this.access = t.access_token;
      this.expires = Date.now() + (Number(t.expires_in) || 3600) * 1000;
      if (t.refresh_token && t.refresh_token !== this.refreshToken) {
        this.refreshToken = t.refresh_token;
        try { this.onRefreshToken(t.refresh_token); } catch { /* persisting is best effort; the old token stays valid */ }
      }
      return this.access;
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  // path is relative to /v1.0 ("/me/messages?...") or an absolute @odata.nextLink.
  async request(method, path, { body, headers = {} } = {}) {
    const url = path.startsWith('https://') ? path : GRAPH + path;
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`Graph ${res.status}: ${(data && data.error && data.error.message) || res.statusText}`);
      err.status = res.status; err.code = data && data.error && data.error.code;
      throw err;
    }
    return data;
  }

  get(path, opts) { return this.request('GET', path, opts); }

  // Follows @odata.nextLink until `limit` items (or the end).
  async list(path, { limit = Infinity, headers } = {}) {
    const out = [];
    let next = path;
    while (next && out.length < limit) {
      const page = await this.get(next, { headers });
      out.push(...(page.value || []));
      next = page['@odata.nextLink'];
    }
    return out.slice(0, limit);
  }

  // JSON $batch, 20 requests per call. reqs: [{ method, url, body }]. Returns responses in order.
  async batch(reqs) {
    const out = [];
    for (let i = 0; i < reqs.length; i += 20) {
      const chunk = reqs.slice(i, i + 20).map((r, k) => ({ id: String(k), method: r.method, url: r.url, ...(r.body ? { body: r.body, headers: { 'Content-Type': 'application/json' } } : {}) }));
      const res = await this.request('POST', '/$batch', { body: { requests: chunk } });
      const byId = new Map((res.responses || []).map((r) => [r.id, r]));
      chunk.forEach((c) => out.push(byId.get(c.id)));
    }
    return out;
  }
}

module.exports = { SCOPES, authorizeInteractive, Graph, decodeJwt };
