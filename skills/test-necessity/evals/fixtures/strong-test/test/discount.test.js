import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discount } from '../src/discount.js';

// Guards the pricing rule: rate is a fraction, results round to cents, bad rates throw.
test('applies a fractional rate and rounds to cents', () => {
  assert.equal(discount(80, 0.25), 60);
  assert.equal(discount(19.99, 0.15), 16.99);
  assert.equal(discount(10, 0), 10);
  assert.equal(discount(10, 1), 0);
});

test('rejects rates outside 0..1', () => {
  assert.throws(() => discount(10, -0.1), RangeError);
  assert.throws(() => discount(10, 1.5), RangeError);
});
