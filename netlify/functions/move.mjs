import { parse } from '../../src/board.js';
import { chooseMove } from '../../src/eval.js';
import { pick } from '../../src/weights.js';

export default async (req) => {
  const body = await req.json();
  const state = parse(body);
  const { move } = chooseMove(state, state.you, pick(state));
  return Response.json({ move });
};

export const config = { path: '/move' };
