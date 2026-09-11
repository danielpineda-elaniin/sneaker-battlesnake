import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idx, buildFreeAt } from '../src/board.js';
import { floodFill, distances, voronoi } from '../src/space.js';
import { mk } from './helpers.js';

test('floodFill: empty board from a corner reaches everything', () => {
  const s = mk({ w: 5, h: 5 });
  assert.equal(floodFill(s, buildFreeAt(s), idx(s, 0, 0), 0), 25);
});

test('floodFill: from own head at time 0, own body is reached once it vacates', () => {
  const s = mk({ w: 5, h: 5, snakes: [{ body: [[2, 2], [2, 1], [2, 0]] }] });
  assert.equal(floodFill(s, buildFreeAt(s), idx(s, 2, 2), 0), 25);
});

test('floodFill: tail-aware BFS passes through segments that vacate in time', () => {
  const s = mk({ w: 4, h: 1, snakes: [{ body: [[1, 0], [0, 0]] }] });
  assert.equal(floodFill(s, buildFreeAt(s), idx(s, 2, 0), 1), 4);
});

test('floodFill: a cell that never vacates blocks', () => {
  const s = mk({ w: 4, h: 1, snakes: [{ body: [[1, 0], [0, 0]] }] });
  const g = buildFreeAt(s);
  g[idx(s, 3, 0)] = 99;
  assert.equal(floodFill(s, g, idx(s, 2, 0), 1), 3);
});

test('distances: BFS times respect vacate times, -1 for unreachable', () => {
  const s = mk({ w: 3, h: 3, snakes: [{ body: [[1, 0], [1, 1], [1, 2]] }] });
  const g = buildFreeAt(s);
  g[idx(s, 2, 2)] = 99;
  const d = distances(s, g, idx(s, 0, 0), 0);
  assert.equal(d[idx(s, 0, 0)], 0);
  assert.equal(d[idx(s, 0, 1)], 1);
  assert.equal(d[idx(s, 1, 1)], 2);
  assert.equal(d[idx(s, 1, 2)], 3);
  assert.equal(d[idx(s, 1, 0)], 3);
  assert.equal(d[idx(s, 2, 2)], -1);
});

test('voronoi: symmetric split on an open board', () => {
  const s = mk({ w: 5, h: 1, snakes: [{ body: [[0, 0]] }, { body: [[4, 0]] }] });
  const c = voronoi(s, buildFreeAt(s));
  assert.deepEqual([...c], [1, 1]);
});

test('voronoi: distance tie goes to the longer snake', () => {
  const s = mk({ w: 5, h: 2, snakes: [{ body: [[0, 0], [0, 1]] }, { body: [[4, 0]] }] });
  const c = voronoi(s, buildFreeAt(s));
  assert.deepEqual([...c], [5, 3]);
});

test('voronoi: equal-length tie is contested and propagates', () => {
  const s = mk({ w: 5, h: 2, snakes: [{ body: [[0, 0], [0, 1]] }, { body: [[4, 0], [4, 1]] }] });
  const c = voronoi(s, buildFreeAt(s));
  assert.deepEqual([...c], [3, 3]);
});

test('voronoi: dead snakes claim nothing', () => {
  const s = mk({ w: 5, h: 1, snakes: [{ body: [[0, 0]] }, { body: [[4, 0]] }] });
  s.snakes[1].alive = false;
  const c = voronoi(s, buildFreeAt(s));
  assert.deepEqual([...c], [4, 0]);
});
