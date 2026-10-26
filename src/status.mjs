// Publish gate evidence as a GitHub commit status, so reviewers see on the PR
// whether the exact commit they are reviewing was gated green.
//
// A commit status attaches to a COMMIT, so evidence can only be posted when the
// evidence tree IS that commit's tree: a clean working tree at HEAD. Evidence for
// uncommitted edits describes no commit and is refused.
//
// A project whose own gate already posts a commit status (evidence.status) has its
// definition of done; hyvemind reads that status as the proof and posts nothing of
// its own, so there is never a second, possibly disagreeing, "done" on the PR.
import { spawnSync } from 'node:child_process';
import { evidenceFor } from './gate.mjs';
import { git, head, workingTree } from './git.mjs';

export const CONTEXT = 'hyvemind/gate';

export function repoSlug(root) {
  const url = git(root, ['remote', 'get-url', 'origin']).out;
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin is not a GitHub remote (${url || 'none'})`);
  return `${m[1]}/${m[2]}`;
}

// Pure: what status this evidence justifies. Never "success" without a full green run
// on exactly this commit's tree.
export function statusFor({ tree, match, latest }, commitTree) {
  if (tree !== commitTree) {
    return { refuse: 'the working tree differs from HEAD (uncommitted changes); evidence describes no commit. Commit, then gate.' };
  }
  if (match) {
    const secs = Math.round(match.gates.reduce((s, g) => s + (g.durationMs ?? 0), 0) / 1000);
    return { state: 'success', description: `green on tree ${tree.slice(0, 12)} · ${match.gates.map((g) => g.name).join(', ')} · ${secs}s` };
  }
  if (latest && latest.verdict === 'red') {
    const failed = latest.gates.filter((g) => g.pass === false).map((g) => g.name).join(', ');
    return { state: 'failure', description: `red on tree ${tree.slice(0, 12)} · failed: ${failed}` };
  }
  if (latest && latest.verdict === 'invalid') {
    return { state: 'error', description: `invalid: the tree changed while the gate ran` };
  }
  return { refuse: latest?.partial ? 'only a partial (--only) run exists for this tree; run the full gate' : 'no gate has run on this tree; run "hyvemind gate"' };
}

// Latest status for `context` on `sha`. The statuses endpoint lists every post (a
// re-run adds one), so the latest by created_at is the current verdict. One page of
// 100 is newest-first, which covers any realistic number of re-posts.
function latestStatus(root, slug, sha, context, gh) {
  const r = spawnSync(gh, ['api', `repos/${slug}/commits/${sha}/statuses?per_page=100`], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh api could not read the statuses of ${sha.slice(0, 12)}: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  const all = JSON.parse(r.stdout || '[]').filter((s) => s.context === context);
  return all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null;
}

// Proof from the project's own gate: a `success` status with context evidence.status
// on HEAD, and only while the working tree IS HEAD. A status describes a commit, so
// uncommitted edits are never covered by it, however green it is.
export function externalEvidence(root, cfg, { gh = 'gh' } = {}) {
  const context = cfg.evidence.status;
  const base = { ok: false, source: 'external', context };
  const sha = head(root);
  if (!sha) return { ...base, reason: 'no commit yet; a commit status needs a commit' };
  const tree = workingTree(root);
  if (tree !== git(root, ['rev-parse', 'HEAD^{tree}']).out) {
    return { ...base, sha, tree, reason: `the working tree differs from HEAD (uncommitted changes); "${context}" describes HEAD ${sha.slice(0, 12)}, not these files. Commit, then run the project's gate` };
  }
  const slug = repoSlug(root);
  const status = latestStatus(root, slug, sha, context, gh);
  const how = cfg.externalGate ? ` (${cfg.externalGate.run})` : '';
  if (!status) return { ...base, sha, tree, slug, reason: `no "${context}" status on HEAD ${sha.slice(0, 12)}; run the project's gate${how}` };
  if (status.state !== 'success') {
    return { ...base, sha, tree, slug, status, reason: `"${context}" is ${status.state} on HEAD ${sha.slice(0, 12)}${status.description ? `: ${status.description}` : ''}` };
  }
  return { ...base, ok: true, sha, tree, slug, status };
}

// One answer to "is the current tree done?", naming where the proof came from.
export function checkEvidence(root, cfg, opts = {}) {
  if (cfg?.evidence?.status) {
    const e = externalEvidence(root, cfg, opts);
    const s = e.status;
    return {
      ...e,
      message: e.ok
        ? `green · proof: commit status "${e.context}" = success on HEAD ${e.sha.slice(0, 12)} (${s.created_at}${s.description ? ` · ${s.description}` : ''}${s.target_url ? ` · ${s.target_url}` : ''}) · posted by the project's own gate (evidence.status); local gate records are not consulted`
        : `not proven · proof source: commit status "${e.context}" (evidence.status) · ${e.reason}`,
    };
  }
  const { tree, match, latest } = evidenceFor(root);
  if (match) return { ok: true, source: 'local', tree, match, message: `green · proof: local gate record · tree ${tree.slice(0, 12)} · ${match.finishedAt} · ${match.file}` };
  return {
    ok: false, source: 'local', tree, latest,
    message: latest
      ? `no green evidence for tree ${tree.slice(0, 12)}; latest run on it was ${latest.verdict}${latest.partial ? ' (partial)' : ''}`
      : `no gate has run on tree ${tree.slice(0, 12)}; run "hyvemind gate"`,
  };
}

export function postStatus(root, { dryRun = false, gh = 'gh', cfg = null } = {}) {
  // The project's gate posts the status that means done; a hyvemind/gate beside it
  // would be a second definition of done that can disagree with the first.
  if (cfg?.evidence?.status) {
    let external;
    try { external = checkEvidence(root, cfg, { gh }); } catch (e) { external = { ok: false, message: `could not read "${cfg.evidence.status}": ${e.message}` }; }
    return { posted: false, deferred: true, context: cfg.evidence.status, external };
  }
  const sha = head(root);
  if (!sha) throw new Error('no commit to post a status on');
  const commitTree = git(root, ['rev-parse', 'HEAD^{tree}']).out;
  const s = statusFor(evidenceFor(root), commitTree);
  if (s.refuse) return { posted: false, reason: s.refuse };
  const slug = repoSlug(root);
  const args = ['api', '-X', 'POST', `repos/${slug}/statuses/${sha}`,
    '-f', `state=${s.state}`, '-f', `context=${CONTEXT}`, '-f', `description=${s.description.slice(0, 140)}`];
  if (dryRun) return { posted: false, dryRun: true, sha, slug, ...s, command: [gh, ...args] };
  const r = spawnSync(gh, args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh api failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return { posted: true, sha, slug, ...s };
}
