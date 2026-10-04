'use strict';
// Shared Google OAuth client. Desktop app flow with a loopback redirect; the
// refresh token is kept in safeStorage (or .env.local on the dev box).
const http = require('node:http');
const { OAuth2Client } = require('google-auth-library');
const secrets = require('../main/secrets');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

function credentials() {
  const clientId = secrets.get('GOOGLE_CLIENT_ID');
  const clientSecret = secrets.get('GOOGLE_CLIENT_SECRET');
  const refreshToken = secrets.get('GOOGLE_REFRESH_TOKEN');
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, refreshToken };
}

// Returns an authorised OAuth2Client, or null when not configured.
function authClient() {
  const c = credentials();
  if (!c || !c.refreshToken) return null;
  const client = new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret });
  client.setCredentials({ refresh_token: c.refreshToken });
  return client;
}

// Interactive one-time authorisation used by scripts/setup.js.
// Opens the consent URL (caller prints/opens it), listens on 127.0.0.1 for the
// redirect, exchanges the code, and resolves with the refresh token.
async function authorizeInteractive({ clientId, clientSecret, openUrl, scopes = SCOPES, timeoutMs = 5 * 60 * 1000 }) {
  const server = http.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes });

  // Attach the redirect handler before opening the browser so an early redirect is never dropped.
  const codePromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => { server.close(); reject(new Error('timed out waiting for Google redirect')); }, timeoutMs);
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }
      const err = u.searchParams.get('error');
      const c = u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(err ? `<h2>Google sign-in failed: ${err}</h2>` : '<h2>Doombar is connected. You can close this tab.</h2>');
      clearTimeout(t);
      server.close();
      if (err) reject(new Error(err)); else resolve(c);
    });
  });
  codePromise.catch(() => {}); // surfaced below; avoid an unhandled rejection if openUrl throws first

  await openUrl(url);
  const code = await codePromise;

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token (revoke the app at myaccount.google.com/permissions and retry)');
  return tokens.refresh_token;
}

module.exports = { SCOPES, credentials, authClient, authorizeInteractive };
