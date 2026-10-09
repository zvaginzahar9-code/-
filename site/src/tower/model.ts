// Procedural lattice transmission tower (single-circuit intermediate type, generic proportions).
// Plain data, no three.js, so the SVG poster and the WebGL scene share one model.
// Units: metres, y up, origin at the centre of the foundation.

export type Vec3 = [number, number, number];
export type MemberKind = 'leg' | 'horizontal' | 'diagonal' | 'arm' | 'peak' | 'insulator';
export interface Member {
  a: Vec3;
  b: Vec3;
  kind: MemberKind;
  /** 0..1 order in which the member is drawn / assembled (bottom to top) */
  order: number;
}

export interface TowerSpec {
  height: number; // H
  base: number; // L, distance between foundation axes
  neckY: number; // where the taper stops
  neck: number; // half-width at the neck
  arms: { y: number; side: -1 | 1; reach: number }[];
}

export const DEFAULT_TOWER: TowerSpec = {
  height: 31,
  base: 4.2,
  neckY: 21,
  neck: 0.6,
  arms: [
    { y: 19, side: -1, reach: 3.3 },
    { y: 23, side: 1, reach: 3.3 },
    { y: 27, side: -1, reach: 3.0 },
  ],
};

/** Half-width of the square tower body at height y. */
export function halfWidth(spec: TowerSpec, y: number): number {
  if (y <= spec.neckY) return spec.base / 2 + (spec.neck - spec.base / 2) * (y / spec.neckY);
  const headTop = spec.arms[spec.arms.length - 1].y + 1.4;
  if (y <= headTop) return spec.neck;
  const t = (y - headTop) / (spec.height - headTop);
  return spec.neck + (0.12 - spec.neck) * t;
}

export function buildTower(spec: TowerSpec = DEFAULT_TOWER, detail = 1): Member[] {
  const out: Member[] = [];
  const add = (a: Vec3, b: Vec3, kind: MemberKind) => out.push({ a, b, kind, order: 0 });
  const half = (y: number) => halfWidth(spec, y);

  // body levels: taller panels near the ground, denser near the head
  const levels: number[] = [0];
  let y = 0;
  let step = 3.2 / detail;
  while (y < spec.neckY - 0.01) {
    y = Math.min(spec.neckY, y + step);
    levels.push(y);
    step = Math.max(1.6 / detail, step * 0.9);
  }
  const headTop = spec.arms[spec.arms.length - 1].y + 1.4;
  for (const ay of spec.arms.map(a => a.y)) {
    if (ay > spec.neckY + 0.2) levels.push(ay);
    if (ay + 1.4 > spec.neckY + 0.2) levels.push(ay + 1.4);
  }
  levels.push(headTop);
  const peakLevels = [headTop + (spec.height - headTop) * 0.5, spec.height - 0.6];
  levels.push(...peakLevels);
  const L = [...new Set(levels.map(v => +v.toFixed(3)))].sort((p, q) => p - q);

  const corner = (yy: number, i: number): Vec3 => {
    const h = half(yy);
    const sx = i === 0 || i === 3 ? -1 : 1;
    const sz = i < 2 ? 1 : -1;
    return [sx * h, yy, sz * h];
  };

  for (let k = 0; k < L.length - 1; k++) {
    const y0 = L[k];
    const y1 = L[k + 1];
    const isPeak = y0 >= headTop - 0.01;
    for (let i = 0; i < 4; i++) {
      add(corner(y0, i), corner(y1, i), isPeak ? 'peak' : 'leg');
    }
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      add(corner(y1, i), corner(y1, j), isPeak ? 'peak' : 'horizontal');
      // X bracing on every face; single diagonal on small panels in the peak
      add(corner(y0, i), corner(y1, j), isPeak ? 'peak' : 'diagonal');
      if (!isPeak && y1 - y0 > 1.1) add(corner(y0, j), corner(y1, i), 'diagonal');
    }
    if (k === 0) for (let i = 0; i < 4; i++) add(corner(0, i), corner(0, (i + 1) % 4), 'horizontal');
  }
  // peak tip (earth-wire support)
  const tip: Vec3 = [0, spec.height, 0];
  for (let i = 0; i < 4; i++) add(corner(L[L.length - 1], i), tip, 'peak');

  // cross-arms: triangular trusses
  for (const arm of spec.arms) {
    const h = half(arm.y);
    const s = arm.side;
    const tipA: Vec3 = [s * (h + arm.reach), arm.y, 0];
    const lowF: Vec3 = [s * h, arm.y, h];
    const lowB: Vec3 = [s * h, arm.y, -h];
    const upF: Vec3 = [s * h, arm.y + 1.4, h];
    const upB: Vec3 = [s * h, arm.y + 1.4, -h];
    add(lowF, tipA, 'arm');
    add(lowB, tipA, 'arm');
    add(upF, tipA, 'arm');
    add(upB, tipA, 'arm');
    const n = 3;
    for (let t = 1; t < n; t++) {
      const f = t / n;
      const pF: Vec3 = [lowF[0] + (tipA[0] - lowF[0]) * f, arm.y, lowF[2] * (1 - f)];
      const pB: Vec3 = [lowB[0] + (tipA[0] - lowB[0]) * f, arm.y, lowB[2] * (1 - f)];
      const qF: Vec3 = [upF[0] + (tipA[0] - upF[0]) * f, arm.y + 1.4 * (1 - f), upF[2] * (1 - f)];
      add(pF, pB, 'arm');
      add(pF, qF, 'arm');
      add(pB, [qF[0], qF[1], -qF[2]], 'arm');
    }
    // insulator string hanging from the tip
    add(tipA, [tipA[0], arm.y - 1.7, 0], 'insulator');
  }

  // assembly order: by height, legs first within a band, then bracing, arms last in their band
  const rank: Record<MemberKind, number> = { leg: 0, horizontal: 0.15, diagonal: 0.3, peak: 0.1, arm: 0.45, insulator: 0.6 };
  const maxY = spec.height;
  for (const m of out) {
    const yMin = Math.min(m.a[1], m.b[1]);
    m.order = (yMin / maxY) * 0.9 + rank[m.kind] * 0.1;
  }
  out.sort((p, q) => p.order - q.order);
  out.forEach((m, i) => (m.order = i / (out.length - 1)));
  return out;
}

/** Points where the phase conductors hang (bottom of each insulator string). */
export function conductorPoints(spec: TowerSpec = DEFAULT_TOWER): Vec3[] {
  return spec.arms.map(arm => {
    const h = halfWidth(spec, arm.y);
    return [arm.side * (h + arm.reach), arm.y - 1.7, 0] as Vec3;
  });
}

/** Front elevation as SVG path data (x right, y down), scaled to `scale` px per metre. */
export function elevationPath(members: Member[], scale: number, offX: number, offY: number): string {
  let d = '';
  for (const m of members) {
    // skip back-face duplicates that land on the same line in elevation
    if (m.a[2] < -0.01 && m.b[2] < -0.01 && m.kind !== 'arm') continue;
    const x1 = offX + m.a[0] * scale;
    const y1 = offY - m.a[1] * scale;
    const x2 = offX + m.b[0] * scale;
    const y2 = offY - m.b[1] * scale;
    d += `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  return d;
}
