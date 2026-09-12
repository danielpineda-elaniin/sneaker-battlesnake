import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPPONENT_CAP, SEARCH_BUDGET_MS, WEIGHTS, pick } from '../src/weights.js';

test('OPPONENT_CAP is 2', () => {
  assert.strictEqual(OPPONENT_CAP, 2);
});

test('SEARCH_BUDGET_MS is 350', () => {
  assert.strictEqual(SEARCH_BUDGET_MS, 350);
});
