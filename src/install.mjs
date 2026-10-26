// Install the bundled skills into a project, and keep them updated without
// overwriting anything the project changed or already owned.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { PKG_ROOT, STATE_DIR, pkgVersion } from './config.mjs';

export const BLOCK_BEGIN = '<!-- hyvemind:begin (managed by `hyvemind update`; edit hyvemind.json instead) -->';
export const BLOCK_END = '<!-- hyvemind:end -->';
const SKIP_DIRS = new Set(['evals']);

const sha = (s) => createHash('sha256').update(s).digest('hex');

export function bundledSkills() {
  const dir = join(PKG_ROOT, 'skills');
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, 'SKILL.md'))).sort();
}

export function selectedSkills(cfg) {
  const all = bundledSkills();
  const inc = cfg.skills.include === 'all' ? all : cfg.skills.include;
  const unknown = inc.filter((s) => !all.includes(s));
  if (unknown.length) throw new Error(`skills.include names unknown skills: ${unknown.join(', ')} (available: ${all.join(', ')})`);
  const chosen = inc.filter((s) => !cfg.skills.exclude.includes(s));
  // A defer for a skill that is not installed would silently do nothing: refuse it.
  const defer = Object.keys(cfg.skills.defer ?? {});
  const unknownDefer = defer.filter((s) => !all.includes(s));
  if (unknownDefer.length) throw new Error(`skills.defer names unknown skills: ${unknownDefer.join(', ')} (available: ${all.join(', ')})`);
  const notInstalled = defer.filter((s) => !chosen.includes(s));
  if (notInstalled.length) throw new Error(`skills.defer names skills this project does not install (excluded or not included): ${notInstalled.join(', ')}`);
  return chosen;
}

// The header a deferred skill carries. Agents pick skills by description, so two
// skills for one job need an explicit tie-break: the project's own wins where it applies.
export function deferHeader(local) {
  return [
    `> **Deferred to the project skill \`${local}\`.** When \`${local}\` is installed, follow it`,
    `> instead of this skill. Use this one only where \`${local}\` does not apply.`,
    '',
  ].join('\n');
}

// Inserts the header right after the frontmatter, so name/description stay parseable.
export function withDeferHeader(text, local) {
  const fm = text.match(/^---\n[\s\S]*?\n---\n/);
  return fm ? `${fm[0]}\n${deferHeader(local)}${text.slice(fm[0].length)}` : `${deferHeader(local)}\n${text}`;
}

// Rewrites a bundled skill for this project: its frontmatter name gets the prefix, and
// {{skill:x}} cross-references resolve to the installed names, and {{cli}} to the
// command this project runs the CLI with.
export function render(text, base, prefix, cli = 'npx hyvemind') {
  return text
    .replaceAll('{{cli}}', cli)
    .replace(/^name:\s*.*$/m, `name: ${prefix}${base}`)
    .replace(/\{\{skill:([a-z0-9-]+)\}\}/g, (_, s) => `${prefix}${s}`);
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(e)) out.push(...walk(p)); } else out.push(p);
  }
  return out;
}

export function renderSkill(base, cfg) {
  const src = join(PKG_ROOT, 'skills', base);
  return walk(src).map((abs) => {
    const rel = relative(src, abs);
    const raw = readFileSync(abs);
    const isText = /\.(md|txt|json|mjs|js|sh|ya?ml)$/.test(rel);
    if (!isText) return { rel, content: raw };
    const text = render(raw.toString('utf8'), base, cfg.skills.prefix, cfg.cli);
    // A deferred render is different content, so its hash differs: the manifest then
    // updates untouched copies on (un)deferring and keeps edited ones, as for any change.
    const local = cfg.skills.defer?.[base];
    return { rel, content: local && rel === 'SKILL.md' ? withDeferHeader(text, local) : text };
  });
}

