import { dpr, reducedMotion } from '../core/env';
import type { State } from './machine';

/**
 * «Провод» — the assistant's state indicator: a conductor strung between two insulators.
 * Everything that moves on it is caused by something real:
 *   listening  — the wire takes the shape of the live microphone waveform (when the page has it);
 *   processing — a pulse runs along the wire for as long as a request is in flight;
 *   responding — each received chunk of the answer sends a ripple down the wire;
 *   speaking   — each word boundary reported by the speech engine plucks the wire.
 * With no such signal the wire hangs still. The loop runs only while there is motion to draw.
 */

const N = 72; // simulation points along the wire
const COLORS = { wire: '#1c2226', steel: '#5e676d', signal: '#f5c400', fault: '#b53a24' };

export interface Wire {
  setState(state: State): void;
  /** live microphone data for the listening state; null when the page has no access to it */
  setAnalyser(analyser: AnalyserNode | null): void;
  /** a real event arrived (answer chunk, word boundary): strength 0..1 */
  pluck(strength: number): void;
  /** the canvas is visible again */
  wake(): void;
  resize(): void;
  destroy(): void;
}

export function createWire(canvas: HTMLCanvasElement): Wire {
  const ctx = canvas.getContext('2d')!;
  let w = 0;
  let h = 0;
  let state: State = 'idle';
  let analyser: AnalyserNode | null = null;
  let samples: Uint8Array<ArrayBuffer> | null = null;
  let raf = 0;
  let last = 0;
  let pulse = 0; // position of the processing pulse, 0..1
  let sag = 0.5; // current sag, eased toward the state's target
  const y = new Float32Array(N); // displacement
  const v = new Float32Array(N); // velocity
  const level = new Float32Array(N); // smoothed microphone shape

  const targetSag = () => (state === 'error' ? 1 : state === 'idle' ? 0.5 : 0.16);
  const lamp = () => (state === 'error' ? COLORS.fault : state === 'idle' ? COLORS.steel : COLORS.signal);

  function resize() {
    const r = canvas.getBoundingClientRect();
    const k = dpr(2);
    const cw = Math.max(1, Math.round(r.width * k));
    const ch = Math.max(1, Math.round(r.height * k));
    // assigning the size reallocates and clears the canvas: skip when nothing changed
    if (cw === canvas.width && ch === canvas.height && w === r.width) return;
    w = r.width;
    h = r.height;
    canvas.width = cw;
    canvas.height = ch;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    draw();
  }

  /** One step of a damped wave along the wire; returns the remaining energy. */
  function step(dt: number) {
    const c = 0.34;
    let energy = 0;
    for (let s = 0; s < 2; s++) {
      for (let i = 1; i < N - 1; i++) v[i] += (y[i - 1] + y[i + 1] - 2 * y[i]) * c;
      for (let i = 1; i < N - 1; i++) {
        v[i] *= 1 - Math.min(0.5, dt * 2.6);
        y[i] += v[i];
        energy += Math.abs(y[i]) + Math.abs(v[i]);
      }
    }
    return energy;
  }

  function readMic() {
    if (!analyser || !samples) return false;
    analyser.getByteTimeDomainData(samples);
    const stride = samples.length / N;
    for (let i = 1; i < N - 1; i++) {
      const raw = (samples[Math.floor(i * stride)] - 128) / 128;
      // taper to the fixed ends and smooth over a few frames so the wire moves, not twitches
      const taper = Math.sin((Math.PI * i) / (N - 1));
      level[i] += (raw * taper - level[i]) * 0.45;
    }
    return true;
  }

  function draw() {
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    const pad = 14;
    const x0 = pad;
    const x1 = w - pad;
    const mid = h * 0.42;
    const depth = Math.min(h * 0.34, 26 + h * 0.08) * sag;
    const amp = Math.min(h * 0.3, 44);
    const micOn = state === 'listening' && analyser;
    const px = (i: number) => x0 + ((x1 - x0) * i) / (N - 1);
    const py = (i: number) => {
      const t = i / (N - 1);
      return mid + depth * 4 * t * (1 - t) + (micOn ? level[i] * amp * 2.2 : 0) + y[i] * amp;
    };

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    for (let i = 1; i < N; i++) ctx.lineTo(px(i), py(i));
    ctx.strokeStyle = state === 'error' ? COLORS.steel : COLORS.wire;
    ctx.lineWidth = 1.25;
    ctx.setLineDash(state === 'error' ? [5, 5] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    if (state === 'processing' && !reducedMotion) {
      // the travelling pulse: a short energised stretch of the wire
      const a = Math.max(0, Math.floor((pulse - 0.14) * (N - 1)));
      const b = Math.min(N - 1, Math.ceil(pulse * (N - 1)));
      if (b > a) {
        ctx.beginPath();
        ctx.moveTo(px(a), py(a));
        for (let i = a + 1; i <= b; i++) ctx.lineTo(px(i), py(i));
        ctx.strokeStyle = COLORS.signal;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    } else if (state === 'processing' || state === 'responding' || state === 'speaking' || state === 'listening' || state === 'transcribing') {
      // energised: a thin signal line under the conductor
      ctx.beginPath();
      ctx.moveTo(px(0), py(0) + 2.5);
      for (let i = 1; i < N; i++) ctx.lineTo(px(i), py(i) + 2.5);
      ctx.strokeStyle = COLORS.signal;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // insulators: the left one is the state lamp
    for (const [x, yy, fill] of [
      [x0, py(0), lamp()],
      [x1, py(N - 1), COLORS.wire],
    ] as const) {
      ctx.save();
      ctx.translate(x, yy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = fill;
      ctx.fillRect(-4.5, -4.5, 9, 9);
      ctx.restore();
    }
  }

  function frame(t: number) {
    raf = 0;
    // nothing is drawn for a hidden panel; wake() restarts the loop
    if (!canvas.offsetParent) return void (last = 0);
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    let active = false;
    const ds = targetSag() - sag;
    if (Math.abs(ds) > 0.004) {
      sag += ds * Math.min(1, dt * 9);
      active = true;
    } else sag = targetSag();
    if (state === 'processing' && !reducedMotion) {
      pulse = (pulse + dt * 0.85) % 1.14;
      active = true;
    }
    // under reduced motion the microphone is shown by the lamp and the status text, not by movement
    if (state === 'listening' && !reducedMotion && readMic()) active = true;
    if (step(dt) > 0.002) active = true;
    draw();
    if (active) run();
    else last = 0;
  }
  function run() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    } else run();
  };
  document.addEventListener('visibilitychange', onVisibility);
  resize();

  return {
    setState(s) {
      if (s === state) return;
      state = s;
      pulse = 0;
      if (s !== 'listening') level.fill(0);
      if (reducedMotion) {
        // no movement: the state reads from the lamp, the signal line and the status text
        sag = targetSag();
        y.fill(0);
        v.fill(0);
        draw();
        return;
      }
      run();
    },
    setAnalyser(a) {
      analyser = a;
      samples = a ? new Uint8Array(new ArrayBuffer(a.fftSize)) : null;
      level.fill(0);
      run();
    },
    pluck(strength) {
      if (reducedMotion) return;
      const k = Math.max(0.15, Math.min(1, strength));
      for (let i = 2; i < 9; i++) v[i] += 0.11 * k * Math.sin((Math.PI * (i - 1)) / 8);
      run();
    },
    wake: run,
    resize,
    destroy() {
      cancelAnimationFrame(raf);
      raf = 0;
      document.removeEventListener('visibilitychange', onVisibility);
      analyser = null;
    },
  };
}
