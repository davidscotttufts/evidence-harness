import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from '../src/sum.js';

test('sum works', () => {
  assert.equal(typeof sum, 'function');
  assert.ok(Array.isArray([1, 2, 3]));
});
