import { $$, dpr, finePointer, reducedMotion, visibility } from '../core/env';

/**
 * Section divider: three conductors strung across the viewport between two insulators.
 * Verlet rope physics; the pointer "plucks" a wire when it crosses it, and scrolling
 * gives a small sway. Static (still drawn) for reduced motion.
 */
interface Rope {
  x: Float32Array;
  y: Float32Array;
  px: Float32Array;
  py: Float32Array;
  rest: number;
  y0: number;
  sag: number;
}

const NODES = 34;

export function initWires() {
  for (const host of $$('[data-wires]')) mount(host);
}

function mount(host: HTMLElement) {
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  const dark = host.classList.contains('wires--dark');
  const ink = dark ? 'rgba(238,240,238,0.55)' : 'rgba(28,34,38,0.62)';
  let W = 0;
  let H = 0;
  let ropes: Rope[] = [];
  let running = false;
  let energy = 1; // keeps the loop alive until the wires settle
  let pulse = -1; // a current pulse travelling along the middle wire

  const build = () => {
    const r = host.getBoundingClientRect();
    W = r.width;
    H = r.height;
    const k = dpr(1.75);
    canvas.width = W * k;
    canvas.height = H * k;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ropes = [0.28, 0.46, 0.64].map((f, i) => {
      const y0 = H * f;
      const sag = H * (0.14 + i * 0.035);
      const x = new Float32Array(NODES);
      const y = new Float32Array(NODES);
      for (let n = 0; n < NODES; n++) {
        const t = n / (NODES - 1);
        x[n] = t * W;
        y[n] = y0 + sag * 4 * t * (1 - t);
      }
      // rope length of a parabola with this sag, so the rest shape matches the drawn one
      const len = W + (8 * sag * sag) / (3 * W);
      return { x, y, px: x.slice(), py: y.slice(), rest: len / (NODES - 1), y0, sag };
    });
    energy = 1;
    draw();
  };

  const step = () => {
    const g = 0.42;
    for (const r of ropes) {
      for (let n = 1; n < NODES - 1; n++) {
        const vx = (r.x[n] - r.px[n]) * 0.965;
        const vy = (r.y[n] - r.py[n]) * 0.965;
        r.px[n] = r.x[n];
        r.py[n] = r.y[n];
        r.x[n] += vx;
        r.y[n] += vy + g;
      }
      for (let it = 0; it < 14; it++) {
        for (let n = 0; n < NODES - 1; n++) {
          const dx = r.x[n + 1] - r.x[n];
          const dy = r.y[n + 1] - r.y[n];
          const d = Math.hypot(dx, dy) || 1;
          const diff = ((d - r.rest) / d) * 0.5;
          if (n > 0) { r.x[n] += dx * diff; r.y[n] += dy * diff; }
          if (n + 1 < NODES - 1) { r.x[n + 1] -= dx * diff; r.y[n + 1] -= dy * diff; }
        }
      }
    }
  };

  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1.15;
    ctx.strokeStyle = ink;
    for (const r of ropes) {
      ctx.beginPath();
      ctx.moveTo(r.x[0], r.y[0]);
      for (let n = 1; n < NODES - 1; n++) {
        const mx = (r.x[n] + r.x[n + 1]) / 2;
        const my = (r.y[n] + r.y[n + 1]) / 2;
        ctx.quadraticCurveTo(r.x[n], r.y[n], mx, my);
      }
      ctx.lineTo(r.x[NODES - 1], r.y[NODES - 1]);
      ctx.stroke();
    }
    // insulator strings at both ends
    ctx.fillStyle = ink;
    for (const r of ropes) {
      for (const x of [3, W - 3]) for (let i = 0; i < 4; i++) ctx.fillRect(x - 4, r.y0 - 4 - i * 5, 8, 2);
    }
    // current pulse
    if (pulse >= 0) {
      const r = ropes[1];
      const idx = Math.min(NODES - 2, Math.floor(pulse * (NODES - 1)));
      const grad = ctx.createRadialGradient(r.x[idx], r.y[idx], 0, r.x[idx], r.y[idx], 26);
      grad.addColorStop(0, 'rgba(245,196,0,0.95)');
      grad.addColorStop(1, 'rgba(245,196,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(r.x[idx] - 26, r.y[idx] - 26, 52, 52);
    }
  };

  const loop = () => {
    if (!running) return;
    step();
    if (pulse >= 0) {
      pulse += 0.012;
      if (pulse > 1) pulse = -1;
    }
    draw();
    energy *= 0.985;
    if (energy > 0.02 || pulse >= 0) requestAnimationFrame(loop);
    else running = false;
  };
  const wake = () => {
    energy = 1;
    if (!running && visible && !reducedMotion) {
      running = true;
      requestAnimationFrame(loop);
    }
  };

  // pluck: when the pointer crosses a wire, push the nearest nodes along the pointer velocity
  let lx = -1;
  let ly = -1;
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (lx >= 0) {
      const vx = x - lx;
      const vy = y - ly;
      for (const rope of ropes) {
        const n = Math.round((x / W) * (NODES - 1));
        if (n <= 0 || n >= NODES - 1) continue;
        const wy = rope.y[n];
        if ((ly - wy) * (y - wy) <= 0 || Math.abs(y - wy) < 6) {
          for (let k = -3; k <= 3; k++) {
            const m = n + k;
            if (m <= 0 || m >= NODES - 1) continue;
            const f = (1 - Math.abs(k) / 4) * 0.55;
            rope.py[m] -= vy * f;
            rope.px[m] -= vx * f * 0.3;
          }
          wake();
        }
      }
    }
    lx = x;
    ly = y;
  };
  if (!reducedMotion) {
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', () => (lx = ly = -1));
    if (!finePointer) host.addEventListener('pointerdown', e => { lx = e.clientX - canvas.getBoundingClientRect().left; ly = 0; onMove(e); });
  }

  let visible = false;
  visibility(host, v => {
    visible = v;
    if (v) {
      // a gentle sway as the divider scrolls into view, then a current pulse once
      for (const r of ropes) for (let n = 1; n < NODES - 1; n++) r.py[n] -= Math.sin((n / (NODES - 1)) * Math.PI) * 2.2;
      if (pulse < 0) pulse = 0;
      wake();
    }
  });

  let rt = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(rt);
    rt = requestAnimationFrame(build);
  }).observe(host);
  build();
  (host as any).__pulse = () => { pulse = 0; wake(); };
}
