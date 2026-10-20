import { handleTts } from './tts.ts';

/** Vercel Function entry: the assistant's neural voice (see tts.ts). */
export default {
  fetch: (request: Request) => handleTts(request),
};
