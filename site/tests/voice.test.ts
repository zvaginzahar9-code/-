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

  it('neural voice: the whole answer in one request once it is complete (free-tier friendly)', async () => {
    const played: number[] = [];
    class Ctx {
      state = 'running';
      currentTime = 0;
      destination = {};
      createBuffer(_c: number, n: number) {
        return { duration: n / 24000, getChannelData: () => new Float32Array(n) };
      }
      createBufferSource() {
        return { buffer: null as unknown, connect() {}, start: (at: number) => played.push(at), stop() {}, onended: null };
      }
      resume() {}
    }
    const sent: string[] = [];
    const g = globalThis as Record<string, unknown>;
    g.AudioContext = Ctx;
    g.fetch = async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).text);
      return new Response(new Uint8Array([0, 16, 0, 16]));
    };
    voice.primeAudio();
    const events: string[] = [];
    const s = voice.speakStream({ onStart: () => events.push('start'), onWord: () => {}, onEnd: r => events.push(`end:${r}`) });
    s.push('Нашёл опору П110-2. ');
    s.push('Высота 31 м. Масса 2726 кг.');
    expect(sent).toHaveLength(0); // nothing is spent before the answer is complete
    s.end();
    expect(sent).toEqual(['Нашёл опору П110-2. Высота 31 м. Масса 2726 кг.']);
    await new Promise(r => setTimeout(r, 300));
    expect(played).toHaveLength(1);
    expect(events).toEqual(['start', 'end:finished']);
  });

  it('neural voice failing hands the answer to the browser voice', async () => {
    engine.queue = [];
    engine.spoken = [];
    const g = globalThis as Record<string, unknown>;
    g.fetch = async () => new Response('{}', { status: 503 });
    const events: string[] = [];
    const s = voice.speakStream({ onStart: () => events.push('start'), onWord: () => {}, onEnd: r => events.push(`end:${r}`) });
    s.push('Телефон +7 777 684 60 70. ');
    s.end();
    await new Promise(r => setTimeout(r, 50));
    expect(engine.queue.map(u => u.text)).toEqual(['Телефон +7 777 684 60 70.']);
    engine.playOne();
    expect(events).toEqual(['start', 'end:finished']);
    // for a while after a failure the browser voice is used straight away
    const next = voice.speakStream({ onStart: () => {}, onWord: () => {}, onEnd: () => {} });
    next.push('Ещё. ');
    await tick();
    expect(engine.queue.map(u => u.text)).toEqual(['Ещё.']);
    next.stop();
  });

  it('microphone: a cold "no speech" is restarted quietly instead of "I did not hear you"', async () => {
    const made: any[] = [];
    class Rec {
      lang = ''; continuous = false; interimResults = false; maxAlternatives = 1;
      onaudiostart: any; onspeechend: any; onresult: any; onerror: any; onend: any;
      constructor() { made.push(this); }
      start() {}
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    (globalThis as any).SpeechRecognition = Rec;
    const results: unknown[] = [];
    let starts = 0;
    voice.listen({ onStart: () => starts++, onInterim: () => {}, onSpeechEnd: () => {}, onEnd: r => results.push(r) });
    await tick();
    expect(made).toHaveLength(1);
    // the service wakes up, hears nothing yet and gives up
    made[0].onaudiostart();
    made[0].onerror({ error: 'no-speech' });
    made[0].onend();
    expect(results).toEqual([]); // not reported to the visitor
    expect(made).toHaveLength(2); // listening again
    made[1].onaudiostart();
    expect(starts).toBe(1); // "listening" was shown once
    made[1].onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'покажи П110-2' } }] });
    made[1].onend();
    expect(results).toEqual([{ text: 'покажи П110-2' }]);
  });

  it('microphone: when the visitor presses "done" there is no restart', async () => {
    const made: any[] = [];
    (globalThis as any).SpeechRecognition = class {
      onaudiostart: any; onresult: any; onerror: any; onend: any; onspeechend: any;
      constructor() { made.push(this); }
      start() {}
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    };
    const results: unknown[] = [];
    const l = voice.listen({ onStart: () => {}, onInterim: () => {}, onSpeechEnd: () => {}, onEnd: r => results.push(r) });
    await tick();
    made[0].onaudiostart();
    l.stop();
    expect(made).toHaveLength(1);
    expect(results).toEqual([{ error: 'no-speech' }]);
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
