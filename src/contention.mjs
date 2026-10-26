// Is this machine busy with someone else's test suite right now?
//
// Two full suites on one machine starve each other, and the result reads like a real
// failure (worker start-up timeouts, hook timeouts) when it isn't. The gate records
// what it saw on the evidence, so a red under contention is reported as "re-run when
// quiet", not as a regression. Port of the idea in openwop-app's preflight-suite.sh.
// With a tracegate-ci broker configured, the broker queues the work instead.
import { spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';

export const SUITE_RE = /\b(vitest|jest|playwright|mocha|ava|pytest|node --test|cargo test|go test)\b/;

function cwdOf(pid) {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { /* not linux */ }
  const r = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  return r.stdout?.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null;
}

// Test-suite processes running from a directory other than `root`, not ours.
export function competitors(root, { ps = () => spawnSync('ps', ['-axo', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' }).stdout ?? '', cwd = cwdOf } = {}) {
  const mine = new Set([process.pid, process.ppid]);
  const rows = ps().split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, stat, command]) => ({ pid: Number(pid), ppid: Number(ppid), stat, command }));
  const seen = new Map();
  for (const r of rows) {
    if (mine.has(r.pid) || mine.has(r.ppid)) continue;
    if (r.stat.startsWith('T')) continue; // stopped: holds no CPU
    if (!SUITE_RE.test(r.command) || /\b(--watch|watch)\b/.test(r.command)) continue; // idle watchers don't compete
    const dir = cwd(r.pid);
    if (!dir || dir === root || dir.startsWith(`${root}/`)) continue;
    // One entry per directory: a suite's workers share its cwd.
    if (!seen.has(dir)) seen.set(dir, { dir, pid: r.pid, command: r.command.slice(0, 120) });
  }
  return [...seen.values()];
}

export function sample(root, opts) {
  const cores = cpus().length;
  const load1 = +loadavg()[0].toFixed(2);
  const others = competitors(root, opts);
  return { load1, cores, busy: load1 > cores, competitors: others, contended: others.length > 0 || load1 > cores * 1.5 };
}

// Wait up to `minutes` for the machine to be quiet, checking every 15 s.
export async function waitQuiet(root, minutes, log = () => {}) {
  const until = Date.now() + minutes * 60_000;
  let s = sample(root);
  while (s.contended && Date.now() < until) {
    log(`waiting: load ${s.load1} on ${s.cores} cores; ${s.competitors.map((c) => c.dir).join(', ') || 'no other suite'}`);
    await new Promise((r) => setTimeout(r, 15_000));
    s = sample(root);
  }
  return s;
}
