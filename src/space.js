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
