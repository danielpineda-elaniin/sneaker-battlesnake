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
