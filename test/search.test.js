import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idx } from '../src/board.js';
import { findMove } from '../src/search.js';
import { WEIGHTS, SEARCH_BUDGET_MS } from '../src/weights.js';

const W = 11;
function i(x, y) { return idx({ width: W }, x, y); }

function mkState(overrides = {}) {
  const body = [i(5, 5), i(5, 4), i(5, 3)];
  return {
    width: W, height: W, turn: 1, food: [],
    snakes: [{ id: '0', alive: true, health: 80, body }],
    you: 0,
    ...overrides,
  };
}

test('findMove returns a valid direction', () => {
  const state = mkState();
  const { move } = findMove(state, 0, WEIGHTS.ffa);
  assert.ok(['up', 'down', 'left', 'right'].includes(move), `got ${move}`);
});

test('findMove returns depthReached >= 1 with two snakes', () => {
  const state = mkState({
    snakes: [
      { id: '0', alive: true, health: 80, body: [i(5, 5), i(5, 4), i(5, 3)] },
      { id: '1', alive: true, health: 80, body: [i(9, 9), i(9, 8), i(9, 7)] },
    ],
  });
  const { depthReached } = findMove(state, 0, WEIGHTS.duel);
  assert.ok(depthReached >= 1, `depthReached=${depthReached}`);
});

test('findMove returns nodes > 0', () => {
  const state = mkState({
    snakes: [
      { id: '0', alive: true, health: 80, body: [i(5, 5), i(5, 4), i(5, 3)] },
      { id: '1', alive: true, health: 80, body: [i(3, 3), i(3, 2), i(3, 1)] },
    ],
  });
  const { nodes } = findMove(state, 0, WEIGHTS.duel);
  assert.ok(nodes > 0, `nodes=${nodes}`);
});

test('findMove does not walk into wall when safe moves exist', () => {
  // Snake at x=0: left is the wall
  const body = [i(0, 5), i(1, 5), i(2, 5)];
  const state = mkState({ snakes: [{ id: '0', alive: true, health: 80, body }] });
  const { move } = findMove(state, 0, WEIGHTS.ffa);
  assert.notStrictEqual(move, 'left', 'should not walk into left wall');
});

test('findMove completes within 2x SEARCH_BUDGET_MS', () => {
  const state = mkState({
    snakes: [
      { id: '0', alive: true, health: 80, body: [i(5, 5), i(5, 4), i(5, 3)] },
      { id: '1', alive: true, health: 80, body: [i(3, 3), i(3, 2), i(3, 1)] },
    ],
  });
  const t0 = Date.now();
  findMove(state, 0, WEIGHTS.duel);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < SEARCH_BUDGET_MS * 2, `elapsed=${elapsed}ms budget=${SEARCH_BUDGET_MS}ms`);
});

test('findMove duel reaches depth >= 3 on open board', () => {
  const state = mkState({
    snakes: [
      { id: '0', alive: true, health: 100, body: [i(2, 5), i(2, 4), i(2, 3)] },
      { id: '1', alive: true, health: 100, body: [i(8, 5), i(8, 4), i(8, 3)] },
    ],
  });
  const { depthReached } = findMove(state, 0, WEIGHTS.duel);
  assert.ok(depthReached >= 3, `depthReached=${depthReached} — expected >=3 on open duel board`);
});
