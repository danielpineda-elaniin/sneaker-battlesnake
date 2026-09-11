import { createServer } from 'node:http';
import { parse } from './src/board.js';
import { findMove } from './src/search.js';
import { pick } from './src/weights.js';

const PORT = process.env.PORT || 8080;

function json(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });
}

createServer(async (req, res) => {
  const { method, url } = req;
  if (method === 'GET' && url === '/') {
    return json(res, {
      apiversion: '1',
      author: 'danielpineda-elaniin',
      color: '#00C896',
      head: 'sneaky',
      tail: 'bolt',
      version: '2.0.0',
    });
  }
  if (method === 'POST' && url === '/start') {
    res.writeHead(200); res.end('ok'); return;
  }
  if (method === 'POST' && url === '/end') {
    res.writeHead(200); res.end('ok'); return;
  }
  if (method === 'POST' && url === '/move') {
    const body = await readBody(req);
    const state = parse(body);
    const { move } = findMove(state, state.you, pick(state));
    return json(res, { move });
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => console.log(`sneaker listening on ${PORT}`));
