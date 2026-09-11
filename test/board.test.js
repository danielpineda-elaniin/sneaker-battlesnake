import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIRS, idx, xy, manhattan, neighbor, parse, buildFreeAt, simulate } from '../src/board.js';
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

const alive = s => s.snakes.map(x => x.alive);
const causes = s => s.snakes.map(x => x.cause ?? null);

test('simulate: tail retracts and health drops by one', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3]], health: 50 }, { body: [[0, 0], [0, 1]] }] });
  const n = simulate(s, ['up', 'right']);
  assert.deepEqual(n.snakes[0].body, [idx(s, 5, 6), idx(s, 5, 5), idx(s, 5, 4)]);
  assert.equal(n.snakes[0].health, 49);
  assert.equal(n.turn, 1);
});

test('simulate: eating restores health, duplicates tail, removes food', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3]], health: 50 }, { body: [[0, 0], [0, 1]] }], food: [[5, 6]] });
  const n = simulate(s, ['up', 'right']);
  assert.equal(n.snakes[0].health, 100);
  assert.deepEqual(n.snakes[0].body, [idx(s, 5, 6), idx(s, 5, 5), idx(s, 5, 4), idx(s, 5, 4)]);
  assert.deepEqual(n.food, []);
});

test('simulate: starvation', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4]], health: 1 }, { body: [[0, 0], [0, 1]] }] });
  const n = simulate(s, ['up', 'right']);
  assert.deepEqual(causes(n), ['starvation', null]);
});

test('simulate: eating on the last health point survives', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4]], health: 1 }, { body: [[0, 0], [0, 1]] }], food: [[5, 6]] });
  const n = simulate(s, ['up', 'right']);
  assert.deepEqual(alive(n), [true, true]);
});

test('simulate: wall', () => {
  const s = mk({ snakes: [{ body: [[0, 0], [0, 1]] }, { body: [[5, 5], [5, 4]] }] });
  const n = simulate(s, ['left', 'up']);
  assert.deepEqual(causes(n), ['wall', null]);
});

test('simulate: self collision', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [4, 4], [4, 5], [4, 6]] }, { body: [[0, 0], [0, 1]] }] });
  const n = simulate(s, ['left', 'right']);
  assert.deepEqual(causes(n), ['self', null]);
});

test('simulate: moving into a vacating tail is legal', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [4, 4], [4, 5]] }, { body: [[0, 0], [0, 1]] }] });
  const n = simulate(s, ['left', 'right']);
  assert.deepEqual(alive(n), [true, true]);
});

test('simulate: moving into a tail that just ate is a collision', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [4, 4], [4, 5], [4, 5]] }, { body: [[0, 0], [0, 1]] }] });
  const n = simulate(s, ['left', 'right']);
  assert.deepEqual(causes(n), ['self', null]);
});

test('simulate: body collision with another snake', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4]] }, { body: [[6, 7], [6, 6], [6, 5], [6, 4]] }] });
  const n = simulate(s, ['right', 'up']);
  assert.deepEqual(causes(n), ['body', null]);
});

test('simulate: head-to-head, shorter dies', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4]] }, { body: [[7, 5], [8, 5], [9, 5]] }] });
  const n = simulate(s, ['right', 'left']);
  assert.deepEqual(causes(n), ['head', null]);
});

test('simulate: head-to-head, equal length both die', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4], [5, 3]] }, { body: [[7, 5], [8, 5], [9, 5]] }] });
  const n = simulate(s, ['right', 'left']);
  assert.deepEqual(causes(n), ['head', 'head']);
});

test('simulate: head-to-head length counts growth from eating this turn', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4]] }, { body: [[7, 5], [8, 5]] }], food: [[6, 5]] });
  const n = simulate(s, ['right', 'left']);
  assert.deepEqual(causes(n), ['head', 'head']);
});

test('simulate: a snake eliminated in phase 1 is not an obstacle in phase 2', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4]], health: 1 }, { body: [[7, 5], [8, 5]] }] });
  const n = simulate(s, ['right', 'left']);
  assert.deepEqual(causes(n), ['starvation', null]);
});

test('simulate: two snakes eating the same food both grow', () => {
  const s = mk({ snakes: [{ body: [[4, 5], [3, 5]] }, { body: [[6, 5], [7, 5]] }], food: [[5, 5]] });
  const n = simulate(s, ['right', 'left']);
  assert.equal(n.snakes[0].body.length, 3);
  assert.equal(n.snakes[1].body.length, 3);
  assert.deepEqual(causes(n), ['head', 'head']);
});

test('simulate: frozen snake (null move) is an obstacle, keeps health, never dies', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4]], health: 42 }, { body: [[6, 5], [7, 5], [8, 5]], health: 1 }] });
  const n = simulate(s, ['right', null]);
  assert.deepEqual(causes(n), ['body', null]);
  assert.equal(n.snakes[1].health, 1);
  assert.deepEqual(n.snakes[1].body, s.snakes[1].body);
});

test('simulate: dead snakes are skipped', () => {
  const s = mk({ snakes: [{ body: [[5, 5], [5, 4]] }, { body: [[0, 0], [0, 1]] }] });
  s.snakes[1].alive = false;
  const n = simulate(s, ['up', 'up']);
  assert.deepEqual(alive(n), [true, false]);
});
