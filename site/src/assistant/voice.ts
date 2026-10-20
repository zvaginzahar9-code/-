import { toPlain } from './markdown';

/**
 * Voice services. Recognition is the browser's own (Web Speech API); the visitor's audio never
 * reaches this site's server. Answers are read by a neural voice (Gemini TTS through /api/tts,
 * the text only — see server/tts.ts), and by the browser's own speech synthesis when the neural
 * voice is unavailable. Everything is feature-detected, and every failure is reported.
 */

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onaudiostart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

const recognitionCtor = (): RecognitionCtor | null => {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

const audioCtor = (): typeof AudioContext | null =>
  (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
  (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
  null;

export const voiceSupport = () => ({
  listen: recognitionCtor() !== null,
  speak: ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) || audioCtor() !== null,
});

export type ListenError = 'denied' | 'no-mic' | 'no-speech' | 'network' | 'unsupported' | 'failed';

export const LISTEN_MESSAGES: Record<ListenError, string> = {
  denied: 'Доступ к микрофону запрещён. Разрешите его в настройках браузера для этого сайта или продолжайте текстом.',
  'no-mic': 'Микрофон не найден. Подключите его или продолжайте текстом.',
  'no-speech': 'Ничего не расслышал. Нажмите на микрофон и повторите.',
  network: 'Сервис распознавания речи браузера недоступен. Продолжайте текстом.',
  unsupported: 'Этот браузер не умеет распознавать речь. Продолжайте текстом.',
  failed: 'Не удалось распознать речь. Попробуйте ещё раз или продолжайте текстом.',
};

const mapError = (code: string): ListenError | null =>
  code === 'not-allowed' || code === 'service-not-allowed'
    ? 'denied'
    : code === 'audio-capture'
      ? 'no-mic'
      : code === 'no-speech'
        ? 'no-speech'
        : code === 'network'
          ? 'network'
          : code === 'language-not-supported'
            ? 'unsupported'
            : code === 'aborted'
              ? null
              : 'failed';

/** recognition is stopped after this long without a single recognised word */
const SILENCE_MS = 12_000;

export interface ListenHandlers {
  /** audio capture really started */
  onStart(analyser: AnalyserNode | null): void;
  onInterim(text: string): void;
  onSpeechEnd(): void;
  /** recognition is over: the final transcript ('' when nothing was recognised) or an error */
  onEnd(result: { text: string } | { error: ListenError }): void;
}

export interface Listener {
  /** finish and use what was heard */
  stop(): void;
  /** discard */
  cancel(): void;
}

/**
 * A second capture of the same microphone feeds the waveform. Mobile browsers generally
 * cannot share the microphone with recognition, so there the waveform is simply absent.
 */
const canAnalyse = () => !!navigator.mediaDevices?.getUserMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

export function listen(h: ListenHandlers): Listener {
  const Ctor = recognitionCtor();
  let stream: MediaStream | null = null;
  let audio: AudioContext | null = null;
  let rec: Recognition | null = null;
  let finalText = '';
  let error: ListenError | null = null;
  let cancelled = false;
  let stopped = false;
  let ended = false;
  let silence = 0;
  // a recognition service that never answers must not leave the microphone open
  const armSilence = () => {
    clearTimeout(silence);
    silence = window.setTimeout(() => {
      error ??= 'no-speech';
      try {
        rec?.abort();
      } catch {
        /* already stopped */
      }
      end(finalText.trim() ? { text: finalText.trim() } : { error: error ?? 'no-speech' });
    }, SILENCE_MS);
  };

  const release = () => {
    clearTimeout(silence);
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    void audio?.close().catch(() => {});
    audio = null;
  };
  const end = (result: { text: string } | { error: ListenError }) => {
    if (ended) return;
    ended = true;
    release();
    h.onEnd(result);
  };

  if (!Ctor) {
    queueMicrotask(() => end({ error: 'unsupported' }));
    return { stop() {}, cancel() {} };
  }

  (async () => {
    let analyser: AnalyserNode | null = null;
    // anything unexpected below ends the session cleanly instead of leaving the microphone open
    if (canAnalyse()) {
      try {
        // no processing on this second capture: its automatic gain control can turn the shared
        // microphone down for recognition too, which made the first attempts "deaf"
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        if (cancelled) return release();
        audio = new AudioContext();
        analyser = audio.createAnalyser();
        analyser.fftSize = 1024;
        audio.createMediaStreamSource(stream).connect(analyser);
      } catch (e) {
        const name = (e as DOMException)?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') return end({ error: 'denied' });
        if (name === 'NotFoundError' || name === 'OverconstrainedError') return end({ error: 'no-mic' });
        // the waveform is unavailable; recognition may still work
        release();
        analyser = null;
      }
    }
    if (cancelled) return release();
    const opened = Date.now();
    let announced = false;
    let heard = false;
    // The recognition service often wakes up slowly: the first session may end with "no speech"
    // before the visitor has said a word. Within the listening window such a session is quietly
    // started again instead of answering "I did not hear you".
    const startRec = () => {
      const r = new Ctor();
      rec = r;
      r.lang = 'ru-RU';
      r.continuous = false;
      r.interimResults = true;
      r.maxAlternatives = 1;
      r.onaudiostart = () => {
        if (announced) return;
        announced = true;
        armSilence();
        h.onStart(analyser);
      };
      r.onspeechend = () => {
        if (heard) h.onSpeechEnd();
      };
      r.onresult = e => {
        armSilence();
        heard = true;
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const x = e.results[i];
          if (x.isFinal) finalText += x[0].transcript;
          else interim += x[0].transcript;
        }
        h.onInterim((finalText + interim).trim());
      };
      r.onerror = e => {
        error = mapError(e.error) ?? error;
      };
      r.onend = () => {
        if (rec !== r) return;
        if (cancelled) return end({ text: '' });
        const text = finalText.trim();
        if (text) return end({ text });
        const quiet = error === null || error === 'no-speech';
        if (quiet && !stopped && Date.now() - opened < SILENCE_MS - 1500) {
          error = null;
          try {
            return startRec();
          } catch {
            /* fall through to the result below */
          }
        }
        end(error ? { error } : { error: 'no-speech' });
      };
      r.start();
    };
    try {
      startRec();
    } catch {
      end({ error: 'failed' });
    }
  })();

  return {
    stop() {
      stopped = true; // the visitor is done: no quiet restart after this
      try {
        rec?.stop();
      } catch {
        end({ error: 'failed' });
      }
      if (!rec) {
        cancelled = true;
        end({ text: '' });
      }
    },
    cancel() {
      cancelled = true;
      try {
        rec?.abort();
      } catch {
        /* already stopped */
      }
      end({ text: '' });
    },
  };
}

/** Resolves with a Russian voice, or null when the browser has none. */
function russianVoice(): Promise<SpeechSynthesisVoice | null> {
  const pick = () => {
    const voices = speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith('ru'));
    // the assistant speaks with a male voice when the system has one (browsers do not report
    // gender, so this goes by the names the common platforms give their Russian male voices)
    const isMale = (v: SpeechSynthesisVoice) => /pavel|павел|dmitr|дмитр|yuri|юри|maxim|максим|aleks|алекс|ivan|иван|artem|артём|male|муж/i.test(v.name) && !/female|жен/i.test(v.name);
    // neural voices sound far more natural than the old system ones: Edge "… Online (Natural)",
    // then Chrome's "Google русский", then the system voices
    const natural = voices.filter(v => /natural|online|neural/i.test(v.name));
    const google = voices.filter(v => /google/i.test(v.name));
    return natural.find(isMale) ?? natural[0] ?? google[0] ?? voices.find(isMale) ?? voices.find(v => v.localService) ?? voices[0] ?? null;
  };
  const now = pick();
  if (now || speechSynthesis.getVoices().length) return Promise.resolve(now);
  // some browsers fill the list asynchronously
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      speechSynthesis.removeEventListener('voiceschanged', done);
      resolve(pick());
    };
    const timer = setTimeout(done, 4000); // a busy machine can take seconds to list its voices
    speechSynthesis.addEventListener('voiceschanged', done);
  });
}

