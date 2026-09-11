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
