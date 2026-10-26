// Run the project's gates and record a verdict bound to the exact working tree.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, pkgVersion } from './config.mjs';
import { head, workingTree } from './git.mjs';
import { ensureStateIgnored } from './install.mjs';
import { cleanEnv } from './probe.mjs';
import { leaseShell } from './broker.mjs';
import { sample } from './contention.mjs';

export const evidenceDir = (root) => join(root, STATE_DIR, 'evidence');

function runShell(cmd, cwd, { quiet, logFile = null }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const piped = quiet || logFile;
    const child = spawn(cmd, { cwd, shell: true, env: cleanEnv(), stdio: piped ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let tail = '';
    // With a log file, the full output goes there and only the tail is kept in memory.
    const keep = (d) => { tail = (tail + d.toString()).slice(-4000); if (logFile) appendFileSync(logFile, d); if (!quiet && logFile) process.stderr.write(d); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('close', (code, signal) => resolve({ exitCode: code ?? -1, signal, durationMs: Date.now() - started, tail }));
  });
}

export async function runGates(root, cfg, { only = null, keepGoing = false, quiet = false, kind = 'gate', contention = null, logFile = null } = {}) {
  ensureStateIgnored(root);
  const gates = only ? cfg.gates.filter((g) => only.includes(g.name)) : cfg.gates;
  if (!gates.length) throw new Error(only ? `no gate named ${only.join(', ')}` : 'no gates configured in hyvemind.json');
  const record = {
    tool: 'hyvemind',
    version: pkgVersion(),
    startedAt: new Date().toISOString(),
    head: head(root),
    treeBefore: workingTree(root),
    partial: Boolean(only),
    gates: [],
  };
  // What else was running when the gate started. A red under contention is not
  // evidence of a regression (a broker, when configured, queues instead).
  const before = contention ?? (cfg.broker ? null : sample(root));
  if (before) record.contention = before;
  let red = false;
  for (const g of gates) {
    if (red && !keepGoing) { record.gates.push({ name: g.name, run: g.run, skipped: true }); continue; }
    if (!quiet) process.stderr.write(`\n▶ gate ${g.name}: ${g.run}\n`);
    if (logFile) appendFileSync(logFile, `\n▶ gate ${g.name}: ${g.run}\n`);
    const r = await runShell(leaseShell(cfg, kind, g.name, g.run), join(root, g.cwd ?? '.'), { quiet, logFile });
    const pass = r.exitCode === 0;
    red ||= !pass;
    record.gates.push({ name: g.name, run: g.run, exitCode: r.exitCode, durationMs: r.durationMs, pass, ...(pass ? {} : { tail: r.tail }) });
  }
  record.treeAfter = workingTree(root);
  // A gate that edits the tree (formatters, codegen) or a concurrent edit means the
  // verdict describes neither tree. Report that instead of a misleading green.
  record.verdict = record.treeAfter !== record.treeBefore ? 'invalid' : red ? 'red' : 'green';
  record.finishedAt = new Date().toISOString();
  mkdirSync(evidenceDir(root), { recursive: true });
  const file = join(evidenceDir(root), `gate-${record.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  return { record, file };
}

export function listEvidence(root) {
  const dir = evidenceDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith('gate-') && f.endsWith('.json')).sort().reverse()
    .map((f) => ({ file: join(dir, f), ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}

// Is there a full (not partial) green gate run for the tree as it is right now?
export function evidenceFor(root) {
  const tree = workingTree(root);
  const all = listEvidence(root);
  const match = all.find((e) => e.treeAfter === tree && e.verdict === 'green' && !e.partial);
  const latest = all.find((e) => e.treeAfter === tree);
  return { tree, match: match ?? null, latest: latest ?? null };
}
