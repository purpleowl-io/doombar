'use strict';
// One-time auth setup, run under Electron so safeStorage is available.
// From a source checkout:            npm run setup [-- flags]
// From the packaged Windows build:   Doombar.exe --setup [flags]
//   (no flags)   opens the setup window
//   --cli        interactive prompts in the terminal instead
//   --from-env   import .env.local (repo root or the data dir) into safeStorage
//   --status     show which secrets are configured and where the data dir is
// Mail/calendar accounts (several Google and Microsoft 365 accounts, merged in the panels):
//   --accounts               list accounts and whether each is signed in
//   --add-google             sign in one more Google account (stored client ID/secret; --google is an alias)
//   --register-microsoft     create the multi-tenant "Doombar" Entra app (once per install)
//   --add-microsoft [--login=user@domain]   sign in a Microsoft 365 account
//   --remove-account=<id>    remove an account and delete its token
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { app, shell } = require('electron');
const { projectRoot, ensureDataDir } = require('../main/paths');
const env = require('../main/env');
const secrets = require('../main/secrets');

async function run(args) {
  await app.whenReady();

  // Default: the setup window. Flags below are the headless/scripting paths.
  const ACCOUNT_FLAGS = ['--accounts', '--add-google', '--google', '--register-microsoft', '--add-microsoft'];
  const headless = ['--cli', '--from-env', '--status', ...ACCOUNT_FLAGS].some((f) => args.includes(f)) || args.some((a) => a.startsWith('--remove-account='));
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

  const accountsCli = await runAccountFlags(args);
  if (accountsCli !== null) return app.exit(accountsCli);

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
    try {
      console.log('  Opening the browser for consent…');
      const a = await require('../main/account-setup').addGoogleAccount({ clientId, clientSecret, openUrl });
      console.log(`  Google account ${a.email} ${a.updated ? 'updated' : 'added'}.`);
    } catch (e) {
      console.log(`  Google setup failed: ${e.message}`);
    }
  }

  rl.close();
  console.log('\nDone. Current status:');
  console.table(secrets.status());
  app.exit(0);
}

async function openUrl(url) {
  console.log(`If the browser did not open, visit:\n${url}\n`);
  await shell.openExternal(url);
}

// Account flags. Returns an exit code, or null when none of them was given.
async function runAccountFlags(args) {
  const setup = require('../main/account-setup');
  const remove = args.find((a) => a.startsWith('--remove-account='));
  try {
    if (args.includes('--register-microsoft')) {
      console.log('Sign in with an account allowed to register apps in its Microsoft 365 directory…');
      const r = await setup.registerMicrosoftApp({ openUrl });
      console.log(`${r.created ? 'Created' : 'Reused'} app registration ${r.clientId} (tenant ${r.tenantId}, by ${r.by}); client ID stored.`);
      if (!args.includes('--add-microsoft')) return 0;
    }
    if (args.includes('--add-microsoft')) {
      const login = (args.find((a) => a.startsWith('--login=')) || '').slice('--login='.length) || undefined;
      console.log('Opening the browser for Microsoft sign-in…');
      const a = await setup.addMicrosoftAccount({ openUrl, loginHint: login });
      console.log(`Microsoft account ${a.email} ${a.updated ? 'updated' : 'added'} as "${a.id}".`);
      return 0;
    }
    if (args.includes('--add-google') || args.includes('--google')) {
      console.log('Opening the browser for Google consent…');
      const a = await setup.addGoogleAccount({ openUrl });
      console.log(`Google account ${a.email} ${a.updated ? 'updated' : 'added'} as "${a.id}".`);
      return 0;
    }
    if (remove) {
      setup.removeAccount(remove.slice('--remove-account='.length));
      console.log('Account removed.');
      return 0;
    }
    if (args.includes('--accounts')) {
      const list = setup.listWithStatus();
      if (!list.length) console.log('No accounts. Add one with --add-google or --add-microsoft.');
      else console.table(list.map((a) => ({ id: a.id, provider: a.provider, email: a.email, label: a.label, mail: a.mail, calendar: a.calendar, signedIn: a.signedIn })));
      return 0;
    }
  } catch (e) {
    console.error(`Failed: ${e.message}`);
    return 1;
  }
  return null;
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).catch((e) => { console.error(e.message); app.exit(1); });
}
