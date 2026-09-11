// src/eval.js
import { DIRS, neighbor, manhattan, buildFreeAt, simulate } from './board.js';
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
  const me = state.snakes[you];

  // When critically hungry, reward any leaf where the snake eats.
  // evaluate() sees post-simulate state where food is already consumed (foodD=Infinity → food=0),
  // so without this bonus the hungry-band term vanishes on the eat-leaf and the snake circles.
  let eatBonus = 0;
  if (state.food.length > 0) {
    const d = distances(state, grid, me.body[0], 0);
    let minD = Infinity;
    for (const f of state.food) if (d[f] >= 0 && d[f] < minD) minD = d[f];
    if (minD !== Infinity && me.health <= minD + 2)
      eatBonus = HUNGER_MULT * (1 - minD / (state.width + state.height));
  }

  for (let level = 0; level <= 3; level++) {
    const moves = legalMoves(state, you, grid, level);
    if (moves.length === 0) continue;
    let best = moves[0], bestScore = -Infinity;
    for (const m of moves) {
      const next = simulate(state, state.snakes.map((_, i) => (i === you ? m : null)));
      let score = evaluate(next, you, w);
      if (eatBonus > 0 && next.snakes[you].alive && next.snakes[you].health > me.health)
        score += eatBonus;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return { move: best, level };
  }
  return { move: 'up', level: 4 };
}
