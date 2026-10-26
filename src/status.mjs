// Publish gate evidence as a GitHub commit status, so reviewers see on the PR
// whether the exact commit they are reviewing was gated green.
//
// A commit status attaches to a COMMIT, so evidence can only be posted when the
// evidence tree IS that commit's tree: a clean working tree at HEAD. Evidence for
// uncommitted edits describes no commit and is refused.
import { spawnSync } from 'node:child_process';
import { evidenceFor } from './gate.mjs';
import { git, head } from './git.mjs';

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

export function postStatus(root, { dryRun = false, gh = 'gh' } = {}) {
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
