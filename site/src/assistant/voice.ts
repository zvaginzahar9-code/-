import { toPlain } from './markdown';

/**
 * Voice services built on what the browser itself provides (Web Speech API): speech
 * recognition and speech synthesis. No audio passes through this site's server. Both
 * are optional — feature-detected, and every failure is reported, never papered over.
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

export const voiceSupport = () => ({
  listen: recognitionCtor() !== null,
  speak: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
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
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    try {
    rec = new Ctor();
    rec.lang = 'ru-RU';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onaudiostart = () => {
      armSilence();
      h.onStart(analyser);
    };
    rec.onspeechend = () => h.onSpeechEnd();
    rec.onresult = e => {
      armSilence();
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      h.onInterim((finalText + interim).trim());
    };
    rec.onerror = e => {
      error = mapError(e.error) ?? error;
    };
    rec.onend = () => {
      if (cancelled) return end({ text: '' });
      const text = finalText.trim();
      end(text ? { text } : error ? { error } : { error: 'no-speech' });
    };
    rec.start();
    } catch {
      end({ error: 'failed' });
    }
  })();

  return {
    stop() {
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
    const male = voices.find(v => /pavel|павел|dmitr|дмитр|yuri|юри|maxim|максим|aleks|алекс|ivan|иван|artem|артём|male|муж/i.test(v.name) && !/female|жен/i.test(v.name));
    return male ?? voices.find(v => v.localService) ?? voices[0] ?? null;
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
export function speakStream(h: SpeakHandlers): SpeechStream {
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
