# Sneaker Arena PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local arena that plays full Battlesnake games between depth-0 Sneaker instances and reports win/loss/tie, death causes, and voluntary-vs-forced head-to-head deaths — the proof of concept the spec requires before search and deployment.

**Architecture:** Pure-function game simulation (`board.js`) shared by the arena and, later, the search. Tail-aware flood fill and Voronoi BFS over a flat `Uint8Array` occupancy grid (`space.js`). A weighted evaluation plus hard filters and a depth-0 chooser (`eval.js`, `weights.js`). The arena (`test/arena.js`) is a seeded game loop over these modules. This plan stops at the arena; `search.js`, `index.js`, and Fly.io deployment are Milestone 2 and get their own plan once PoC numbers are reviewed.

**Tech Stack:** Node 26, ES modules, `node:test` + `node:assert`, `node:util` `parseArgs`. Zero dependencies.

**Spec:** `docs/superpowers/specs/2026-09-10-sneaker-battlesnake-design.md`

## Global Constraints

- Zero npm dependencies. Tests use `node:test` and `node:assert/strict` only.
- ES modules (`"type": "module"` in `package.json`).
- Board coordinates: `(0,0)` bottom-left; `up` = y+1, `down` = y-1, `left` = x-1, `right` = x+1. Dimensions read from state, never hardcoded to 11.
- Flat cell index everywhere: `idx = y * width + x`. No `[x][y]` nested arrays.
- Occupancy grid is a `Uint8Array` named `freeAt`: `0` = empty, `n - i` = body segment `i` of a length-`n` snake vacates at turn `n - i`. Multiple segments on one cell take the max. (Spec says `Int8Array`; `Uint8Array` is used because the max value 121 fits both and unsigned removes a latent edge.)
- Flood fill passability rule: cell at BFS time `t` is passable iff `t >= freeAt[cell]`. The start cell is never checked — callers check legality.
- Flood fill elimination threshold: reachable count `< length - 1` rejects the move.
- Head-to-head hard filter: cells adjacent to the head of any rival whose length is `>=` ours, where a rival adjacent to food counts as one longer.
- Every module in `src/` is platform-agnostic JavaScript. No `node:` imports in `src/`.
- Commit after every task with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Module type, test script. No dependencies. |
| `src/board.js` | State shape, coordinate helpers, `freeAt` grid, one-turn simulation with eliminations. |
| `src/space.js` | Tail-aware flood fill, distance map, Voronoi BFS. Owns its scratch buffers. |
| `src/weights.js` | `WEIGHTS` vectors, `pick(state)` mode selection. |
| `src/eval.js` | `evaluate`, `legalMoves` (hard filters with relaxation levels), `chooseMove` (depth 0). |
| `test/helpers.js` | `mk()` state builder from `[x,y]` literals, `render()` ASCII board. |
| `test/board.test.js` | Simulation rules. |
| `test/space.test.js` | Flood fill and Voronoi. |
| `test/eval.test.js` | Evaluation terms, filters, chooser. |
| `test/arena.js` | Seeded RNG, official-style start positions, food spawning, game loop, stats, CLI. |
| `test/arena.test.js` | Determinism and completion. |

**State shape** (produced by `parse` and `mk`, consumed everywhere):

```js
{
  width, height, turn,
  food:   [idx, ...],
  snakes: [{ id, alive, health, body: [idx, ...] /* body[0] = head */, cause? }, ...],
  you:    index into snakes
}
```

Dead snakes stay in `snakes` (so indices stay stable) with `alive: false` and `cause` set; their bodies are not on the board.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`

**Interfaces:**
- Produces: `npm test` runs every `test/**/*.test.js` via `node --test`.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "sneaker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Verify the test runner finds nothing and exits 0**

Run: `npm test`
Expected: output ends with `# pass 0` / `# fail 0`, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
Scaffold ES module project with node:test runner

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Board basics — coordinates, parse, freeAt grid

**Files:**
- Create: `src/board.js`
- Create: `test/helpers.js`
- Test: `test/board.test.js`

