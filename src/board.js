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
