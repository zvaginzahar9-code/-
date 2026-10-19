/**
 * The assistant's interaction state. One value drives the status line, the wire
 * indicator and the controls, so the interface cannot show an activity that is not
 * actually happening: every state is entered only by the real event named here.
 */
export type State =
  | 'idle'
  /** the microphone is open and recognition is running */
  | 'listening'
  /** the visitor stopped speaking; the browser is finalising the transcript */
  | 'transcribing'
  /** a request is in flight and no answer text has arrived yet */
  | 'processing'
  /** answer text is arriving */
  | 'responding'
  /** speech synthesis is playing */
  | 'speaking'
  | 'error';

export type Signal =
  | 'LISTEN_START' // recognition reported that audio capture began
  | 'SPEECH_END' // recognition reported the end of speech
  | 'LISTEN_CANCEL' // stopped by the visitor, or ended with nothing recognised
  | 'LISTEN_FAIL' // permission denied, no microphone, service unavailable
  | 'SUBMIT' // a message was sent to the server
  | 'FIRST_TEXT' // the first chunk of the answer arrived
  | 'WORKING' // the server reported thinking or a tool call
  | 'DONE' // the server finished the turn
  | 'FAIL' // the turn failed
  | 'CANCEL' // the visitor stopped the turn
  | 'SPEAK_START' // synthesis began playing
  | 'SPEAK_END' // synthesis finished, was stopped, or failed
  | 'RESET';

const T: Record<State, Partial<Record<Signal, State>>> = {
  idle: { LISTEN_START: 'listening', LISTEN_FAIL: 'error', SUBMIT: 'processing', SPEAK_START: 'speaking' },
  listening: { SPEECH_END: 'transcribing', LISTEN_CANCEL: 'idle', LISTEN_FAIL: 'error', SUBMIT: 'processing' },
  transcribing: { SUBMIT: 'processing', LISTEN_CANCEL: 'idle', LISTEN_FAIL: 'error', LISTEN_START: 'listening' },
  processing: { FIRST_TEXT: 'responding', DONE: 'idle', FAIL: 'error', CANCEL: 'idle' },
  responding: { WORKING: 'processing', DONE: 'idle', FAIL: 'error', CANCEL: 'idle' },
  // starting to listen or sending a message interrupts playback
  speaking: { SPEAK_END: 'idle', LISTEN_START: 'listening', LISTEN_FAIL: 'error', SUBMIT: 'processing' },
  error: { LISTEN_START: 'listening', LISTEN_FAIL: 'error', SUBMIT: 'processing', SPEAK_START: 'speaking' },
};

/** Next state for a signal; a signal that does not apply leaves the state unchanged. */
export function next(state: State, signal: Signal): State {
  if (signal === 'RESET') return 'idle';
  return T[state][signal] ?? state;
}

export const isBusy = (s: State) => s === 'processing' || s === 'responding';

export const STATUS: Record<State, string> = {
  idle: 'готов',
  listening: 'слушаю',
  transcribing: 'распознаю речь',
  processing: 'обрабатываю запрос',
  responding: 'отвечаю',
  speaking: 'говорю',
  error: 'ошибка',
};

export function createMachine(onChange: (state: State, prev: State, signal: Signal) => void) {
  let state: State = 'idle';
  return {
    get state() {
      return state;
    },
    send(signal: Signal) {
      const prev = state;
      state = next(state, signal);
      if (state !== prev) onChange(state, prev, signal);
      return state;
    },
  };
}
