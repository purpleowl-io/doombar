'use strict';
// npm run deploy [-- --no-build]: build the unpacked app, stop the running copy,
// mirror it into the install folder, add a Start menu shortcut, and start it.
// The app registers itself as a login item on boot (main/index.js) and runs under
// main/watchdog.js, which restarts it after crashes.
// Install folder: %LOCALAPPDATA%\Programs\Doombar, or DOOMBAR_INSTALL_DIR.
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'dist', 'win-unpacked');
const target = process.env.DOOMBAR_INSTALL_DIR || path.join(process.env.LOCALAPPDATA, 'Programs', 'Doombar');
const exe = path.join(target, 'Doombar.exe');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
  if (r.error) throw r.error;
  return r.status;
}

function running() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Doombar.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
  return /Doombar\.exe/i.test(r.stdout || '');
}

if (!process.argv.includes('--no-build')) {
  console.log('building dist/win-unpacked ...');
  if (run('npx electron-builder --win dir', [], { cwd: root, shell: true }) !== 0) {
    console.error('build failed'); process.exit(1);
  }
}
if (!fs.existsSync(path.join(source, 'Doombar.exe'))) {
  console.error(`no build at ${source}`); process.exit(1);
}

// /T takes the watchdog down with its dashboard; both are Doombar.exe anyway.
if (running()) {
  console.log('stopping running Doombar ...');
  spawnSync('taskkill', ['/IM', 'Doombar.exe', '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const until = Date.now() + 15000;
  while (running() && Date.now() < until) spawnSync('ping', ['-n', '2', '127.0.0.1'], { stdio: 'ignore' });
  if (running()) { console.error('Doombar.exe is still running; stop it and retry'); process.exit(1); }
}

console.log(`copying to ${target} ...`);
const rc = run('robocopy', [source, target, '/MIR', '/R:3', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']);
if (rc >= 8) { console.error(`robocopy failed (${rc})`); process.exit(1); }

const lnk = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Doombar.lnk');
const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');`
  + `$s.TargetPath='${exe.replace(/'/g, "''")}';$s.WorkingDirectory='${target.replace(/'/g, "''")}';$s.Save()`;
if (run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]) !== 0) console.warn('could not create the Start menu shortcut');

console.log('starting Doombar ...');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(exe, [], { cwd: target, env, detached: true, stdio: 'ignore' }).unref();
console.log(`installed. Login item and watchdog are set up on first run; logs in %APPDATA%\\doombar\\logs`);
