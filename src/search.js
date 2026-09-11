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
// Enumerates all combinations of moves for opponents in `opps[idx..]`,
// filling `chosen` in-place, and returns the min score over all combinations.
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
  // level 3: only wall+body filters — we want all moves an opponent might play
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

// Alpha-beta search from Sneaker's perspective.
// prevBest: move to explore first for move ordering.
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

  // Move ordering: explore prevBest first
  if (prevBest !== null && moves.length > 1) {
    const pi = moves.indexOf(prevBest);
    if (pi > 0) { moves = [prevBest, ...moves.slice(0, pi), ...moves.slice(pi + 1)]; }
  }

  const opps = activeOpponents(state, you, depth);
  let bestScore = -Infinity;

  for (const myMove of moves) {
    const score = opps.length === 0
      ? ab(
          simulate(state, state.snakes.map((_, i) => i === you ? myMove : null)),
          you, depth - 1, alpha, beta, deadline, w, buffers, null, ctx
        )
      : minOpp(state, you, myMove, depth, alpha, beta, deadline, w, buffers, opps, grid, 0,
               new Array(opps.length), ctx);
    if (score > bestScore) bestScore = score;
    alpha = Math.max(alpha, bestScore);
    if (beta <= alpha) break;
  }

  return bestScore;
}

export function findMove(state, you, w) {
  const N = state.width * state.height;
  // ponytail: pre-allocate one Uint8Array per depth to avoid GC during search
  const buffers = Array.from({ length: MAX_DEPTH + 1 }, () => new Uint8Array(N));
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const ctx = { nodes: 0 };

  const grid0 = buildFreeAt(state, buffers[0]);
  const legal = legalMoves(state, you, grid0, 0);
  if (legal.length === 0) return { move: 'up', depthReached: 0, nodes: 0 };

  let best = legal[0], depthReached = 0, prevBest = null;

  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    try {
      // Rebuild grid and legal moves for this iteration (state unchanged)
      const g = buildFreeAt(state, buffers[0]);
      let moves = legalMoves(state, you, g, 0);
      if (moves.length === 0) break;

      // Move ordering: put prevBest first
      if (prevBest && moves.length > 1) {
        const pi = moves.indexOf(prevBest);
        if (pi > 0) { moves = [prevBest, ...moves.slice(0, pi), ...moves.slice(pi + 1)]; }
      }

      const opps = activeOpponents(state, you, depth);
      let iterBest = moves[0], iterBestScore = -Infinity;
      let alpha = -Infinity, beta = Infinity;

      for (const myMove of moves) {
        const score = opps.length === 0
          ? ab(
              simulate(state, state.snakes.map((_, i) => i === you ? myMove : null)),
              you, depth - 1, alpha, beta, deadline, w, buffers, null, ctx
            )
          : minOpp(state, you, myMove, depth, alpha, beta, deadline, w, buffers, opps,
                   buffers[depth], 0, new Array(opps.length), ctx);
        if (score > iterBestScore) { iterBestScore = score; iterBest = myMove; }
        alpha = Math.max(alpha, iterBestScore);
        if (Date.now() >= deadline) throw new Timeout();
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
