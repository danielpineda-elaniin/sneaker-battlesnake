import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIRS, idx, xy, manhattan, neighbor, parse, buildFreeAt } from '../src/board.js';
import { mk } from './helpers.js';

test('idx and xy round-trip', () => {
  const s = mk({ w: 11, h: 11 });
  assert.equal(idx(s, 3, 4), 47);
  assert.deepEqual(xy(s, 47), [3, 4]);
});

test('manhattan distance', () => {
  const s = mk({});
  assert.equal(manhattan(s, idx(s, 0, 0), idx(s, 3, 4)), 7);
});

test('neighbor follows Battlesnake orientation and returns -1 off-board', () => {
  const s = mk({ w: 11, h: 11 });
  const c = idx(s, 5, 5);
  assert.equal(neighbor(s, c, 'up'), idx(s, 5, 6));
  assert.equal(neighbor(s, c, 'down'), idx(s, 5, 4));
  assert.equal(neighbor(s, c, 'left'), idx(s, 4, 5));
  assert.equal(neighbor(s, c, 'right'), idx(s, 6, 5));
  assert.equal(neighbor(s, idx(s, 0, 0), 'left'), -1);
  assert.equal(neighbor(s, idx(s, 0, 0), 'down'), -1);
  assert.equal(neighbor(s, idx(s, 10, 10), 'up'), -1);
  assert.equal(neighbor(s, idx(s, 10, 10), 'right'), -1);
  assert.deepEqual(DIRS, ['up', 'down', 'left', 'right']);
});

test('parse converts the API payload to flat-index state and finds you', () => {
  const payload = {
    turn: 7,
    board: {
      width: 11, height: 11,
      food: [{ x: 5, y: 5 }],
      snakes: [
        { id: 'other', health: 90, body: [{ x: 1, y: 1 }, { x: 1, y: 2 }] },
        { id: 'me', health: 80, body: [{ x: 9, y: 9 }, { x: 9, y: 8 }, { x: 9, y: 7 }] },
      ],
    },
    you: { id: 'me' },
  };
  const s = parse(payload);
  assert.equal(s.width, 11);
  assert.equal(s.turn, 7);
  assert.deepEqual(s.food, [idx(s, 5, 5)]);
  assert.equal(s.you, 1);
  assert.equal(s.snakes[1].health, 80);
  assert.deepEqual(s.snakes[1].body, [idx(s, 9, 9), idx(s, 9, 8), idx(s, 9, 7)]);
  assert.equal(s.snakes[0].alive, true);
});

test('buildFreeAt: tail vacates at 1, head at n, empty is 0', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3]] }] });
  const g = buildFreeAt(s);
  assert.equal(g[idx(s, 5, 5)], 3);
  assert.equal(g[idx(s, 5, 4)], 2);
  assert.equal(g[idx(s, 5, 3)], 1);
  assert.equal(g[idx(s, 0, 0)], 0);
});

test('buildFreeAt: duplicated tail after eating keeps the max vacate time', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3], [5, 3]] }] });
  const g = buildFreeAt(s);
  assert.equal(g[idx(s, 5, 3)], 2);
});

test('buildFreeAt: dead snakes are not on the board', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4]] }] });
  s.snakes[0].alive = false;
  const g = buildFreeAt(s);
  assert.equal(g[idx(s, 5, 5)], 0);
});
