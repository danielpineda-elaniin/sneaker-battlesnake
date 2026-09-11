// test/eval.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idx, buildFreeAt } from '../src/board.js';
import { floodFill } from '../src/space.js';
import { WEIGHTS, pick } from '../src/weights.js';
import { evaluate, HUNGER_MULT, legalMoves, chooseMove } from '../src/eval.js';
import { mk } from './helpers.js';

const ZERO = { space: 0, terr: 0, len: 0, center: 0, choke: 0, food: 0 };

test('weights: ffa has no choke or center, duel has both', () => {
  assert.equal(WEIGHTS.ffa.choke, 0);
  assert.equal(WEIGHTS.ffa.center, 0);
  assert.ok(WEIGHTS.duel.choke > 0);
  assert.ok(WEIGHTS.duel.center > 0);
});

test('pick: duel with two alive, ffa otherwise', () => {
  const two = mk({ snakes: [{ body: [[1, 1]] }, { body: [[9, 9]] }] });
  const four = mk({ snakes: [{ body: [[1, 1]] }, { body: [[9, 9]] }, { body: [[1, 9]] }, { body: [[9, 1]] }] });
  assert.equal(pick(two), WEIGHTS.duel);
  assert.equal(pick(four), WEIGHTS.ffa);
  four.snakes[2].alive = false; four.snakes[3].alive = false;
  assert.equal(pick(four), WEIGHTS.duel);
});

test('evaluate: dead is -1e9, sole survivor is 1e9', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4]] }, { body: [[0, 0], [0, 1]] }] });
  s.snakes[0].alive = false;
  assert.equal(evaluate(s, 0, WEIGHTS.duel), -1e9);
  const t = mk({ snakes: [{ body: [[5, 5], [5, 4]] }, { body: [[0, 0], [0, 1]] }] });
  t.snakes[1].alive = false;
  assert.equal(evaluate(t, 0, WEIGHTS.duel), 1e9);
});

test('evaluate: space term is reachable fraction', () => {
  const s = mk({ w: 5, h: 5, snakes: [{ body: [[2, 2], [2, 1], [2, 0]] }, { body: [[0, 4], [0, 3]] }] });
  const v = evaluate(s, 0, { ...ZERO, space: 1 });
  const expected = floodFill(s, buildFreeAt(s), idx(s, 2, 2), 0) / 25;
  assert.ok(Math.abs(v - expected) < 1e-9);
});

test('evaluate: center term is 1 at center, 0 at corner', () => {
  const mid = mk({ snakes: [{ body: [[5, 5], [5, 4]] }, { body: [[0, 10], [0, 9]] }] });
  const cor = mk({ snakes: [{ body: [[0, 0], [0, 1]] }, { body: [[0, 10], [0, 9]] }] });
  assert.ok(Math.abs(evaluate(mid, 0, { ...ZERO, center: 1 }) - 1) < 1e-9);
  assert.ok(Math.abs(evaluate(cor, 0, { ...ZERO, center: 1 }) - 0) < 1e-9);
});

test('evaluate: len term is clamped length advantage over the longest rival', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3], [5, 2]] }, { body: [[0, 0], [0, 1]] }] });
  assert.ok(Math.abs(evaluate(s, 0, { ...ZERO, len: 1 }) - 2 / 11) < 1e-9);
});

test('evaluate: hungry band dominates and is monotone in distance', () => {
  const near = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3]], health: 4 }, { body: [[0, 0], [0, 1], [0, 2]] }], food: [[5, 7]] });
  const far  = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3]], health: 4 }, { body: [[0, 0], [0, 1], [0, 2]] }], food: [[5, 9]] });
  const vNear = evaluate(near, 0, { ...ZERO, food: 1 });
  const vFar  = evaluate(far, 0, { ...ZERO, food: 1 });
  assert.ok(vNear > 50, `near hungry should be large, got ${vNear}`);
  assert.ok(vFar  > 50, `far hungry should be large, got ${vFar}`);
  assert.ok(vNear > vFar, 'closer food must score higher inside the hungry band');
  assert.ok(Math.abs(vNear - HUNGER_MULT * (1 - 2 / 22)) < 1e-9);
});

test('evaluate: not hungry gives a small food term', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3]], health: 90 }, { body: [[0, 0], [0, 1], [0, 2]] }], food: [[5, 7]] });
  const v = evaluate(s, 0, { ...ZERO, food: 1 });
  assert.ok(v > 0 && v < 2, `got ${v}`);
});

