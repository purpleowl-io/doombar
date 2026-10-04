'use strict';
// Slack-only setup (Appendix A.3 of ultrawide.md). `npm run setup` covers this too.
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { WebClient } = require('@slack/web-api');
const { app } = require('electron');
const secrets = require('../main/secrets');

async function main() {
  await app.whenReady();
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const appToken = (await rl.question('App-level token (xapp-…): ')).trim();
  const userToken = (await rl.question('User OAuth token (xoxp-…): ')).trim();
  const botToken = (await rl.question('Bot OAuth token (xoxb-…): ')).trim();
  rl.close();

  const user = await new WebClient(userToken).auth.test();
  if (!user.ok) throw new Error('User token rejected: ' + user.error);
  const bot = await new WebClient(botToken).auth.test();
  if (!bot.ok) throw new Error('Bot token rejected: ' + bot.error);
  if (!appToken.startsWith('xapp-')) throw new Error('App token should start with xapp-');

  console.log(`User token OK for ${user.user} in ${user.team}`);
  console.log(`Bot token OK (${bot.user})`);

  secrets.set('SLACK_APP_TOKEN', appToken);
  secrets.set('SLACK_USER_TOKEN', userToken);
  secrets.set('SLACK_BOT_TOKEN', botToken);
  console.log('Saved (encrypted) to the data directory.');
  app.exit(0);
}

main().catch((e) => { console.error(e.data?.error || e.message); app.exit(1); });
