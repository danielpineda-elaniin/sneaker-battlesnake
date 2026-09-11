import { parse } from '../../src/board.js';
import { findMove } from '../../src/search.js';
import { pick } from '../../src/weights.js';

export default async (req) => {
  const body = await req.json();
  const state = parse(body);
  const { move } = findMove(state, state.you, pick(state));
  return Response.json({ move });
};

export const config = { path: '/move' };