test('evaluate: growth bonus applies while not strictly longest', () => {
  const shorter = mk({ snakes: [{ body: [[5, 5], [5, 4]], health: 90 }, { body: [[0, 0], [0, 1], [0, 2]] }], food: [[5, 7]] });
  const longer  = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3], [5, 2]], health: 90 }, { body: [[0, 0], [0, 1], [0, 2]] }], food: [[5, 7]] });
  assert.ok(evaluate(shorter, 0, { ...ZERO, food: 1 }) > evaluate(longer, 0, { ...ZERO, food: 1 }));
});

test('evaluate: no reachable food gives zero food term', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3]], health: 5 }, { body: [[0, 0], [0, 1], [0, 2]] }] });
  assert.equal(evaluate(s, 0, { ...ZERO, food: 1 }), 0);
});

test('evaluate: choke rewards a boxed-in rival and is skipped at weight 0', () => {
  const open = mk({ snakes: [
    { body: [[9, 9], [9, 8], [9, 7]] },
    { body: [[0, 0], [0, 1], [0, 2]] },
  ] });
  const boxed = mk({ snakes: [
    { body: [[9, 9], [9, 8], [9, 7]] },
    { body: [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [0, 1], [0, 2], [1, 2], [2, 2], [3, 2], [3, 1], [3, 0], [4, 0]] },
  ] });
  const vOpen = evaluate(open, 0, { ...ZERO, choke: 1 });
  const vBoxed = evaluate(boxed, 0, { ...ZERO, choke: 1 });
  assert.ok(vBoxed > vOpen + 0.5, `boxed ${vBoxed} should beat open ${vOpen}`);
  assert.ok(Math.abs(vBoxed - (1 - 1 / 121)) < 1e-9);
  assert.equal(evaluate(boxed, 0, ZERO), 0);
});

test('legalMoves: wall and own body are removed', () => {
  const s = mk({ snakes: [{ body: [[0, 0], [1, 0], [2, 0]] }, { body: [[9, 9], [9, 8]] }] });
  assert.deepEqual(legalMoves(s, 0, buildFreeAt(s)), ['up']);
});

test('legalMoves: moving onto a vacating tail is allowed', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [4, 4], [4, 5]] }, { body: [[9, 9], [9, 8]] }] });
  assert.ok(legalMoves(s, 0, buildFreeAt(s)).includes('left'));
});

test('legalMoves: head-to-head cells of an equal-or-longer rival are removed', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3]] }, { body: [[7, 5], [8, 5], [9, 5]] }] });
  const moves = legalMoves(s, 0, buildFreeAt(s));
  assert.deepEqual(moves, ['up', 'left']);
});

test('legalMoves: head-to-head cells of a shorter rival are allowed', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3]] }, { body: [[7, 5], [8, 5]] }] });
  assert.ok(legalMoves(s, 0, buildFreeAt(s)).includes('right'));
});

test('legalMoves: a shorter rival adjacent to food counts as one longer', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3]] }, { body: [[7, 5], [8, 5]] }], food: [[7, 6]] });
  assert.ok(!legalMoves(s, 0, buildFreeAt(s)).includes('right'));
});

test('legalMoves: relaxation ladder', () => {
  const opp = [];
  for (let y = 10; y >= 0; y--) opp.push([1, y]);
  for (let x = 2; x <= 10; x++) opp.push([x, 0]);
  const s = mk({ snakes: [{ body: [[0, 1], [0, 2], [0, 3]] }, { body: opp }] });
  const g = buildFreeAt(s);
  assert.deepEqual(legalMoves(s, 0, g, 0), []);
  assert.deepEqual(legalMoves(s, 0, g, 1), ['down']);
  assert.deepEqual(legalMoves(s, 0, g, 2), ['down']);
  assert.deepEqual(legalMoves(s, 0, g, 3), ['up', 'down', 'right']);
});

test('chooseMove: reports the level it had to fall back to', () => {
  const opp = [];
  for (let y = 10; y >= 0; y--) opp.push([1, y]);
  for (let x = 2; x <= 10; x++) opp.push([x, 0]);
  const s = mk({ snakes: [{ body: [[0, 1], [0, 2], [0, 3]] }, { body: opp }] });
  assert.deepEqual(chooseMove(s, 0, WEIGHTS.duel), { move: 'down', level: 1 });
});

test('chooseMove: hungry snake heads for the food', () => {
  const s = mk({
    snakes: [
      { body: [[5, 5], [5, 4], [4, 4], [4, 5]], health: 5 },
      { body: [[5, 0], [4, 0], [3, 0]] },
    ],
    food: [[5, 8]],
  });
  assert.deepEqual(chooseMove(s, 0, WEIGHTS.duel), { move: 'up', level: 0 });
});
