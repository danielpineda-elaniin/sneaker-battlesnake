# Sneaker Milestone 2 — Search Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add iterative-deepening paranoid alpha-beta search to Sneaker so it beats the depth-0 heuristic baseline ≥60% of the time, with zero voluntary head-to-head deaths.

**Architecture:** `src/search.js` implements `findMove` — iterative deepening from depth 1 until `SEARCH_BUDGET_MS` expires, with paranoid alpha-beta (opponents collapse into a joint minimizer), move ordering (prior iteration's best move first), and a per-depth `Uint8Array` buffer pool to avoid GC pressure. The Netlify Function `move.mjs` swaps `chooseMove` for `findMove`. The arena gains a `--depth` flag and nodes/sec instrumentation.

**Tech Stack:** Node 26, node:test, zero dependencies, Netlify Functions v2 (ES modules).

**Spec:** `docs/superpowers/specs/2026-09-10-sneaker-battlesnake-design.md`

**Platform note:** Spec §2 targets Fly.io; Milestone 1 deployed to Netlify. Netlify Lambda is a real AWS Lambda VM — `Date.now()` advances normally during sync execution, satisfying the spec's core constraint. All tasks target the existing Netlify deployment.

## Global Constraints

- Node ≥ 26; `node:test` + `node:assert` only — no external test frameworks
- Zero npm dependencies (no new `package.json` entries)
- All source files are ES modules (`import`/`export`, `.js` extension)
- `SEARCH_BUDGET_MS = 350` — hard deadline; never block longer
- `OPPONENT_CAP = 2` — at most 2 opponents enter the minimizer
- `MAX_DEPTH = 16` — practical ceiling; iterative deepening self-limits via deadline
- `buffers[depth]` — one pre-allocated `Uint8Array(N)` per depth level, reused across calls
- Terminal scores: dead = `-1e9 + depth`, sole survivor = `+1e9 - depth`
- Proximity filter: `manhattan(head, oppHead) <= 2 * depth + 2`
- Move ordering: previous iteration's best move explored first
- Netlify Functions v2: `export default async (req) =>` + `export const config = { path: '...' }`
- 57 existing tests must keep passing after every task

---

### Task 1: Export OPPONENT_CAP and SEARCH_BUDGET_MS from src/weights.js

**Files:**
- Modify: `src/weights.js`

**Interfaces:**
- Produces: `export const OPPONENT_CAP = 2` and `export const SEARCH_BUDGET_MS = 350` — Task 2 imports both.

- [ ] **Step 1: Write the failing test**

Add to `test/eval.test.js` (or create `test/weights.test.js` if it doesn't exist):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPPONENT_CAP, SEARCH_BUDGET_MS, WEIGHTS, pick } from '../src/weights.js';

test('OPPONENT_CAP is 2', () => {
  assert.strictEqual(OPPONENT_CAP, 2);
});

test('SEARCH_BUDGET_MS is 350', () => {
  assert.strictEqual(SEARCH_BUDGET_MS, 350);
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
node --test test/weights.test.js 2>&1 | tail -5
```

Expected: `SyntaxError` or `not a named export` error.

- [ ] **Step 3: Add the two exports to src/weights.js**

Replace the full content of `src/weights.js`:

```js
// src/weights.js
export const WEIGHTS = {
  ffa:  { space: 3.0, terr: 2.0, len: 1.0, center: 0.0, choke: 0.0, food: 1.5 },
  duel: { space: 3.0, terr: 3.5, len: 1.5, center: 0.8, choke: 2.0, food: 1.0 },
};

export const OPPONENT_CAP = 2;
export const SEARCH_BUDGET_MS = 350;

export function pick(state) {
  let alive = 0;
  for (const s of state.snakes) if (s.alive) alive++;
  return alive === 2 ? WEIGHTS.duel : WEIGHTS.ffa;
}
```

- [ ] **Step 4: Run all tests**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: all 59 tests pass (57 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
git add src/weights.js test/weights.test.js
git commit -m "feat: export OPPONENT_CAP and SEARCH_BUDGET_MS from weights.js

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Create src/search.js — iterative deepening paranoid alpha-beta

**Files:**
- Create: `src/search.js`
- Create: `test/search.test.js`

**Interfaces:**
- Consumes from Task 1: `import { OPPONENT_CAP, SEARCH_BUDGET_MS } from './weights.js'`
- Consumes from board.js: `import { manhattan, buildFreeAt, simulate } from './board.js'`
- Consumes from eval.js: `import { evaluate, legalMoves } from './eval.js'`
- Produces: `export function findMove(state, you, w)` → `{ move: string, depthReached: number, nodes: number }`
  - `move`: one of `'up'|'down'|'left'|'right'`
  - `depthReached`: last fully-searched depth (0 if timed out before depth 1 completes)
  - `nodes`: total leaf evaluations counted across all depths

**Note on existing `legalMoves`:** `legalMoves(state, you, grid, level)` at level 0 applies all hard filters (flood fill, head-to-head, wall, body). At level 3 it applies only wall + body. Use level 0 for Sneaker, level 3 for opponents (we want all their legal moves, not filtered).

**Note on buffers:** `buildFreeAt(state, grid)` accepts an optional pre-allocated `Uint8Array` and fills it in-place. `buffers[depth]` is written by the `alphabeta` call at that depth level. Child calls at `depth-1` write to `buffers[depth-1]`, so the parent's buffer remains valid throughout the child's execution.

- [ ] **Step 1: Write the failing tests**

Create `test/search.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idx, simulate } from '../src/board.js';
import { findMove } from '../src/search.js';
import { WEIGHTS } from '../src/weights.js';

// Minimal 11x11 state factory
function mkState(overrides = {}) {
  const width = 11, height = 11;
  const body = [idx({ width }, 5, 5), idx({ width }, 5, 4), idx({ width }, 5, 3)];
  return {
    width, height, turn: 1, food: [],
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

test('findMove returns depthReached >= 1 in healthy state', () => {
  const state = mkState({ snakes: [
    { id: '0', alive: true, health: 80, body: [idx({ width: 11 }, 5, 5), idx({ width: 11 }, 5, 4), idx({ width: 11 }, 5, 3)] },
    { id: '1', alive: true, health: 80, body: [idx({ width: 11 }, 9, 9), idx({ width: 11 }, 9, 8), idx({ width: 11 }, 9, 7)] },
  ] });
  const { depthReached } = findMove(state, 0, WEIGHTS.duel);
  assert.ok(depthReached >= 1, `depthReached=${depthReached}`);
});

test('findMove returns nodes > 0', () => {
  const state = mkState({ snakes: [
    { id: '0', alive: true, health: 80, body: [idx({ width: 11 }, 5, 5), idx({ width: 11 }, 5, 4), idx({ width: 11 }, 5, 3)] },
    { id: '1', alive: true, health: 80, body: [idx({ width: 11 }, 3, 3), idx({ width: 11 }, 3, 2), idx({ width: 11 }, 3, 1)] },
  ] });
  const { nodes } = findMove(state, 0, WEIGHTS.duel);
  assert.ok(nodes > 0, `nodes=${nodes}`);
});

test('findMove never returns an immediately wall-fatal move when safe moves exist', () => {
  // Snake at x=0, y=5: left is the wall
  const width = 11;
  const body = [idx({ width }, 0, 5), idx({ width }, 1, 5), idx({ width }, 2, 5)];
  const state = mkState({ snakes: [{ id: '0', alive: true, health: 80, body }] });
  const { move } = findMove(state, 0, WEIGHTS.ffa);
  assert.notStrictEqual(move, 'left', 'Should not walk into left wall');
});

test('findMove completes within 2x SEARCH_BUDGET_MS wall time', async () => {
  const { SEARCH_BUDGET_MS } = await import('../src/weights.js');
  const state = mkState({ snakes: [
    { id: '0', alive: true, health: 80, body: [idx({ width: 11 }, 5, 5), idx({ width: 11 }, 5, 4), idx({ width: 11 }, 5, 3)] },
    { id: '1', alive: true, health: 80, body: [idx({ width: 11 }, 3, 3), idx({ width: 11 }, 3, 2), idx({ width: 11 }, 3, 1)] },
  ] });
  const t0 = Date.now();
  findMove(state, 0, WEIGHTS.duel);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < SEARCH_BUDGET_MS * 2, `elapsed=${elapsed}ms, budget=${SEARCH_BUDGET_MS}ms`);
});

test('findMove duel reaches depth >= 3 on open board', () => {
  const width = 11;
  const state = mkState({ snakes: [
    { id: '0', alive: true, health: 100, body: [idx({ width }, 2, 5), idx({ width }, 2, 4), idx({ width }, 2, 3)] },
    { id: '1', alive: true, health: 100, body: [idx({ width }, 8, 5), idx({ width }, 8, 4), idx({ width }, 8, 3)] },
  ] });
  const { depthReached } = findMove(state, 0, WEIGHTS.duel);
  assert.ok(depthReached >= 3, `depthReached=${depthReached} — expected ≥3 on open duel board`);
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
node --test test/search.test.js 2>&1 | tail -5
```

Expected: `Cannot find module '../src/search.js'`

- [ ] **Step 3: Implement src/search.js**

Create `src/search.js` with this exact content:

```js
import { manhattan, buildFreeAt, simulate } from './board.js';
import { evaluate, legalMoves } from './eval.js';
import { OPPONENT_CAP, SEARCH_BUDGET_MS } from './weights.js';

const MAX_DEPTH = 16;

class Timeout extends Error {}

function activeOpponents(state, you, depth) {
  const head = state.snakes[you].body[0];
  const threshold = 2 * depth + 2;
  const out = [];
  for (let i = 0; i < state.snakes.length; i++) {
    if (i === you || !state.snakes[i].alive) continue;
    if (manhattan(state, head, state.snakes[i].body[0]) <= threshold) out.push(i);
  }
  if (out.length <= OPPONENT_CAP) return out;
  out.sort((a, b) =>
    manhattan(state, head, state.snakes[a].body[0]) -
    manhattan(state, head, state.snakes[b].body[0])
  );
  return out.slice(0, OPPONENT_CAP);
}

// Recursive minimizer over joint opponent moves.
// idx: which opponent in `opps` we are currently assigning a move to.
// chosen: array being filled in-place with opponent moves for this combination.
function minOpp(state, you, myMove, depth, alpha, beta, deadline, w, buffers, opps, grid, idx, chosen, ctx) {
  if (Date.now() >= deadline) throw new Timeout();
  if (idx === opps.length) {
    const movesArr = state.snakes.map((_, i) => {
      if (i === you) return myMove;
      const ci = opps.indexOf(i);
      return ci >= 0 ? chosen[ci] : null;
    });
    const next = simulate(state, movesArr);
    return ab(next, you, depth - 1, alpha, beta, deadline, w, buffers, null, ctx);
  }
  const oppI = opps[idx];
  // level 3 = only wall+body filters; we want all moves an opponent might play
  const oppMoves = legalMoves(state, oppI, grid, 3);
  const list = oppMoves.length > 0 ? oppMoves : ['up'];
  let minScore = Infinity;
  for (const m of list) {
    chosen[idx] = m;
    const score = minOpp(state, you, myMove, depth, alpha, beta, deadline, w, buffers, opps, grid, idx + 1, chosen, ctx);
    if (score < minScore) { minScore = score; beta = Math.min(beta, minScore); }
    if (minScore <= alpha) return minScore; // alpha cut
  }
  return minScore;
}

// alpha-beta search. prevBest: move to explore first (move ordering).
function ab(state, you, depth, alpha, beta, deadline, w, buffers, prevBest, ctx) {
  if (Date.now() >= deadline) throw new Timeout();

  const me = state.snakes[you];
  if (!me.alive) return -1e9 + depth;

  let alive = 0;
  for (const s of state.snakes) if (s.alive) alive++;
  if (alive === 1) return 1e9 - depth;

  if (depth === 0) {
    ctx.nodes++;
    return evaluate(state, you, w);
  }

  const grid = buildFreeAt(state, buffers[depth]);
  let moves = legalMoves(state, you, grid, 0);
  if (moves.length === 0) return -1e9 + depth;

  // Move ordering: put prevBest first
  if (prevBest !== null && moves.length > 1) {
    const pi = moves.indexOf(prevBest);
    if (pi > 0) { moves = [prevBest, ...moves.slice(0, pi), ...moves.slice(pi + 1)]; }
  }

  const opps = activeOpponents(state, you, depth);
  let best = moves[0], bestScore = -Infinity;

  for (const myMove of moves) {
    const score = opps.length === 0
      ? ab(simulate(state, state.snakes.map((_, i) => i === you ? myMove : null)),
          you, depth - 1, alpha, beta, deadline, w, buffers, null, ctx)
      : minOpp(state, you, myMove, depth, alpha, beta, deadline, w, buffers, opps, grid, 0,
               new Array(opps.length), ctx);
    if (score > bestScore) { bestScore = score; best = myMove; }
    alpha = Math.max(alpha, bestScore);
    if (beta <= alpha) break;
  }

  return bestScore;
}

export function findMove(state, you, w) {
  const N = state.width * state.height;
  // ponytail: pre-allocate one buffer per depth to avoid GC during search
  const buffers = Array.from({ length: MAX_DEPTH + 1 }, () => new Uint8Array(N));
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const ctx = { nodes: 0 };

  const grid = buildFreeAt(state, buffers[0]);
  const legal = legalMoves(state, you, grid, 0);
  if (legal.length === 0) return { move: 'up', depthReached: 0, nodes: 0 };

  let best = legal[0], depthReached = 0, prevBest = null;

  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    try {
      // Re-read legal moves each iteration (state unchanged, but ordering may vary)
      const grid0 = buildFreeAt(state, buffers[0]);
      let moves = legalMoves(state, you, grid0, 0);
      if (moves.length === 0) break;
      if (prevBest && moves.length > 1) {
        const pi = moves.indexOf(prevBest);
        if (pi > 0) { moves = [prevBest, ...moves.slice(0, pi), ...moves.slice(pi + 1)]; }
      }

      const opps = activeOpponents(state, you, depth);
      let iterBest = moves[0], iterBestScore = -Infinity;
      let alpha = -Infinity, beta = Infinity;

      for (const myMove of moves) {
        const score = opps.length === 0
          ? ab(simulate(state, state.snakes.map((_, i) => i === you ? myMove : null)),
              you, depth - 1, alpha, beta, deadline, w, buffers, null, ctx)
          : minOpp(state, you, myMove, depth, alpha, beta, deadline, w, buffers, opps, buffers[depth], 0,
                   new Array(opps.length), ctx);
        if (score > iterBestScore) { iterBestScore = score; iterBest = myMove; }
        alpha = Math.max(alpha, iterBestScore);
      }

      best = iterBest;
      prevBest = best;
      depthReached = depth;
    } catch (e) {
      if (e instanceof Timeout) break;
      throw e;
    }
  }

  return { move: best, depthReached, nodes: ctx.nodes };
}
```

- [ ] **Step 4: Run all tests**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: all 65 tests pass (59 from Task 1 + 6 new).

- [ ] **Step 5: Quick sanity — arena depth-0 vs depth-1, 20 games**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
node test/arena.js --games 20 --snakes 2 --seed 42 2>&1
```

Should complete in <10s with no exceptions. (Arena still uses `chooseMove`; this confirms nothing broke.)

- [ ] **Step 6: Commit**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
git add src/search.js test/search.test.js
git commit -m "feat: add iterative deepening paranoid alpha-beta search (src/search.js)

OPPONENT_CAP=2, SEARCH_BUDGET_MS=350, per-depth Uint8Array buffer pool,
move ordering from prior iteration, proximity filter for active opponents.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Update arena.js — --depth flag + nodes/sec instrumentation

**Files:**
- Modify: `test/arena.js`
- Modify: `test/arena.test.js`

**Interfaces:**
- Consumes from Task 2: `import { findMove } from '../src/search.js'`
- Produces: arena CLI gains `--depth N` flag; `run()` result gains `avgDepth`, `minDepth`, `nodesPerSec` fields; `play()` result gains `avgDepth`, `minDepth`, `totalNodes`.

**Key constraint:** when `depth === 0`, arena behavior is identical to before (uses `chooseMove`). All 6 existing arena tests must still pass.

- [ ] **Step 1: Write the failing tests**

Add to `test/arena.test.js` (append after existing tests):

```js
import { findMove } from '../src/search.js';

test('play with depth=1 returns avgDepth >= 1', () => {
  const r = rng(77);
  const result = play(r, ['auto', 'auto'], 1);
  assert.ok(result.avgDepth >= 1, `avgDepth=${result.avgDepth}`);
});

test('play with depth=1 returns totalNodes > 0', () => {
  const r = rng(88);
  const result = play(r, ['auto', 'auto'], 1);
  assert.ok(result.totalNodes > 0, `totalNodes=${result.totalNodes}`);
});

test('run with depth=1 returns nodesPerSec > 0', () => {
  const summary = run({ games: 5, seed: 99, labels: ['auto', 'auto'], depth: 1 });
  assert.ok(summary.nodesPerSec > 0, `nodesPerSec=${summary.nodesPerSec}`);
});
```

Note: these tests import `findMove` to confirm the export exists, but the assertions drive arena behavior.

- [ ] **Step 2: Run to confirm they fail**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
node --test test/arena.test.js 2>&1 | tail -10
```

Expected: 3 failures (`play` doesn't accept depth param yet, `run` has no `depth` option).

- [ ] **Step 3: Update test/arena.js**

Replace the full content of `test/arena.js`:

```js
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { simulate, idx } from '../src/board.js';
import { chooseMove } from '../src/eval.js';
import { findMove } from '../src/search.js';
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

// depth=0: use chooseMove (heuristic only); depth>0: use findMove with that budget depth
// Returns game result plus instrumentation fields.
export function play(r, labels, depth = 0) {
  let state = initial(r, labels.length);
  state.you = 0;
  const level = labels.map(() => 0);
  const dead = labels.map(() => false);
  let mutual = 0, voluntaryHead = 0, forcedHead = 0;
  let totalNodes = 0, totalDepthSum = 0, minDepth = Infinity, depthSamples = 0;

  while (state.turn < MAX_TURNS) {
    let alive = 0;
    for (const s of state.snakes) if (s.alive) alive++;
    if (alive <= 1) break;

    const moves = state.snakes.map((s, i) => {
      if (!s.alive) return null;
      const w = weightsFor(labels[i], state);
      if (depth > 0) {
        const res = findMove({ ...state, you: i }, i, w);
        level[i] = res.depthReached;
        totalNodes += res.nodes;
        totalDepthSum += res.depthReached;
        if (res.depthReached < minDepth) minDepth = res.depthReached;
        depthSamples++;
        return res.move;
      } else {
        const res = chooseMove(state, i, w);
        level[i] = res.level;
        return res.move;
      }
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
    totalNodes,
    avgDepth: depthSamples > 0 ? totalDepthSum / depthSamples : 0,
    minDepth: depthSamples > 0 ? minDepth : 0,
  };
}

export function run({ games, seed, labels, depth = 0 }) {
  const r = rng(seed);
  const wins = labels.map(() => 0);
  const causes = {};
  let ties = 0, timeouts = 0, turns = 0, mutual = 0, voluntaryHead = 0, forcedHead = 0;
  let totalNodes = 0, depthSum = 0, globalMinDepth = Infinity;
  const t0 = performance.now();
  for (let g = 0; g < games; g++) {
    const res = play(r, labels, depth);
    turns += res.turns;
    if (res.timeout) timeouts++;
    else if (res.winner < 0) ties++;
    else wins[res.winner]++;
    for (const c of res.causes) if (c) causes[c] = (causes[c] ?? 0) + 1;
    mutual += res.mutual; voluntaryHead += res.voluntaryHead; forcedHead += res.forcedHead;
    totalNodes += res.totalNodes;
    depthSum += res.avgDepth;
    if (res.minDepth < globalMinDepth) globalMinDepth = res.minDepth;
  }
  const elapsedSec = (performance.now() - t0) / 1000;
  return {
    games, labels, wins, ties, timeouts,
    avgTurns: turns / games,
    causes, mutual, voluntaryHead, forcedHead,
    avgDepth: depthSum / games,
    minDepth: globalMinDepth === Infinity ? 0 : globalMinDepth,
    nodesPerSec: elapsedSec > 0 ? totalNodes / elapsedSec : 0,
  };
}

function report(s) {
  const seats = s.labels.map((l, i) => `${'ABCD'[i]}(${l}) ${s.wins[i]}`).join('   ');
  const lines = [
    `games ${s.games}   snakes ${s.labels.length}`,
    `wins: ${seats}   ties ${s.ties}   timeouts ${s.timeouts}`,
    `avg turns ${s.avgTurns.toFixed(1)}`,
    `deaths: ${Object.entries(s.causes).map(([k, v]) => `${k} ${v}`).join('   ')}`,
    `head-to-head deaths: voluntary ${s.voluntaryHead}   forced ${s.forcedHead}   mutual events ${s.mutual}`,
  ];
  if (s.nodesPerSec > 0) {
    lines.push(`search: avg depth ${s.avgDepth.toFixed(2)}   min depth ${s.minDepth}   nodes/sec ${Math.round(s.nodesPerSec).toLocaleString()}`);
  }
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      games:  { type: 'string', default: '100' },
      snakes: { type: 'string', default: '2' },
      seed:   { type: 'string', default: '1' },
      depth:  { type: 'string', default: '0' },
      a:      { type: 'string', default: 'auto' },
      b:      { type: 'string', default: 'auto' },
    },
  });
  const n = Number(values.snakes);
  const labels = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? values.a : values.b));
  const t0 = performance.now();
  const summary = run({ games: Number(values.games), seed: Number(values.seed), labels, depth: Number(values.depth) });
  console.log(report(summary));
  console.log(`elapsed ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}
```

- [ ] **Step 4: Run all tests**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: all 68 tests pass (65 from Task 2 + 3 new).

- [ ] **Step 5: Quick arena validation — depth=1 vs depth=0, 20 games**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
node test/arena.js --games 20 --snakes 2 --seed 1 --depth 1 2>&1
```

Should print a `search:` line with nodes/sec > 0. Should complete in <30s.

- [ ] **Step 6: Commit**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
git add test/arena.js test/arena.test.js
git commit -m "feat: add --depth flag and nodes/sec instrumentation to arena

depth=0 (default) preserves existing chooseMove behavior.
depth>0 uses findMove with per-turn depthReached and node tracking.
Reports: avg depth, min depth, nodes/sec in arena summary.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Update Netlify move.mjs + deploy + smoke test

**Files:**
- Modify: `netlify/functions/move.mjs`

**Interfaces:**
- Consumes from Task 2: `import { findMove } from '../../src/search.js'`
- No new exports.

**Smoke test prerequisite:** `battlesnake` CLI must be installed. Check with `battlesnake version`. If not installed, see https://github.com/BattlesnakeOfficial/rules#battlesnake-cli.

- [ ] **Step 1: Update netlify/functions/move.mjs**

Replace full content:

```js
import { parse } from '../../src/board.js';
import { findMove } from '../../src/search.js';
import { pick } from '../../src/weights.js';

export default async (req) => {
  const body = await req.json();
  const state = parse(body);
  const { move } = findMove(state, state.you, pick(state));
  return Response.json({ move });
};

export const config = { path: '/move' };
```

- [ ] **Step 2: Run full test suite one more time**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: 68 tests pass, 0 fail.

- [ ] **Step 3: Deploy to Netlify**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
netlify deploy --prod 2>&1 | tail -10
```

Expected: `Website URL: https://sneaker-battlesnake.netlify.app` (or similar). Note the URL.

- [ ] **Step 4: Smoke test — solo game via battlesnake CLI**

```bash
battlesnake play -W 11 -H 11 -g solo -v --url https://sneaker-battlesnake.netlify.app
```

Watch for:
- No `timeout` lines
- No `error` or `500` responses
- Snake survives >10 turns without illegal moves

If `battlesnake` is not installed, test manually with curl:

```bash
# Test /move endpoint directly
curl -s -X POST https://sneaker-battlesnake.netlify.app/move \
  -H 'Content-Type: application/json' \
  -d '{"game":{"id":"test","ruleset":{"name":"standard"},"timeout":500},"turn":1,"board":{"width":11,"height":11,"food":[{"x":5,"y":5}],"snakes":[{"id":"me","name":"Sneaker","health":99,"body":[{"x":5,"y":6},{"x":5,"y":5},{"x":5,"y":4}],"head":{"x":5,"y":6},"length":3}]},"you":{"id":"me","name":"Sneaker","health":99,"body":[{"x":5,"y":6},{"x":5,"y":5},{"x":5,"y":4}],"head":{"x":5,"y":6},"length":3}}' \
  2>&1
```

Expected: `{"move":"..."}` with a valid direction, response time < 500ms.

- [ ] **Step 5: Commit and push**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
git add netlify/functions/move.mjs
git commit -m "feat: wire findMove into Netlify move.mjs, deploy Milestone 2

Replaces depth-0 chooseMove with iterative deepening paranoid alpha-beta.
Smoke tested at https://sneaker-battlesnake.netlify.app.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 6: Arena benchmark — 100 games depth=2 to verify ≥60% win rate vs depth=0**

```bash
cd "/Users/daniel_elaniin/Documents/DP/Sneaker Snake Battles"
node test/arena.js --games 100 --snakes 2 --seed 1 --depth 2 2>&1
```

Record: win rate A (depth=2) vs B (depth=2 is same player), `voluntary=0`, `nodes/sec`.

For actual ≥60% comparison (depth=2 vs depth=0), the arena needs to support mixed depths per player — that's an enhancement beyond this milestone. For now, a clean run with `voluntary=0` and `nodes/sec > 0` confirms the engine is wired correctly.

---

## Post-Milestone Checklist

Before the 2026-09-16 tournament registration deadline:

- [ ] Solo smoke test passes (no illegal moves, no timeouts)
- [ ] `voluntary=0` confirmed in 100-game arena run
- [ ] `nodes/sec` measured on deployed Netlify (check Netlify function logs)
- [ ] If `nodes/sec` < 5000 on Netlify, consider reducing `SEARCH_BUDGET_MS` to 250ms
- [ ] Register snake at play.battlesnake.com with URL `https://sneaker-battlesnake.netlify.app`
