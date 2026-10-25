// Pick a preset and starter gates from what the project already has.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function detect(root) {
  const pkg = readJson(join(root, 'package.json'));
  const scripts = pkg?.scripts ?? {};

  // The openwop host family (openwop-app and its white-label forks: kicktodo, bookai, …).
  if (scripts.ci && existsSync(join(root, 'backend/typescript')) && existsSync(join(root, 'frontend/react'))) {
    return { preset: 'openwop', reason: 'root "ci" script + backend/typescript + frontend/react', overrides: {} };
  }

  if (pkg) {
    const order = ['lint', 'typecheck', 'test', 'build'];
    const gates = order.filter((s) => scripts[s]).map((s) => ({ name: s, run: `npm run ${s}` }));
    const overrides = gates.length ? { gates } : {};
    if (existsSync(join(root, 'node_modules/vitest')) || /vitest/.test(scripts.test ?? '')) {
      overrides.probe = { command: 'npx vitest run {test}' };
    }
    return { preset: 'node', reason: `package.json with scripts: ${gates.map((g) => g.name).join(', ') || 'none'}`, overrides };
  }

  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.py'))) {
    return { preset: 'python', reason: 'pyproject.toml / setup.py', overrides: {} };
  }

  return { preset: 'generic', reason: 'no recognised build file — add gates by hand', overrides: {} };
}