export interface SpeakHandlers {
  /** playback really started */
  onStart(): void;
  /** the engine reported a word boundary; `length` is the word's length in characters */
  onWord(length: number): void;
  /** playback is over */
  onEnd(reason: 'finished' | 'stopped' | 'no-voice' | 'failed'): void;
}

let speaking: { stop(): void } | null = null;

/** Speaks `text` in Russian. Long text is queued sentence by sentence (engines cut off long utterances). */
export function speak(text: string, h: SpeakHandlers): { stop(): void } {
  speaking?.stop();
  let over = false;
  let watchdog = 0;
  const finish = (reason: Parameters<SpeakHandlers['onEnd']>[0]) => {
    if (over) return;
    over = true;
    clearInterval(watchdog);
    // whatever is still queued must not keep talking after playback is reported over
    if (reason !== 'finished') speechSynthesis.cancel();
    if (speaking === handle) speaking = null;
    h.onEnd(reason);
  };
  const handle = {
    stop() {
      if (over) return;
      finish('stopped');
    },
  };
  speaking = handle;

  void russianVoice().then(voice => {
    if (over) return;
    if (!voice) return finish('no-voice');
    const parts = toPlain(text).match(/[^.!?…\n]+[.!?…]*\s*/g)?.map(s => s.trim()).filter(Boolean) ?? [];
    if (!parts.length) return finish('finished');
    speechSynthesis.cancel();
    let started = false;
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      u.voice = voice;
      u.lang = voice.lang;
      u.onstart = () => {
        if (over || started) return;
        started = true;
        h.onStart();
      };
      u.onboundary = e => {
        if (!over && e.name === 'word') h.onWord(e.charLength || 5);
      };
      u.onerror = e => finish(e.error === 'interrupted' || e.error === 'canceled' ? 'stopped' : 'failed');
      if (i === parts.length - 1) u.onend = () => finish('finished');
      speechSynthesis.speak(u);
    });
    // some engines never fire `end`: stop showing playback once the queue is actually empty
    const queued = Date.now();
    watchdog = window.setInterval(() => {
      if (speechSynthesis.speaking || speechSynthesis.pending) return;
      if (started) finish('finished');
      else if (Date.now() - queued > 3000) finish('failed');
    }, 700);
  });
  return handle;
}

