// Sandboxed execution for `run` (P2 in docs/landscape-2026-10.md).
//
// The agent loop stays on the host, because the agent needs the user's own login, and
// mounting those credentials into a container is exactly what a sandbox should avoid.
// What moves into the container is CODE EXECUTION:
//   - every task's exit check, and the optional setup step, runs in a container with the
//     task's worktree mounted at /work;
//   - checks get no network; setup (dependency install) may get network if allowed;
//   - only allowlisted environment variables are passed in; no home directory, no
//     credentials, no SSH agent.
// And the agent loses its own shell: sandboxed roles get read/edit tools only, so
// anything the agent writes executes only inside the container, via the exit check.
// OpenHands splits work the same way: the agent loop on the host, its actions in the sandbox.
import { spawnSync } from 'node:child_process';

export const SANDBOX_DEFAULTS = {
  runtime: 'podman',          // or 'docker'
  image: 'node:22-bookworm',
  setup: null,                // e.g. "npm ci"; runs before the first check of each task
  setupNetwork: true,         // dependency installs usually need the registry
  env: ['CI', 'NODE_ENV', 'LANG', 'TZ'],
  memory: '4g',
  cpus: '2',
};

// Tool policy per role when sandboxed. Claude Code takes --allowedTools; other agents
// configure their own argv in run.agent / run.reviewer.
export const SANDBOXED_ROLES = {
  implementer: ['claude', '-p', '{prompt}', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Grep,Glob,Edit,Write'],
  reviewer: ['claude', '-p', '{prompt}', '--allowedTools', 'Read,Grep,Glob'],
};

export function sandboxConfig(cfg, override = null) {
  const s = cfg.run?.sandbox;
  if (!s && !override) return null;
  return { ...SANDBOX_DEFAULTS, ...(s === true ? {} : s ?? {}), ...(override ? { runtime: override } : {}) };
}

// The container argv for one command. Pure, so it can be asserted exactly.
export function containerArgv(sb, dir, command, { network = false, uid = process.getuid?.(), gid = process.getgid?.() } = {}) {
  const argv = [sb.runtime, 'run', '--rm', '--network', network ? 'bridge' : 'none',
    '--memory', sb.memory, '--cpus', String(sb.cpus),
    '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
    '-v', `${dir}:/work`, '-w', '/work'];
  // Files the check writes stay owned by the user, not root.
  if (uid !== undefined && gid !== undefined && sb.runtime === 'docker') argv.push('--user', `${uid}:${gid}`);
  if (sb.runtime === 'podman') argv.push('--userns', 'keep-id');
  for (const name of sb.env) if (process.env[name] !== undefined) argv.push('-e', `${name}=${process.env[name]}`);
  argv.push(sb.image, 'sh', '-c', command);
  return argv;
}

export function runInSandbox(sb, dir, command, timeoutSec, opts = {}) {
  const [cmd, ...args] = containerArgv(sb, dir, command, opts);
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error?.code === 'ENOENT') throw new Error(`sandbox runtime "${sb.runtime}" is not installed (brew install podman, or Docker Desktop)`);
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
}

export function runtimeHealth(sb) {
  const r = spawnSync(sb.runtime, ['info', '--format', '{{.Host.Arch}}'], { encoding: 'utf8', timeout: 20000 });
  if (r.error?.code === 'ENOENT') return { ok: false, detail: `${sb.runtime} is not installed` };
  return r.status === 0 ? { ok: true, detail: `${sb.runtime} ready` } : { ok: false, detail: `${sb.runtime} is installed but not running (${(r.stderr || '').trim().slice(0, 120)})` };
}
