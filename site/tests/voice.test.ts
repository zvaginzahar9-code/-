import { beforeAll, describe, expect, it } from 'vitest';

/** A fake speech engine: records what is queued and plays each utterance on demand. */
class Utterance {
  voice: unknown;
  lang = '';
  onstart?: () => void;
  onend?: () => void;
  onerror?: (e: { error: string }) => void;
  onboundary?: (e: { name: string; charLength: number }) => void;
  constructor(public text: string) {}
}
const engine = {
  queue: [] as Utterance[],
  spoken: [] as string[],
  speaking: false,
  pending: false,
  getVoices: () => [{ name: 'Microsoft Pavel', lang: 'ru-RU', localService: true }],
  speak(u: Utterance) {
    this.queue.push(u);
  },
  cancel() {
    const q = this.queue.splice(0);
    q.forEach(u => u.onerror?.({ error: 'interrupted' }));
  },
  /** plays the next queued utterance to its end */
  playOne() {
    const u = this.queue.shift();
    if (!u) return false;
    u.onstart?.();
    this.spoken.push(u.text);
    u.onend?.();
    return true;
  },
  addEventListener() {},
  removeEventListener() {},
};

let voice: typeof import('../src/assistant/voice');
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.speechSynthesis = engine;
  g.SpeechSynthesisUtterance = Utterance;
  voice = await import('../src/assistant/voice');
});
const tick = () => new Promise(r => setTimeout(r, 0));

describe('speaking an answer while it is written', () => {
  it('starts with the first finished sentence, before the answer is complete', async () => {
    engine.queue = [];
    engine.spoken = [];
    const events: string[] = [];
    const s = voice.speakStream({ onStart: () => events.push('start'), onWord: () => {}, onEnd: r => events.push(`end:${r}`) });
    await tick(); // the voice is resolved
    s.push('Нашёл опору П110');
    expect(engine.queue).toHaveLength(0); // half a sentence is not said yet
    s.push('-2 на 110 кВ. Высота ');
    expect(engine.queue.map(u => u.text)).toEqual(['Нашёл опору П110-2 на 110 кВ.']);
    engine.playOne();
    expect(events).toEqual(['start']); // speaking while the rest is still streaming
    s.push('31 м.');
    s.end();
    expect(engine.queue.map(u => u.text)).toEqual(['Высота 31 м.']);
    expect(s.active).toBe(true);
    engine.playOne();
    expect(events).toEqual(['start', 'end:finished']);
    expect(engine.spoken).toEqual(['Нашёл опору П110-2 на 110 кВ.', 'Высота 31 м.']);
  });

  it('a withdrawn answer is cut off and only the replacement is said', async () => {
    engine.queue = [];
    engine.spoken = [];
    const events: string[] = [];
    const s = voice.speakStream({ onStart: () => {}, onWord: () => {}, onEnd: r => events.push(`end:${r}`) });
    await tick();
    s.push('Цена опоры 500 000 тенге. Срок ');
    expect(engine.queue).toHaveLength(1);
    s.reset();
    expect(engine.queue).toHaveLength(0);
    expect(events).toEqual([]); // still going: the corrected text follows
    s.push('Цены в каталоге нет — оставьте заявку.');
    s.end();
    engine.playOne();
    expect(engine.spoken).toEqual(['Цены в каталоге нет — оставьте заявку.']);
    expect(events).toEqual(['end:finished']);
  });

  it('text that arrives before the voice is ready is not lost', async () => {
    engine.queue = [];
    engine.spoken = [];
    const s = voice.speakStream({ onStart: () => {}, onWord: () => {}, onEnd: () => {} });
    s.push('Первое предложение. ');
    await tick();
    expect(engine.queue.map(u => u.text)).toEqual(['Первое предложение.']);
    s.stop();
  });
});
