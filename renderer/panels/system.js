import { Panel, h, bytes } from './base.js';

function level(v, amber, red) { return v >= red ? 'red' : v >= amber ? 'amber' : ''; }

function sparkline(values, w = 240, ht = 40) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${ht}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.classList.add('spark');
  if (values.length < 2) return svg;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(ht - (Math.min(100, v) / 100) * ht).toFixed(1)}`);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M${pts.join(' L')}`); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'var(--accent-2)'); path.setAttribute('stroke-width', '2'); path.setAttribute('vector-effect', 'non-scaling-stroke');
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', `M0,${ht} L${pts.join(' L')} L${w},${ht} Z`); area.setAttribute('fill', 'var(--accent-2)'); area.setAttribute('opacity', '0.15');
  svg.append(area, path);
  return svg;
}

// Two series scaled to the busiest moment in the window: download as an area,
// upload as a line.
function netSpark(history, w = 240, ht = 40) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${ht}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.classList.add('spark');
  if (!history || history.length < 2) return svg;
  const max = Math.max(50 * 1024, ...history.map(([rx, tx]) => Math.max(rx, tx)));
  const step = w / (history.length - 1);
  const y = (v) => (ht - (Math.min(max, v) / max) * ht).toFixed(1);
  const rx = history.map(([r], i) => `${(i * step).toFixed(1)},${y(r)}`);
  const tx = history.map(([, t], i) => `${(i * step).toFixed(1)},${y(t)}`);
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', `M0,${ht} L${rx.join(' L')} L${w},${ht} Z`); area.setAttribute('fill', 'var(--accent-2)'); area.setAttribute('opacity', '0.25');
  const rxLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  rxLine.setAttribute('d', `M${rx.join(' L')}`); rxLine.setAttribute('fill', 'none'); rxLine.setAttribute('stroke', 'var(--accent-2)'); rxLine.setAttribute('stroke-width', '2'); rxLine.setAttribute('vector-effect', 'non-scaling-stroke');
  const txLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  txLine.setAttribute('d', `M${tx.join(' L')}`); txLine.setAttribute('fill', 'none'); txLine.setAttribute('stroke', 'var(--accent)'); txLine.setAttribute('stroke-width', '2'); txLine.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(area, rxLine, txLine);
  return svg;
}

export class SystemPanel extends Panel {
  constructor(name, config) { super(name, config, 'System'); }

  render(d) {
    const t = d.thresholds || {};
    const stats = [];

    const cpuLvl = level(d.cpu.total, t.cpuAmber ?? 70, t.cpuRed ?? 90);
    stats.push(h('div', { class: `stat ${cpuLvl}` },
      h('div', { class: 'k' }, h('span', { text: `CPU · ${d.cpu.cores.length} cores` }),
        h('button', { class: 'btn ghost taskmgr', text: 'Task Mgr', onClick: () => this.action('openTaskManager') })),
      h('div', { class: 'v', text: `${Math.round(d.cpu.total)}%` }),
      sparkline(d.cpu.history),
      h('div', { class: 'cores', style: { gridTemplateColumns: `repeat(${Math.min(16, Math.max(4, Math.ceil(d.cpu.cores.length / Math.ceil(d.cpu.cores.length / 16))))}, 1fr)` } },
        ...d.cpu.cores.map((c) => h('i', { style: { '--w': `${c}%` } })))));

    const ramLvl = level(d.mem.percent, t.ramAmber ?? 85, t.ramRed ?? 95);
    stats.push(h('div', { class: `stat ${ramLvl}` },
      h('div', { class: 'k' }, h('span', { text: 'RAM' }), h('span', { text: `${bytes(d.mem.total)}` })),
      h('div', { class: 'v' }, `${bytes(d.mem.used)}`, h('small', { text: `${d.mem.percent}%` })),
      h('div', { class: `bar ${ramLvl}` }, h('i', { style: { width: `${d.mem.percent}%` } }))));

    if (d.gpu) {
      const g = d.gpu;
      const gLvl = level(g.temperature, t.gpuTempAmber ?? 70, t.gpuTempRed ?? 80);
      const vram = g.memTotalMb ? Math.round((g.memUsedMb / g.memTotalMb) * 100) : 0;
      const extra = [`${g.temperature}°C`, g.powerW != null && `${g.powerW} W`, g.fan != null && `fan ${g.fan}%`].filter(Boolean);
      stats.push(h('div', { class: `stat gpu ${gLvl}` },
        h('div', { class: 'k' }, h('span', { text: 'GPU' }), h('span', { text: g.name.replace(/^NVIDIA (GeForce )?/, '') })),
        h('div', { class: 'v' }, `${g.utilization}%`, ...extra.map((x) => h('small', { text: x }))),
        sparkline(g.history || []),
        h('div', { class: 'k' }, h('span', { text: 'VRAM' }), h('span', { text: `${(g.memUsedMb / 1024).toFixed(1)} / ${Math.round(g.memTotalMb / 1024)} GB` })),
        h('div', { class: `bar ${level(vram, 80, 95)}` }, h('i', { style: { width: `${vram}%` } }))));
    }

    for (const disk of (d.disks || []).slice(0, 3)) {
      const lvl = level(disk.percent, t.diskAmber ?? 85, t.diskRed ?? 95);
      stats.push(h('div', { class: `stat ${lvl}` },
        h('div', { class: 'k' }, h('span', { text: `Disk ${disk.mount}` }), h('span', { text: `${bytes(disk.size - disk.used)} free` })),
        h('div', { class: `bar ${lvl}` }, h('i', { style: { width: `${disk.percent}%` } }))));
    }

    stats.push(h('div', { class: 'stat' },
      h('div', { class: 'k' }, h('span', { text: 'Network' }), h('span', { text: d.net.iface })),
      h('div', { class: 'v net' }, h('span', { class: 'rx', text: `↓ ${bytes(d.net.rxSec)}/s` }), h('small', { class: 'tx', text: `↑ ${bytes(d.net.txSec)}/s` })),
      netSpark(d.net.history, 240, 24)));

    this.body.replaceChildren(h('div', { class: 'sys' }, ...stats));
  }
}
