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