export const stopSpeaking = () => speaking?.stop();

export interface SpeechStream {
  /** a new piece of the answer as it streams in */
  push(text: string): void;
  /** the answer was withdrawn by the server: drop what is queued and what is being said */
  reset(): void;
  /** no more text will come: say the rest, then report the end */
  end(): void;
  stop(): void;
  readonly active: boolean;
}

/**
 * Speaks an answer while it is still being written: every finished sentence is queued for the
 * speech engine at once, so the voice starts with the first sentence instead of after the whole
 * answer. `onEnd` fires only after `end()` and the last queued sentence.
 */
function browserStream(h: SpeakHandlers): SpeechStream {
  speaking?.stop();
  let over = false;
  let ended = false;
  let started = false;
  let generation = 0;
  let buffer = '';
  let inFlight = 0;
  let voice: SpeechSynthesisVoice | null | undefined;
  let endedAt = 0;
  const waiting: string[] = [];
  let watchdog = 0;

  const finish = (reason: Parameters<SpeakHandlers['onEnd']>[0]) => {
    if (over) return;
    over = true;
    clearInterval(watchdog);
    if (reason !== 'finished') speechSynthesis.cancel();
    if (speaking === stream) speaking = null;
    h.onEnd(reason);
  };
  const check = () => {
    if (!over && ended && inFlight === 0 && !waiting.length && !buffer.trim()) finish('finished');
  };
  const utter = (part: string) => {
    const gen = generation;
    const u = new SpeechSynthesisUtterance(part);
    u.voice = voice!;
    u.lang = voice!.lang;
    inFlight++;
    u.onstart = () => {
      if (over || gen !== generation || started) return;
      started = true;
      h.onStart();
    };
    u.onboundary = e => {
      if (!over && gen === generation && e.name === 'word') h.onWord(e.charLength || 5);
    };
    const done = () => {
      if (gen !== generation) return; // cancelled by reset(): already accounted for
      inFlight = Math.max(0, inFlight - 1);
      check();
    };
    u.onend = done;
    u.onerror = e => {
      if (gen !== generation) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return done();
      finish('failed');
    };
    speechSynthesis.speak(u);
  };
  const enqueue = (raw: string) => {
    const part = toPlain(raw).trim();
    if (!part) return;
    if (voice === undefined) waiting.push(part);
    else if (voice) utter(part);
  };
  // whole sentences are spoken as soon as they are complete; the tail waits for more text
  const flush = (all: boolean) => {
    while (true) {
      const m = buffer.match(/^[\s\S]*?[.!?…:;](?=\s)|^[\s\S]*?\n/);
      if (!m || (m[0].trim().length < 2 && !all)) break;
      enqueue(m[0]);
      buffer = buffer.slice(m[0].length);
    }
    if (all) {
      enqueue(buffer);
      buffer = '';
    }
  };

  const stream: SpeechStream = {
    push(text) {
      if (over) return;
      buffer += text;
      flush(false);
    },
    reset() {
      if (over) return;
      generation++;
      inFlight = 0;
      waiting.length = 0;
      buffer = '';
      speechSynthesis.cancel();
    },
    end() {
      if (over || ended) return;
      ended = true;
      endedAt = Date.now();
      flush(true);
      check();
    },
    stop() {
      finish('stopped');
    },
    get active() {
      return !over;
    },
  };
  speaking = stream;

  void russianVoice().then(v => {
    if (over) return;
    if (!v) return finish('no-voice');
    voice = v;
    speechSynthesis.cancel();
    waiting.splice(0).forEach(utter);
    check();
  });
  // some engines never fire `end`: once everything is said and the queue is empty, it is over
  watchdog = window.setInterval(() => {
    if (!ended || speechSynthesis.speaking || speechSynthesis.pending) return;
    if (started) finish('finished');
    else if (voice && Date.now() - endedAt > 3000) finish(inFlight ? 'failed' : 'finished');
  }, 700);
  return stream;
}

