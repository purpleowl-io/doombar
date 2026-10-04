#!/usr/bin/env node
'use strict';
// npm run dump -- <service> [--watch] [--action=name:{json}]
// Same as `node services/<service>.js --dump`, one entry point for all of them.
const name = process.argv[2];
const known = ['system', 'timers', 'calendar', 'email', 'slack', 'audio'];
if (!known.includes(name)) {
  console.error(`usage: npm run dump -- <${known.join('|')}> [--watch] [--action=name:{json}]`);
  process.exit(2);
}
process.argv.splice(2, 1, '--dump');
const mod = require(`../services/${name}.js`);
const Ctor = Object.values(mod).find((v) => typeof v === 'function' && /Service$/.test(v.name));
require('../services/standalone').runStandalone(Ctor, { waitMs: name === 'system' ? 8000 : 20000 });
