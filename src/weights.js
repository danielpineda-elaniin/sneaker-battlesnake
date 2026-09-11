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
