import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canon, extract, mine } from '../src/mine.mjs';
import { write } from './helpers.mjs';

const cmd = (s) => `{"type":"user","message":"<command-name>/${s}</command-name>"}`;
const tool = (s) => `{"type":"tool_use","name":"Skill","input":{"skill":"${s}"}}`;

test('extract: one slash command per line counts; compaction summaries listing many do not', () => {
  assert.deepEqual(extract(cmd('review')), [{ source: 'user', skill: 'review' }]);
  assert.deepEqual(extract(`${cmd('a')} ${cmd('b')}`), []);
  assert.deepEqual(extract(tool('pr')), [{ source: 'agent', skill: 'pr' }]);
  assert.equal(canon('frontend-design:frontend-design'), 'frontend-design');
  assert.equal(canon('acme-review', 'acme-'), 'review');
});

test('mine counts skills and chains with confidence, splitting on reset skills', () => {
  const root = mkdtempSync(join(tmpdir(), 'hyve-mine-'));
  const session = (...lines) => lines.join('\n') + '\n';
  write(root, {
    '-Users-me-dev-app/s1.jsonl': session(cmd('plan'), tool('acme-review'), cmd('pr')),
    '-Users-me-dev-app/s2.jsonl': session(cmd('plan'), cmd('review'), cmd('clear'), cmd('pr')),
    '-Users-me-dev-other/s3.jsonl': session(cmd('plan'), cmd('review')),
  });
  const r = mine({ root, filter: '-Users-me-dev-app', prefix: 'acme-' });
  assert.equal(r.sessions, 2);
  assert.deepEqual(Object.fromEntries(r.top), { plan: 2, pr: 2, review: 2, clear: 1 });
  const byChain = Object.fromEntries(r.bigrams.map((b) => [b.chain, b]));
  assert.equal(byChain['plan -> review'].count, 2);
  assert.equal(byChain['plan -> review'].confidence, 1);
  assert.equal(byChain['review -> pr'].count, 1, 'clear splits the s2 chain');
  assert.deepEqual(r.trigrams, [['plan -> review -> pr', 1]]);
  assert.equal(mine({ root }).sessions, 3);
});

test('confidence counts only runs of A that were followed by a skill; renamed skills merge', () => {
  const root = mkdtempSync(join(tmpdir(), 'hyve-mine2-'));
  const session = (...lines) => lines.join('\n') + '\n';
  // review runs 4 times: twice followed by pr, twice at the very end of a session.
  write(root, {
    'p/s1.jsonl': session(cmd('review'), cmd('pr')),
    'p/s2.jsonl': session(cmd('review'), cmd('pr')),
    'p/s3.jsonl': session(cmd('review')),
    'p/s4.jsonl': session(tool('bee-review'), cmd('clear')),
    'p/s5.jsonl': session(cmd('old-plan'), cmd('ship')),
  });
  const r = mine({ root, aliases: { 'old-plan': 'plan-tasks' } });
  const c = Object.fromEntries(r.bigrams.map((b) => [b.chain, b.confidence]));
  assert.equal(c['review -> pr'], 1, 'review was followed by something twice, both times pr');
  assert.ok(!('bee-review' in Object.fromEntries(r.top)), 'bee-review merged');
  assert.equal(Object.fromEntries(r.top)['review-change'], 1);
  assert.ok('plan-tasks -> ship' in c, 'project alias applied');
});