/* ───────────── neural voice (Gemini TTS through /api/tts) ───────────── */

const SAMPLE_RATE = 24_000;
let audio: AudioContext | null = null;
/** the neural voice failed (no key, quota, outage): use the browser voice until then */
let neuralDownUntil = 0;

/** Creates/resumes the audio output. Browsers allow it only inside a user gesture: call it on a click. */
export function primeAudio() {
  const Ctor = audioCtor();
  if (!Ctor) return;
  try {
    if (!audio) {
      try {
        audio = new Ctor({ sampleRate: SAMPLE_RATE });
      } catch {
        audio = new Ctor(); // buffers at 24 kHz are resampled by the browser
      }
    }
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    audio = null;
  }
}

/**
 * Reads an answer with the neural voice. The whole answer goes in one request as soon as it is
 * complete (the text streams in about a second, the free tier allows few requests a minute);
 * the audio is played as it streams back. Any failure hands the answer to the browser voice.
 */
function neuralStream(h: SpeakHandlers): SpeechStream {
  speaking?.stop();
  const ctx = audio!;
  let over = false;
  let ended = false;
  let started = false;
  let generation = 0;
  let buffer = ''; // text not yet sent
  let sentFirst = false;
  let chain: Promise<void> = Promise.resolve(); // requests are played strictly in order
  let pendingRequests = 0;
  let playUntil = 0; // when the last scheduled sound ends (audio clock)
  const sources = new Set<AudioBufferSourceNode>();
  const timers = new Set<number>();
  const fetches = new Set<AbortController>();
  let fallback: SpeechStream | null = null;
  let endTimer = 0;

  const later = (ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, Math.max(0, ms));
    timers.add(id);
  };
  const silence = () => {
    fetches.forEach(a => a.abort());
    fetches.clear();
    sources.forEach(s => {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    });
    sources.clear();
    timers.forEach(id => clearTimeout(id));
    timers.clear();
    clearTimeout(endTimer);
  };
  const finish = (reason: Parameters<SpeakHandlers['onEnd']>[0]) => {
    if (over) return;
    over = true;
    silence();
    if (speaking === stream) speaking = null;
    h.onEnd(reason);
  };
  const checkEnd = () => {
    if (over || fallback || !ended || pendingRequests || buffer.trim()) return;
    clearTimeout(endTimer);
    endTimer = window.setTimeout(() => finish('finished'), Math.max(0, (playUntil - ctx.currentTime) * 1000) + 120);
  };

  // the rest of the answer goes to the browser voice; its end is this stream's end
  const handOver = (text: string) => {
    if (over || fallback) return;
    silence();
    if (!('speechSynthesis' in window)) return finish('failed');
    speaking = null; // the browser voice must not stop this stream when it starts
    fallback = browserStream({
      onStart: () => {
        if (!started) {
          started = true;
          h.onStart();
        }
      },
      onWord: h.onWord,
      onEnd: reason => {
        if (speaking === fallback) speaking = stream;
        finish(reason);
      },
    });
    speaking = stream;
    fallback.push(text + buffer);
    buffer = '';
    if (ended) fallback.end();
  };

  const play = (pcm: Int16Array, gen: number) => {
    if (over || gen !== generation || !pcm.length) return;
    const buf = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      ch[i] = pcm[i] / 32768;
      sum += ch[i] * ch[i];
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, playUntil);
    src.start(at);
    sources.add(src);
    src.onended = () => sources.delete(src);
    playUntil = at + buf.duration;
    const delay = (at - ctx.currentTime) * 1000;
    if (!started) {
      started = true;
      later(delay, () => !over && h.onStart());
    }
    // the wire moves with the loudness of what is being said
    const rms = Math.sqrt(sum / pcm.length);
    later(delay, () => !over && gen === generation && h.onWord(Math.min(14, 3 + rms * 60)));
  };

  const request = (text: string) => {
    const gen = generation;
    const part = toPlain(text).trim();
    if (!part) return;
    pendingRequests++;
    const ctrl = new AbortController();
    fetches.add(ctrl);
    // fetch at once, play after everything sent earlier
    const response = fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: part }), signal: ctrl.signal });
    const previous = chain;
    chain = (async () => {
      let ok = false;
      let status = 0;
      try {
        const res = await response;
        await previous;
        if (over || gen !== generation) return void (ok = true);
        if (!res.ok || !res.body) throw new Error(String(res.status));
        const reader = res.body.getReader();
        let odd: number | null = null;
        let any = false;
        while (true) {
          const { value, done } = await reader.read();
          if (done || over || gen !== generation) break;
          let bytes = value;
          if (odd !== null) {
            const joined = new Uint8Array(bytes.length + 1);
            joined[0] = odd;
            joined.set(bytes, 1);
            bytes = joined;
            odd = null;
          }
          if (bytes.length % 2) {
            odd = bytes[bytes.length - 1];
            bytes = bytes.subarray(0, bytes.length - 1);
          }
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const pcm = new Int16Array(bytes.byteLength / 2);
          for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true);
          if (pcm.length) any = true;
          play(pcm, gen);
        }
        ok = any || over || gen !== generation;
      } catch (e) {
        ok = over || gen !== generation; // an abort by reset/stop is not a failure
        status = Number((e as Error)?.message) || 0;
      } finally {
        fetches.delete(ctrl);
        pendingRequests--;
      }
      if (!ok) {
        // a used-up minute quota passes quickly; anything else (no key, outage) lasts longer
        neuralDownUntil = Date.now() + (status === 429 ? 60_000 : 5 * 60_000);
        handOver(part);
        return;
      }
      checkEnd();
    })();
  };

  const sendReady = (all: boolean) => {
    if (over || fallback) return;
    // one request per answer: the free tier allows very few requests a minute, and a second
    // request for the rest of the answer was what ran into the limit (and the browser voice)
    if (all && buffer.trim()) {
      sentFirst = true;
      request(buffer);
      buffer = '';
    }
  };

  const stream: SpeechStream = {
    push(text) {
      if (over) return;
      if (fallback) return fallback.push(text);
      buffer += text;
      sendReady(false);
    },
    reset() {
      if (over) return;
      if (fallback) return fallback.reset();
      generation++;
      silence();
      pendingRequests = 0;
      chain = Promise.resolve();
      buffer = '';
      sentFirst = false;
      playUntil = 0;
    },
    end() {
      if (over || ended) return;
      ended = true;
      if (fallback) return fallback.end();
      sendReady(true);
      checkEnd();
    },
    stop() {
      if (fallback) fallback.stop();
      finish('stopped');
    },
    get active() {
      return !over;
    },
  };
  speaking = stream;
  return stream;
}

/**
 * Speaks an answer while it is being written: the neural voice when it can be used (an audio
 * output was opened by a click and the voice has not failed recently), else the browser voice.
 */
export function speakStream(h: SpeakHandlers): SpeechStream {
  if (audio && audio.state !== 'closed' && Date.now() > neuralDownUntil && typeof fetch === 'function') return neuralStream(h);
  return browserStream(h);
}
