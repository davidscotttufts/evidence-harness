// Optional machine-wide CI broker (tracegate-ci, https://github.com/davidscotttufts/tracegate-ci).
//
// When `broker` is configured, every heavy thing hyvemind starts (a gate, a train's
// gate, a sabotage probe, an eval agent run) is wrapped in `<broker> lease`, so it
// waits for the machine to have capacity instead of starving other sessions' gates.
// Without `broker`, commands run directly, as before. hyvemind never depends on it.
import { spawnSync } from 'node:child_process';

export const CLASSES = { gate: 'gate', train: 'train', probe: 'measure', eval: 'agent' };

// Shell command form (gates and probes run through a shell).
export function leaseShell(cfg, kind, label, command) {
  if (!cfg.broker) return command;
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const b = cfg.broker;
  const parts = [b.command ?? 'tracegate', 'lease', '--class', b.classes?.[kind] ?? CLASSES[kind], '--label', q(`hyvemind:${kind}:${label}`), '--quiet'];
  if (b.tokens?.[kind]) parts.push('--tokens', String(b.tokens[kind]));
  return `${parts.join(' ')} -- sh -c ${q(command)}`;
}

// argv form (eval agents run without a shell).
export function leaseArgv(cfg, kind, label, argv) {
  if (!cfg.broker) return argv;
  const b = cfg.broker;
  return [b.command ?? 'tracegate', 'lease', '--class', b.classes?.[kind] ?? CLASSES[kind], '--label', `hyvemind:${kind}:${label}`, '--quiet',
    '--tokens', String(b.tokens?.[kind] ?? 1), '--', ...argv];
}

export function brokerHealth(cfg) {
  if (!cfg.broker) return null;
  const r = spawnSync(cfg.broker.command ?? 'tracegate', ['machine', '--json'], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0 ? { ok: true } : { ok: false, detail: (r.stderr || r.error?.message || 'not reachable').trim().slice(0, 200) };
}
