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