export function readManifest(root) {
  const f = join(root, STATE_DIR, 'manifest.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { version: null, files: {} };
}

function writeManifest(root, m) {
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  writeFileSync(join(root, STATE_DIR, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
}

// Returns a plan of actions; applies it unless dryRun.
// - new file              → write
// - unchanged since last install (hash matches manifest) → overwrite with the new version
// - edited by the project (hash differs from manifest)   → keep, report "modified"
// - existed before hyvemind and not in the manifest   → keep, report "foreign"
export function installSkills(root, cfg, { dryRun = false, force = false } = {}) {
  const manifest = readManifest(root);
  const next = { version: pkgVersion(), files: {} };
  const actions = [];
  for (const base of selectedSkills(cfg)) {
    for (const target of cfg.skills.targets) {
      for (const f of renderSkill(base, cfg)) {
        const rel = join(target, `${cfg.skills.prefix}${base}`, f.rel);
        const abs = join(root, rel);
        const want = sha(f.content);
        let action = 'write';
        if (existsSync(abs)) {
          const have = sha(readFileSync(abs));
          const known = manifest.files[rel];
          if (have === want) action = 'same';
          else if (!known) action = force ? 'write' : 'foreign';
          else if (known !== have) action = force ? 'write' : 'modified';
          else action = 'update';
        }
        actions.push({ rel, action });
        const keep = action === 'modified' || action === 'foreign';
        next.files[rel] = keep ? (manifest.files[rel] ?? null) : want;
        if (!dryRun && (action === 'write' || action === 'update')) {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, f.content);
        }
      }
    }
  }
  // Files hyvemind installed earlier that it no longer produces (a renamed or
  // excluded skill): remove them if untouched, keep and report them if edited.
  for (const [rel, known] of Object.entries(manifest.files)) {
    if (rel in next.files) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const edited = sha(readFileSync(abs)) !== known;
    actions.push({ rel, action: edited ? 'orphan-modified' : 'remove' });
    if (!dryRun && !edited) {
      rmSync(abs);
      let d = dirname(abs);
      while (d.startsWith(root) && d !== root && readdirSync(d).length === 0) { rmSync(d, { recursive: true }); d = dirname(d); }
    }
  }
  if (!dryRun) {
    for (const [k, v] of Object.entries(next.files)) if (v === null) delete next.files[k];
    writeManifest(root, next);
    ensureStateIgnored(root);
  }
  return actions;
}

export function agentsBlock(cfg) {
  const p = cfg.skills.prefix;
  const skills = selectedSkills(cfg);
  const gates = cfg.gates.length ? cfg.gates.map((g) => `\`${g.run}\``).join(' → ') : '_none configured — add `gates` to hyvemind.json_';
  return [
    BLOCK_BEGIN,
    '## Hyvemind',
    '',
    'This project uses [hyvemind](https://github.com/davidscotttufts/hyvemind). Procedures live as',
    `skills (\`${cfg.skills.targets.join('`, `')}\`): ${skills.map((s) => `\`${p}${s}\``).join(', ')}.`,
    '',
    // A project with its own established gate keeps it: hyvemind points at it and
    // claims no second definition of done.
    ...(cfg.externalGate
      ? [
        `- **Gate:** this project's own \`${cfg.externalGate.run}\`. hyvemind does not run or replace it.`,
        `- **Done means:** ${cfg.externalGate.done}. Not when an agent says so.`,
      ]
      : [
        `- **Gate:** ${gates}. Run it with \`${cfg.cli} gate\`; the verdict is bound to the exact working tree.`,
        `- **Done means evidence.** A change is finished when \`${cfg.cli} evidence\` reports a green gate for the current tree — not when an agent says so.`,
      ]),
    // Point only at skills this project actually installs.
    ...[
      skills.includes('open-pr') && `- **Before any PR:** follow \`${p}open-pr\`.`,
      skills.includes('ship-change') && `- **For any feature:** follow \`${p}ship-change\`.`,
      skills.includes('evidence-rules') && `- **Always:** the \`${p}evidence-rules\` apply.`,
    ].filter(Boolean),
    '- Never weaken a gate, delete a failing test, or add a suppression to get green. Fix the cause.',
    BLOCK_END,
  ].join('\n');
}

export function upsertBlock(text, block) {
  const b = text.indexOf(BLOCK_BEGIN.slice(0, 26));
  const e = text.indexOf(BLOCK_END);
  if (b >= 0 && e > b) return text.slice(0, b) + block + text.slice(e + BLOCK_END.length);
  return (text.trimEnd() ? text.trimEnd() + '\n\n' : '') + block + '\n';
}

export function installAgentsMd(root, cfg, { dryRun = false } = {}) {
  const block = agentsBlock(cfg);
  return cfg.agentsMd.paths.map((p) => {
    const abs = join(root, p);
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    const after = upsertBlock(before, block);
    if (!dryRun && after !== before) writeFileSync(abs, after);
    return { rel: p, action: after === before ? 'same' : before ? 'update' : 'write' };
  });
}

// Evidence and eval runs are machine-local; the manifest is committed so updates can
// tell the project's own edits from stale copies.
export function ensureStateIgnored(root) {
  const f = join(root, STATE_DIR, '.gitignore');
  const want = 'evidence/\nevals/\nmine/\ntrain/\nruns/\naffected-ledger.json\n';
  if (!existsSync(f)) { mkdirSync(join(root, STATE_DIR), { recursive: true }); writeFileSync(f, want); return; }
  const have = readFileSync(f, 'utf8');
  for (const line of want.trim().split('\n')) if (!have.split('\n').includes(line)) appendFileSync(f, `${line}\n`);
}
