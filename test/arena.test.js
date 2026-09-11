import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rng, initial, spawnFood, play, run, MAX_TURNS } from './arena.js';

test('rng: same seed, same sequence', () => {
  const a = rng(7), b = rng(7);
  assert.equal(a(), b());
  assert.equal(a(), b());
  assert.ok(a() >= 0 && a() < 1);
});

test('initial: n stacked snakes, one food each plus center, no overlaps', () => {
  const s = initial(rng(1), 4);
  assert.equal(s.snakes.length, 4);
  for (const sn of s.snakes) {
    assert.equal(sn.body.length, 3);
    assert.equal(sn.body[0], sn.body[1]);
    assert.equal(sn.body[1], sn.body[2]);
  }
  const heads = new Set(s.snakes.map(sn => sn.body[0]));
  assert.equal(heads.size, 4);
  assert.equal(s.food.length, 5);
  assert.equal(new Set(s.food).size, 5);
  for (const f of s.food) assert.ok(!heads.has(f));
});

test('spawnFood: always spawns when board has no food', () => {
  const s = initial(rng(1), 2);
  s.food = [];
  spawnFood(s, rng(1));
  assert.equal(s.food.length, 1);
});

test('play: a two-snake game ends with a winner, a tie, or a timeout', () => {
  const res = play(rng(3), ['auto', 'auto']);
  assert.ok(res.turns > 0 && res.turns <= MAX_TURNS);
  assert.ok(res.winner === 0 || res.winner === 1 || res.winner === -1);
  assert.equal(res.causes.length, 2);
});

test('play: same seed reproduces the same game', () => {
  const a = play(rng(11), ['auto', 'auto']);
  const b = play(rng(11), ['auto', 'auto']);
  assert.deepEqual(a, b);
});

test('run: aggregates across games and labels', () => {
  const sum = run({ games: 3, seed: 5, labels: ['ffa', 'duel'] });
  assert.equal(sum.games, 3);
  assert.equal(sum.wins.length, 2);
  assert.equal(sum.wins[0] + sum.wins[1] + sum.ties + sum.timeouts, 3);
});
