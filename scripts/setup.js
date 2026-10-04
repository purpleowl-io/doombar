'use strict';
// One-time auth setup, run under Electron so safeStorage is available.
// From a source checkout:            npm run setup [-- flags]
// From the packaged Windows build:   Doombar.exe --setup [flags]
//   (no flags)   opens the setup window
//   --cli        interactive prompts in the terminal instead
//   --from-env   import .env.local (repo root or the data dir) into safeStorage
//   --google     run the Google consent flow using stored client ID/secret (no typing)
//   --status     show which secrets are configured and where the data dir is
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { app, shell } = require('electron');
const { projectRoot, ensureDataDir } = require('../main/paths');
const env = require('../main/env');
const secrets = require('../main/secrets');

async function run(args) {
  await app.whenReady();

  // Default: the setup window. Flags below are the headless/scripting paths.
  const headless = ['--cli', '--from-env', '--google', '--status'].some((f) => args.includes(f));
  if (!headless) {
    const { openSetupWindow } = require('../main/setup-window');
    const win = openSetupWindow();
    win.on('closed', () => app.quit());
    return;
  }

  console.log(`Data directory: ${ensureDataDir()}`);
  const why = secrets.unavailableReason();
  if (why && !args.includes('--status')) {
    console.error(`\nCannot run setup here: ${why}.`);
    console.error('On the Windows workstation this works out of the box (DPAPI).');
    console.error('On this dev box, put secrets in .env.local instead; the app reads it at startup.');
    console.error('Tip: `npm run setup 2>/dev/null` hides the harmless D-Bus noise on WSL.\n');
    return app.exit(2);
  }

  if (args.includes('--status')) {
    console.table(secrets.status());
    return app.exit(0);
  }

  if (args.includes('--from-env')) {
    const vars = { ...env.load(projectRoot), ...env.load(ensureDataDir()) };
    let n = 0;
    for (const name of secrets.NAMES) {
      if (vars[name]) { secrets.set(name, vars[name]); n++; console.log(`stored ${name}`); }
    }
    console.log(n ? `${n} secret(s) encrypted into safeStorage. You can now delete .env.local.` : 'nothing found in .env.local (looked in the repo root and the data directory)');
    return app.exit(0);
  }

  if (args.includes('--google')) {
    const clientId = secrets.get('GOOGLE_CLIENT_ID');
    const clientSecret = secrets.get('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      console.error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not stored yet; put them in .env.local and run --from-env first.');
      return app.exit(2);
    }
    const { authorizeInteractive } = require('../services/google');
    try {
      console.log('Opening the browser for Google consent…');
      const refresh = await authorizeInteractive({
        clientId, clientSecret,
        openUrl: async (url) => { console.log(`If the browser did not open, visit:\n${url}\n`); await shell.openExternal(url); },
      });
      secrets.set('GOOGLE_REFRESH_TOKEN', refresh);
      console.log('Google connected, refresh token stored.');
      return app.exit(0);
    } catch (e) {
      console.error(`Google setup failed: ${e.message}`);
      return app.exit(1);
    }
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = async (q) => (await rl.question(q)).trim();
  const status = secrets.status();
  const mark = (n) => (status[n] ? ` [set via ${status[n]}]` : '');

  console.log('\nDoombar setup. Press Enter to skip any step.\n');

  // --- Claude ---------------------------------------------------------------
  const key = await ask(`Anthropic API key (sk-ant-...)${mark('ANTHROPIC_API_KEY')}: `);
  if (key) {
    const Anthropic = require('@anthropic-ai/sdk');
    try {
      const client = new Anthropic({ apiKey: key });
      await client.models.list({ limit: 1 });
      secrets.set('ANTHROPIC_API_KEY', key);
      console.log('  Claude key OK, stored.');
    } catch (e) {
      console.log(`  Claude key rejected: ${e.message}`);
    }
  }

  // --- Slack ----------------------------------------------------------------
  const appToken = await ask(`Slack app-level token (xapp-...)${mark('SLACK_APP_TOKEN')}: `);
  if (appToken) {
    const userToken = await ask('Slack user OAuth token (xoxp-...): ');
    const botToken = await ask('Slack bot OAuth token (xoxb-...): ');
    const { WebClient } = require('@slack/web-api');
    try {
      if (!appToken.startsWith('xapp-')) throw new Error('app token should start with xapp-');
      const user = await new WebClient(userToken).auth.test();
      console.log(`  user token OK for ${user.user} in ${user.team}`);
      if (botToken) { const bot = await new WebClient(botToken).auth.test(); console.log(`  bot token OK (${bot.user})`); }
      secrets.set('SLACK_APP_TOKEN', appToken);
      secrets.set('SLACK_USER_TOKEN', userToken);
      if (botToken) secrets.set('SLACK_BOT_TOKEN', botToken);
      console.log('  Slack tokens stored.');
    } catch (e) {
      console.log(`  Slack setup failed: ${e.data?.error || e.message}`);
    }
  }

  // --- Google ---------------------------------------------------------------
  console.log('\nGoogle: create an OAuth client of type "Desktop app" in the GCP console');
  console.log('(APIs & Services -> Credentials), enable the Calendar and Gmail APIs, then paste:');
  const clientId = await ask(`Google OAuth client ID${mark('GOOGLE_CLIENT_ID')}: `);
  if (clientId) {
    const clientSecret = await ask('Google OAuth client secret: ');
    const { authorizeInteractive } = require('../services/google');
    try {
      console.log('  Opening the browser for consent…');
      const refresh = await authorizeInteractive({
        clientId, clientSecret,
        openUrl: async (url) => { console.log(`  If the browser did not open, visit:\n  ${url}\n`); await shell.openExternal(url); },
      });
      secrets.set('GOOGLE_CLIENT_ID', clientId);
      secrets.set('GOOGLE_CLIENT_SECRET', clientSecret);
      secrets.set('GOOGLE_REFRESH_TOKEN', refresh);
      console.log('  Google connected, refresh token stored.');
    } catch (e) {
      console.log(`  Google setup failed: ${e.message}`);
    }
  }

  rl.close();
  console.log('\nDone. Current status:');
  console.table(secrets.status());
  app.exit(0);
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).catch((e) => { console.error(e.message); app.exit(1); });
}