**Interfaces:**
- Produces:
  - `DIRS: ['up','down','left','right']`
  - `idx(state, x, y) → number`
  - `xy(state, i) → [x, y]`
  - `manhattan(state, a, b) → number`
  - `neighbor(state, i, dir) → number` (`-1` when out of bounds)
  - `parse(payload) → state` (Battlesnake `/move` request body → state)
  - `buildFreeAt(state, grid?) → Uint8Array`
  - `mk({ w, h, snakes: [{ body: [[x,y],...], health? }], food: [[x,y]], turn }) → state` (test helper)
  - `render(state) → string` (test helper; heads `A-D`, bodies `a-d`, food `*`)

- [ ] **Step 1: Write the test helper**

```js
// test/helpers.js
import { idx } from '../src/board.js';

export function mk({ w = 11, h = 11, snakes = [], food = [], turn = 0 }) {
  const state = { width: w, height: h, turn, food: [], snakes: [], you: 0 };
  state.food = food.map(([x, y]) => idx(state, x, y));
  state.snakes = snakes.map((s, i) => ({
    id: String(i),
    alive: true,
    health: s.health ?? 100,
    body: s.body.map(([x, y]) => idx(state, x, y)),
  }));
  return state;
}

export function render(state) {
  const rows = [];
  for (let y = state.height - 1; y >= 0; y--) {
    let row = '';
    for (let x = 0; x < state.width; x++) {
      const c = idx(state, x, y);
      let ch = state.food.includes(c) ? '*' : '.';
      state.snakes.forEach((s, i) => {
        if (!s.alive) return;
        const k = s.body.indexOf(c);
        if (k === 0) ch = 'ABCD'[i];
        else if (k > 0) ch = 'abcd'[i];
      });
      row += ch;
    }
    rows.push(row);
  }
  return rows.join('\n');
}
```

- [ ] **Step 2: Write the failing tests**

```js
// test/board.test.js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/board.js'`.

- [ ] **Step 4: Write board.js basics**

