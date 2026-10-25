import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A throwaway git repo with the given files committed.
export function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hyve-test-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'test@example.com']);
  sh(dir, 'git', ['config', 'user.name', 'Test']);
  sh(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  write(dir, { 'README.md': '# fixture\n', ...files });
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'init']);
  return dir;
}

export function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}
