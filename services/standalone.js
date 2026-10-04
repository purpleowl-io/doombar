'use strict';
// `node services/<name>.js --dump` runs one service outside Electron, waits for
// its first state, prints it as JSON, and exits.
//   --watch                 keep printing every state change
//   --action=name:{json}    run an action after start (e.g. start:{"minutes":5})
const { load: loadEnv } = require('../main/env');
const { Config } = require('../main/config');
const { open } = require('../main/db');
const { projectRoot, dbPath } = require('../main/paths');

function waitForSettled(svc, ms) {
  return new Promise((resolve) => {
    const isSettled = (s) => (s.status === 'connected' && s.lastUpdated) || s.status === 'error' || s.status === 'disabled';
    if (isSettled(svc.getState())) return resolve();
    const onState = (s) => { if (isSettled(s)) { cleanup(); resolve(); } };
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const cleanup = () => { clearTimeout(t); svc.off('state', onState); };
    svc.on('state', onState);
  });
}

async function runStandalone(ServiceClass, { waitMs = 8000 } = {}) {
  loadEnv(projectRoot);
  const argv = process.argv.slice(2);
  const watch = argv.includes('--watch');
  const config = new Config();
  const db = open(process.env.DOOMBAR_DB || dbPath());
  const svc = new ServiceClass({ config: config.get(), db });

  const print = () => process.stdout.write(JSON.stringify(svc.getState(), null, 2) + '\n');

  if (watch) svc.on('state', print);

  await svc.start();

  const actionArg = argv.find((a) => a.startsWith('--action='));
  if (actionArg) {
    const spec = actionArg.slice('--action='.length);
    const colon = spec.indexOf(':');
    const name = colon === -1 ? spec : spec.slice(0, colon);
    const json = colon === -1 ? '' : spec.slice(colon + 1);
    try {
      const result = await svc.runAction(name, json ? JSON.parse(json) : {});
      process.stdout.write(JSON.stringify({ action: name, result: result ?? null }, null, 2) + '\n');
    } catch (e) {
      process.stderr.write(`action failed: ${e.message}\n`);
    }
  }

  if (watch) return; // Ctrl+C to stop

  await waitForSettled(svc, waitMs);
  print();
  await svc.stop();
  db.close();
  process.exit(svc.status === 'error' ? 1 : 0);
}

module.exports = { runStandalone };
