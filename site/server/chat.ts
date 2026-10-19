import { handle } from './handler.ts';

/** Vercel Function entry: the assistant's only endpoint (see _lib/handler.ts). */
export default {
  fetch: (request: Request) => handle(request),
};
