import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discount } from '../src/discount.js';

test('discount matches itself', () => {
  const expected = discount(80, 0.25);
  assert.equal(discount(80, 0.25), expected);
});
