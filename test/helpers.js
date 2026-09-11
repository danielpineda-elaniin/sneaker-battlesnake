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