```js
// src/board.js
export const DIRS = ['up', 'down', 'left', 'right'];

export function idx(state, x, y) { return y * state.width + x; }
export function xy(state, i) { return [i % state.width, (i / state.width) | 0]; }

export function manhattan(state, a, b) {
  const [ax, ay] = xy(state, a), [bx, by] = xy(state, b);
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function neighbor(state, i, dir) {
  const { width, height } = state;
  const x = i % width, y = (i / width) | 0;
  switch (dir) {
    case 'up':    return y + 1 < height ? i + width : -1;
    case 'down':  return y > 0 ? i - width : -1;
    case 'left':  return x > 0 ? i - 1 : -1;
    case 'right': return x + 1 < width ? i + 1 : -1;
  }
  return -1;
}

export function parse(p) {
  const width = p.board.width, height = p.board.height;
  const ix = c => c.y * width + c.x;
  return {
    width, height, turn: p.turn,
    food: p.board.food.map(ix),
    snakes: p.board.snakes.map(s => ({ id: s.id, alive: true, health: s.health, body: s.body.map(ix) })),
    you: p.board.snakes.findIndex(s => s.id === p.you.id),
  };
}

export function buildFreeAt(state, grid) {
  grid ??= new Uint8Array(state.width * state.height);
  grid.fill(0);
  for (const s of state.snakes) {
    if (!s.alive) continue;
    const n = s.body.length;
    for (let i = 0; i < n; i++) {
      const c = s.body[i], t = n - i;
      if (t > grid[c]) grid[c] = t;
    }
  }
  return grid;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: 7 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/board.js test/helpers.js test/board.test.js
git commit -m "$(cat <<'EOF'
Add board state, coordinate helpers, and tail-aware occupancy grid

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Turn simulation

**Files:**
- Modify: `src/board.js` (append `simulate`)
- Test: `test/board.test.js` (append)

**Interfaces:**
- Produces: `simulate(state, moves) → state` where `moves[i]` is a direction string for snake `i`, or `null` to freeze that snake in place (used by the depth-0 chooser to model static rivals). Dead snakes are ignored regardless. Returned state has `turn + 1`, eaten food removed, and eliminated snakes marked `alive: false` with `cause` ∈ `'starvation' | 'wall' | 'self' | 'body' | 'head'`.

Resolution order (spec §4): move heads and retract tails → health −1 → feed (health 100, tail duplicated, food removed) → phase 1 eliminations (starvation, wall) → phase 2 eliminations among phase-1 survivors (self, body, head-to-head with `<=` losing). Frozen snakes are obstacles: their whole body including the head blocks, and they are never eliminated.

- [ ] **Step 1: Write the failing tests**

Add `simulate` to the existing `import { ... } from '../src/board.js'` line at the top of `test/board.test.js`, then append:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `simulate` is not exported.

- [ ] **Step 3: Implement simulate**

Append to `src/board.js`:

```js
export function simulate(state, moves) {
  const food = new Set(state.food);
  const snakes = state.snakes.map((s, i) => {
    if (!s.alive || moves[i] == null) return s;
    const head = neighbor(state, s.body[0], moves[i]);
    const body = [head, ...s.body.slice(0, -1)];
    let health = s.health - 1;
    if (head >= 0 && food.has(head)) {
      health = 100;
      body.push(body[body.length - 1]);
    }
    return { ...s, body, health };
  });
  for (let i = 0; i < snakes.length; i++) {
    if (snakes[i].alive && moves[i] != null) food.delete(snakes[i].body[0]);
  }

  const cause = new Array(snakes.length).fill(null);
  for (let i = 0; i < snakes.length; i++) {
    const s = snakes[i];
    if (!s.alive || moves[i] == null) continue;
    if (s.health <= 0) cause[i] = 'starvation';
    else if (s.body[0] < 0) cause[i] = 'wall';
  }
  const live = snakes.map((s, i) => s.alive && !cause[i]);
  for (let i = 0; i < snakes.length; i++) {
    if (!live[i] || moves[i] == null) continue;
    const s = snakes[i], head = s.body[0];
    if (s.body.indexOf(head, 1) !== -1) { cause[i] = 'self'; continue; }
    for (let j = 0; j < snakes.length; j++) {
      if (i === j || !live[j]) continue;
      const o = snakes[j];
      if (moves[j] == null) {
        if (o.body.includes(head)) { cause[i] = 'body'; break; }
        continue;
      }
      if (o.body[0] === head) {
        if (s.body.length <= o.body.length) { cause[i] = 'head'; break; }
      } else if (o.body.indexOf(head, 1) !== -1) {
        cause[i] = 'body'; break;
      }
    }
  }

  return {
    ...state,
    turn: state.turn + 1,
    food: [...food],
    snakes: snakes.map((s, i) => (cause[i] ? { ...s, alive: false, cause: cause[i] } : s)),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 23 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/board.js test/board.test.js
git commit -m "$(cat <<'EOF'
Add one-turn simulation with official elimination order

Frozen (null-move) snakes act as static obstacles so the depth-0 chooser
can evaluate its own move without inventing rival moves.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Tail-aware flood fill

**Files:**
- Create: `src/space.js`
- Test: `test/space.test.js`

**Interfaces:**
- Consumes: `buildFreeAt`, state shape from Task 2.
- Produces:
  - `floodFill(state, grid, start, startTime = 0) → number` — count of cells reachable from `start` (inclusive) when the walker is at `start` at time `startTime`.
  - `distances(state, grid, start, startTime = 0) → Int16Array` — the BFS time map (`-1` unreachable). **Returns a shared scratch buffer; read it before calling any other function in this module.**

- [ ] **Step 1: Write the failing tests**

```js
// test/space.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idx, buildFreeAt } from '../src/board.js';
import { floodFill, distances } from '../src/space.js';
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
```

Two tests seed the grid by hand with `99` to make a permanent wall — a real snake's body always vacates eventually, so a genuine dead end needs an obstacle that outlasts the BFS. The 5x5 test shows the flip side: from its own head, a snake eventually reaches every cell of its own body because each segment vacates before the BFS arrives.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/space.js'`.

- [ ] **Step 3: Implement flood fill**

```js
// src/space.js
let N = 0, queue, dist, owner;

function ensure(n) {
  if (n === N) return;
  N = n;
  queue = new Int32Array(n);
  dist = new Int16Array(n);
  owner = new Int8Array(n);
}

// ponytail: single-visit BFS. A cell blocked at its shortest arrival time is never
// retried at a later time, so reachable space is underestimated. Conservative; fine.
function bfs(state, grid, start, startTime) {
  const { width, height } = state;
  ensure(width * height);
  dist.fill(-1);
  let qh = 0, qt = 0, count = 0;
  dist[start] = startTime;
  queue[qt++] = start;
  while (qh < qt) {
    const c = queue[qh++];
    count++;
    const t = dist[c] + 1, x = c % width, y = (c / width) | 0;
    let nb;
    if (y + 1 < height && dist[nb = c + width] === -1 && t >= grid[nb]) { dist[nb] = t; queue[qt++] = nb; }
    if (y > 0          && dist[nb = c - width] === -1 && t >= grid[nb]) { dist[nb] = t; queue[qt++] = nb; }
    if (x > 0          && dist[nb = c - 1]     === -1 && t >= grid[nb]) { dist[nb] = t; queue[qt++] = nb; }
    if (x + 1 < width  && dist[nb = c + 1]     === -1 && t >= grid[nb]) { dist[nb] = t; queue[qt++] = nb; }
  }
  return count;
}

export function floodFill(state, grid, start, startTime = 0) {
  return bfs(state, grid, start, startTime);
}

export function distances(state, grid, start, startTime = 0) {
  bfs(state, grid, start, startTime);
  return dist;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 28 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/space.js test/space.test.js
git commit -m "$(cat <<'EOF'
Add tail-aware flood fill over the occupancy grid

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Voronoi BFS

**Files:**
- Modify: `src/space.js` (append `voronoi`)
- Test: `test/space.test.js` (append)

**Interfaces:**
- Produces: `voronoi(state, grid) → Int32Array` — cells claimed per snake index, excluding the head cells themselves. Distance ties go to the longer snake; equal-length ties are contested and count for nobody; anything tied with a contested cell stays contested.

- [ ] **Step 1: Write the failing tests**

Add `voronoi` to the existing `import { ... } from '../src/space.js'` line at the top of `test/space.test.js`, then append:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `voronoi` is not exported.

- [ ] **Step 3: Implement voronoi**

Append to `src/space.js`:

```js
export function voronoi(state, grid) {
  const { width, height, snakes } = state;
  ensure(width * height);
  dist.fill(-1);
  owner.fill(-2);
  const counts = new Int32Array(snakes.length);
  let qh = 0, qt = 0;
  for (let i = 0; i < snakes.length; i++) {
    if (!snakes[i].alive) continue;
    const h = snakes[i].body[0];
    dist[h] = 0; owner[h] = i; queue[qt++] = h;
  }
  const claim = (nb, o, t) => {
    if (t < grid[nb]) return;
    if (dist[nb] === -1) { dist[nb] = t; owner[nb] = o; queue[qt++] = nb; return; }
    if (dist[nb] !== t || owner[nb] === o) return;
    if (o === -1 || owner[nb] === -1) { owner[nb] = -1; return; }
    const a = snakes[o].body.length, b = snakes[owner[nb]].body.length;
    owner[nb] = a > b ? o : a < b ? owner[nb] : -1;
  };
  while (qh < qt) {
    const c = queue[qh++], o = owner[c], t = dist[c] + 1;
    const x = c % width, y = (c / width) | 0;
    if (y + 1 < height) claim(c + width, o, t);
    if (y > 0)          claim(c - width, o, t);
    if (x > 0)          claim(c - 1, o, t);
    if (x + 1 < width)  claim(c + 1, o, t);
  }
  for (let c = 0; c < N; c++) if (dist[c] > 0 && owner[c] >= 0) counts[owner[c]]++;
  return counts;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 32 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/space.js test/space.test.js
git commit -m "$(cat <<'EOF'
Add multi-source Voronoi BFS with length-resolved ties

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Weights and evaluation

**Files:**
- Create: `src/weights.js`
- Create: `src/eval.js`
- Modify: `docs/superpowers/specs/2026-09-10-sneaker-battlesnake-design.md` (food term correction)
- Test: `test/eval.test.js`

**Interfaces:**
- Consumes: `buildFreeAt`, `manhattan` (Task 2); `floodFill`, `distances`, `voronoi` (Tasks 4–5).
- Produces:
  - `WEIGHTS.ffa`, `WEIGHTS.duel` — objects with keys `space, terr, len, center, choke, food`.
  - `pick(state) → weights` — `duel` when exactly 2 snakes alive, else `ffa`.
  - `HUNGER_MULT = 100`
  - `evaluate(state, you, w) → number` — Sneaker's score for `state` from snake index `you`.

**Spec correction (do this first).** The spec's food term says: when `salud <= d + 2`, return the flat constant `HUNGER_OVERRIDE`. As a leaf evaluation that is inverted: with health 5, a leaf at food distance 4 triggers (5 ≤ 6 → 100) while a leaf at distance 2 does not (5 ≤ 4 → ~0.8), so the search prefers the farther leaf. The fix keeps the constant but multiplies by closeness so nearer always scores higher within the hungry band.

- [ ] **Step 1: Correct the spec**

In `docs/superpowers/specs/2026-09-10-sneaker-battlesnake-design.md`, replace the code block under "### Urgencia de comida":

```
d = distancia BFS a la comida alcanzable más cercana
si no hay comida alcanzable → 0

hambre = salud <= d + 2
si hambre → devuelve HUNGER_OVERRIDE

base = (100 - salud) / 100
crecimiento = nuestra longitud <= longitud del rival más largo ? 0.5 : 0
devuelve (base + crecimiento) * (1 - d / (ancho + alto))
```

with:

```
d = distancia BFS a la comida alcanzable más cercana
si no hay comida alcanzable → 0

cercania = 1 - d / (ancho + alto)
hambre = salud <= d + 2
si hambre → devuelve HUNGER_MULT * cercania

base = (100 - salud) / 100
crecimiento = nuestra longitud <= longitud del rival más largo ? 0.5 : 0
devuelve (base + crecimiento) * cercania
```

Then replace the paragraph starting `**\`HUNGER_OVERRIDE = 100\` es una salvaguarda dura.**` through `...esta relación debe reverificarse.` with:

```
**`HUNGER_MULT = 100` es una salvaguarda dura y monótona.** Si la salud no
alcanza para llegar a la comida más cercana con dos turnos de margen, el
término pasa a `100 × cercanía`. Los demás términos están acotados y sus
pesos suman alrededor de 11 en el vector más cargado, así que a distancias
razonables la comida domina. Y como sigue multiplicando por cercanía, entre
dos hojas hambrientas gana siempre la más cercana a la comida.

Una constante plana en la banda de hambre sería un error: dispararía con más
facilidad cuanto más lejos estuviera la comida (la condición `salud <= d + 2`
se cumple antes con `d` grande), y la búsqueda preferiría la hoja más lejana.
```

Also in the terms table, change the `food` row range from `0..1, o \`HUNGER_OVERRIDE\`` to `0..1.5, o hasta \`HUNGER_MULT\``.

- [ ] **Step 2: Write weights.js**

```js
// src/weights.js
export const WEIGHTS = {
  ffa:  { space: 3.0, terr: 2.0, len: 1.0, center: 0.0, choke: 0.0, food: 1.5 },
  duel: { space: 3.0, terr: 3.5, len: 1.5, center: 0.8, choke: 2.0, food: 1.0 },
};

export function pick(state) {
  let alive = 0;
  for (const s of state.snakes) if (s.alive) alive++;
  return alive === 2 ? WEIGHTS.duel : WEIGHTS.ffa;
}
```

- [ ] **Step 3: Write the failing tests**

```js
// test/eval.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idx, buildFreeAt } from '../src/board.js';
import { floodFill } from '../src/space.js';
import { WEIGHTS, pick } from '../src/weights.js';
import { evaluate, HUNGER_MULT } from '../src/eval.js';
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
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/eval.js'`.

- [ ] **Step 5: Implement evaluate**

```js
// src/eval.js
import { manhattan, buildFreeAt } from './board.js';
import { floodFill, distances, voronoi } from './space.js';

export const HUNGER_MULT = 100;

export function evaluate(state, you, w) {
  const me = state.snakes[you];
  if (!me.alive) return -1e9;
  const head = me.body[0];
  let maxOpp = 0, nearest = -1, nearestD = Infinity;
  for (let i = 0; i < state.snakes.length; i++) {
    const s = state.snakes[i];
    if (i === you || !s.alive) continue;
    if (s.body.length > maxOpp) maxOpp = s.body.length;
    const d = manhattan(state, head, s.body[0]);
    if (d < nearestD) { nearestD = d; nearest = i; }
  }
  if (nearest === -1) return 1e9;

  const { width, height } = state, N = width * height;
  const grid = buildFreeAt(state);
  let free = 0;
  for (let c = 0; c < N; c++) if (grid[c] === 0) free++;

  const dist = distances(state, grid, head, 0);
  let reach = 0, foodD = Infinity;
  for (let c = 0; c < N; c++) if (dist[c] >= 0) reach++;
  for (const f of state.food) if (dist[f] >= 0 && dist[f] < foodD) foodD = dist[f];

  const space = reach / N;
  const terr = w.terr > 0 ? Math.min(1, voronoi(state, grid)[you] / Math.max(1, free)) : 0;
  const len = Math.max(-1, Math.min(1, (me.body.length - maxOpp) / width));
  const cx = (width - 1) >> 1, cy = (height - 1) >> 1;
  const radioMax = (width >> 1) + (height >> 1);
  const center = 1 - manhattan(state, head, cy * width + cx) / radioMax;
  const choke = w.choke > 0 ? 1 - floodFill(state, grid, state.snakes[nearest].body[0], 0) / N : 0;

  let food = 0;
  if (foodD !== Infinity) {
    const closeness = 1 - foodD / (width + height);
    if (me.health <= foodD + 2) food = HUNGER_MULT * closeness;
    else food = ((100 - me.health) / 100 + (me.body.length <= maxOpp ? 0.5 : 0)) * closeness;
  }

  return w.space * space + w.terr * terr + w.len * len + w.center * center + w.choke * choke + w.food * food;
}
```

Order matters inside: `distances` is fully read before `voronoi` overwrites the scratch, and `voronoi`'s result is consumed before `floodFill` runs for `choke`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: 43 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add src/weights.js src/eval.js test/eval.test.js docs/superpowers/specs/2026-09-10-sneaker-battlesnake-design.md
git commit -m "$(cat <<'EOF'
Add weighted evaluation and fix inverted hunger override in the spec

A flat constant inside the hungry band fires more readily the farther the
food is, so a search would prefer the farther leaf. Multiplying by
closeness keeps the dominance and makes nearer always win.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Hard filters and depth-0 chooser

**Files:**
- Modify: `src/eval.js` (append `legalMoves`, `chooseMove`)
- Test: `test/eval.test.js` (append)

**Interfaces:**
- Consumes: `DIRS`, `neighbor`, `simulate` (Tasks 2–3); `floodFill` (Task 4); `evaluate` (Task 6).
- Produces:
  - `legalMoves(state, you, grid, level = 0) → string[]` — directions surviving the hard filters at a relaxation level:
    - `0`: wall, body-not-vacating, head-to-head, flood fill `< length - 1`
    - `1`: drops the flood fill filter
    - `2`: also drops head-to-head
    - `3`: in-bounds only
  - `chooseMove(state, you, w) → { move, level }` — best move by `evaluate` over the first non-empty level; `{ move: 'up', level: 4 }` if even level 3 is empty (only possible on a 1-cell board).

The `level` is reported so the arena can classify a head-to-head death: level ≤ 1 means the filter was active and still let the snake die — a bug. Level ≥ 2 means the snake was forced.

- [ ] **Step 1: Write the failing tests**

Add `legalMoves, chooseMove` to the existing `import { ... } from '../src/eval.js'` line at the top of `test/eval.test.js`, then append:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `legalMoves` is not exported.

- [ ] **Step 3: Implement legalMoves and chooseMove**

Change the import line at the top of `src/eval.js` to:

```js
import { DIRS, neighbor, manhattan, buildFreeAt, simulate } from './board.js';
```

Append:

```js
export function legalMoves(state, you, grid, level = 0) {
  const me = state.snakes[you], head = me.body[0], n = me.body.length;
  const danger = new Set();
  if (level < 2) {
    for (let j = 0; j < state.snakes.length; j++) {
      const o = state.snakes[j];
      if (j === you || !o.alive) continue;
      const oh = o.body[0];
      let olen = o.body.length;
      for (const d of DIRS) {
        const c = neighbor(state, oh, d);
        if (c >= 0 && state.food.includes(c)) { olen++; break; }
      }
      if (olen < n) continue;
      for (const d of DIRS) {
        const c = neighbor(state, oh, d);
        if (c >= 0) danger.add(c);
      }
    }
  }
  const out = [];
  for (const d of DIRS) {
    const c = neighbor(state, head, d);
    if (c < 0) continue;
    if (level < 3 && grid[c] > 1) continue;
    if (danger.has(c)) continue;
    if (level < 1 && floodFill(state, grid, c, 1) < n - 1) continue;
    out.push(d);
  }
  return out;
}

export function chooseMove(state, you, w) {
  const grid = buildFreeAt(state);
  for (let level = 0; level <= 3; level++) {
    const moves = legalMoves(state, you, grid, level);
    if (moves.length === 0) continue;
    let best = moves[0], bestScore = -Infinity;
    for (const m of moves) {
      const next = simulate(state, state.snakes.map((_, i) => (i === you ? m : null)));
      const score = evaluate(next, you, w);
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return { move: best, level };
  }
  return { move: 'up', level: 4 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 51 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/eval.js test/eval.test.js
git commit -m "$(cat <<'EOF'
Add hard filters with relaxation ladder and depth-0 chooser

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Arena

**Files:**
- Create: `test/arena.js`
- Test: `test/arena.test.js`

**Interfaces:**
- Consumes: `simulate`, `idx` (Tasks 2–3); `chooseMove` (Task 7); `WEIGHTS`, `pick` (Task 6).
- Produces:
  - `rng(seed) → () => number` — mulberry32, deterministic.
  - `initial(r, n) → state` — official-style start: `n` snakes of length 3 stacked on shuffled corner/edge points, one food diagonal to each, plus center food.
  - `spawnFood(state, r)` — official rule: spawn if no food, else with probability 0.15, on a random empty cell. Mutates `state.food`.
  - `play(r, labels) → { turns, winner, timeout, causes, mutual, voluntaryHead, forcedHead }` — one game; `labels[i]` ∈ `'auto' | 'ffa' | 'duel'` selects weights for snake `i`.
  - `run({ games, seed, labels }) → summary` — aggregate stats.
  - CLI: `node test/arena.js --games 100 --snakes 2 --seed 1 --a auto --b auto`

Death classification: any snake dying with cause `'head'` while its last move came from level ≤ 1 is a **voluntary** head-to-head death — the filter was active and failed. Level ≥ 2 is **forced**. `mutual` counts turns where two or more snakes died by `'head'` together.

- [ ] **Step 1: Write the failing tests**

```js
// test/arena.test.js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './arena.js'`.

- [ ] **Step 3: Implement the arena**

```js
// test/arena.js
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { simulate, idx } from '../src/board.js';
import { chooseMove } from '../src/eval.js';
import { WEIGHTS, pick } from '../src/weights.js';

export const MAX_TURNS = 500;
const STARTS = [[1, 1], [1, 9], [9, 1], [9, 9], [1, 5], [5, 1], [5, 9], [9, 5]];

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, r) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (r() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function initial(r, n) {
  const state = { width: 11, height: 11, turn: 0, food: [], snakes: [], you: 0 };
  const starts = shuffle([...STARTS], r).slice(0, n);
  state.snakes = starts.map(([x, y], i) => {
    const c = idx(state, x, y);
    return { id: String(i), alive: true, health: 100, body: [c, c, c] };
  });
  const food = new Set();
  for (const [x, y] of starts) {
    const [[fx, fy]] = shuffle([[x + 1, y + 1], [x + 1, y - 1], [x - 1, y + 1], [x - 1, y - 1]], r);
    food.add(idx(state, fx, fy));
  }
  food.add(idx(state, 5, 5));
  state.food = [...food];
  return state;
}

export function spawnFood(state, r) {
  if (state.food.length >= 1 && r() >= 0.15) return;
  const occ = new Set(state.food);
  for (const s of state.snakes) if (s.alive) for (const c of s.body) occ.add(c);
  const empty = [];
  for (let c = 0; c < state.width * state.height; c++) if (!occ.has(c)) empty.push(c);
  if (empty.length) state.food.push(empty[(r() * empty.length) | 0]);
}

const weightsFor = (label, state) => (label === 'auto' ? pick(state) : WEIGHTS[label]);

export function play(r, labels) {
  let state = initial(r, labels.length);
  const level = labels.map(() => 0);
  const dead = labels.map(() => false);
  let mutual = 0, voluntaryHead = 0, forcedHead = 0;

  while (state.turn < MAX_TURNS) {
    let alive = 0;
    for (const s of state.snakes) if (s.alive) alive++;
    if (alive <= 1) break;

    const moves = state.snakes.map((s, i) => {
      if (!s.alive) return null;
      const res = chooseMove(state, i, weightsFor(labels[i], state));
      level[i] = res.level;
      return res.move;
    });
    state = simulate(state, moves);
    spawnFood(state, r);

    const diedByHead = [];
    state.snakes.forEach((s, i) => {
      if (s.alive || dead[i]) return;
      dead[i] = true;
      if (s.cause === 'head') {
        diedByHead.push(i);
        if (level[i] <= 1) voluntaryHead++; else forcedHead++;
      }
    });
    if (diedByHead.length >= 2) mutual++;
  }

  const survivors = [];
  state.snakes.forEach((s, i) => { if (s.alive) survivors.push(i); });
  return {
    turns: state.turn,
    winner: survivors.length === 1 ? survivors[0] : -1,
    timeout: survivors.length > 1,
    causes: state.snakes.map(s => s.cause ?? null),
    mutual, voluntaryHead, forcedHead,
  };
}

export function run({ games, seed, labels }) {
  const r = rng(seed);
  const wins = labels.map(() => 0);
  const causes = {};
  let ties = 0, timeouts = 0, turns = 0, mutual = 0, voluntaryHead = 0, forcedHead = 0;
  for (let g = 0; g < games; g++) {
    const res = play(r, labels);
    turns += res.turns;
    if (res.timeout) timeouts++;
    else if (res.winner < 0) ties++;
    else wins[res.winner]++;
    for (const c of res.causes) if (c) causes[c] = (causes[c] ?? 0) + 1;
    mutual += res.mutual; voluntaryHead += res.voluntaryHead; forcedHead += res.forcedHead;
  }
  return { games, labels, wins, ties, timeouts, avgTurns: turns / games, causes, mutual, voluntaryHead, forcedHead };
}

function report(s) {
  const seats = s.labels.map((l, i) => `${'ABCD'[i]}(${l}) ${s.wins[i]}`).join('   ');
  return [
    `games ${s.games}   snakes ${s.labels.length}`,
    `wins: ${seats}   ties ${s.ties}   timeouts ${s.timeouts}`,
    `avg turns ${s.avgTurns.toFixed(1)}`,
    `deaths: ${Object.entries(s.causes).map(([k, v]) => `${k} ${v}`).join('   ')}`,
    `head-to-head deaths: voluntary ${s.voluntaryHead}   forced ${s.forcedHead}   mutual events ${s.mutual}`,
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      games:  { type: 'string', default: '100' },
      snakes: { type: 'string', default: '2' },
      seed:   { type: 'string', default: '1' },
      a:      { type: 'string', default: 'auto' },
      b:      { type: 'string', default: 'auto' },
    },
  });
  const n = Number(values.snakes);
  const labels = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? values.a : values.b));
  const t0 = performance.now();
  const summary = run({ games: Number(values.games), seed: Number(values.seed), labels });
  console.log(report(summary));
  console.log(`elapsed ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 57 pass, 0 fail.

- [ ] **Step 5: Run the proof of concept**

```bash
node test/arena.js --games 200 --snakes 2 --seed 1
```

```bash
node test/arena.js --games 100 --snakes 4 --seed 1
```

Record both outputs verbatim in the commit message body. Then check against the spec's success criteria:

- `voluntary` head-to-head deaths must be **0**. Any other number is a bug in `legalMoves` or `simulate` — do not proceed to Milestone 2 until it is understood. To debug a specific game, `play(rng(seed), labels)` with the same seed reproduces it exactly; `render(state)` from `test/helpers.js` prints the board.
- `starvation` deaths should be rare (the hungry band exists to prevent them).
- `timeouts` at 500 turns should be 0 or near it; if not, note it — it is the mirror-stagnation risk the spec discusses.

- [ ] **Step 6: Commit**

```bash
git add test/arena.js test/arena.test.js
git commit -m "$(cat <<'EOF'
Add seeded local arena with voluntary-vs-forced head-to-head tracking

<paste both PoC outputs here>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Milestone 2 (separate plan, after PoC review)

Not part of this plan. Listed so the boundary is explicit:

- `src/search.js` — iterative deepening, paranoid alpha-beta, move ordering, proximity filter, `OPPONENT_CAP`, `SEARCH_BUDGET_MS`, per-depth `freeAt` buffer pool.
- Arena: `--depth` option, nodes/second and depth-reached instrumentation, depth-N vs depth-0 comparison.
- `src/index.js` — `node:http` adapter for `/`, `/start`, `/move`, `/end`.
- `fly.toml`, deploy, CLI smoke test against the live URL.
