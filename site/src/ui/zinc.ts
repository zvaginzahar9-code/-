import { ScrollTrigger } from '../core/smooth';
import { $, dpr, finePointer, isNarrow, reducedMotion, visibility } from '../core/env';

/**
 * Hot-dip galvanized "spangle": zinc crystal grains (Voronoi cells), each with its own
 * crystal orientation, so a moving light makes them flash individually — the way real
 * galvanized steel glitters. Grains grow from their nuclei as the section scrolls in.
 */
const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uGrow;
uniform vec2 uLight;
uniform float uTime;
uniform float uScale;

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float hash1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes.y;
  vec2 p = uv * uScale;
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float d1 = 9.0, d2 = 9.0;
  vec2 cell = vec2(0.0);
  vec2 toSeed = vec2(0.0);
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash2(ip + g);
    vec2 r = g + o - fp;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; cell = ip + g; toSeed = r; }
    else if (d < d2) { d2 = d; }
  }
  d1 = sqrt(d1); d2 = sqrt(d2);
  float edge = d2 - d1;                 // distance to grain boundary

  // crystal orientation & dendrite "feathers" along it
  float ang = hash1(cell) * 6.2831;
  vec2 dir = vec2(cos(ang), sin(ang));
  float along = dot(-toSeed, dir);
  float across = dot(-toSeed, vec2(-dir.y, dir.x));
  float feather = 0.5 + 0.5 * sin(across * 46.0 + abs(along) * 18.0);
  feather = mix(1.0, feather, 0.22 * smoothstep(0.0, 0.5, d1));

  // each grain reflects a light direction differently → it flashes as the light moves
  vec2 L = normalize(uLight - uv + 0.0001);
  float facing = 0.5 + 0.5 * dot(dir, L);
  float sheen = pow(facing, 6.0) * (0.55 + 0.45 * hash1(cell + 3.1));
  float base = 0.70 + 0.16 * hash1(cell + 7.7);
  float zinc = base * feather + sheen * 0.42;
  zinc -= (1.0 - smoothstep(0.0, 0.035, edge)) * 0.22;   // grain boundaries

  // growth: grains nucleate at their seed and spread; molten zinc is smooth & warm-grey
  float t = hash1(cell + 1.7) * 0.55;
  float grown = smoothstep(0.0, 0.08, (uGrow - t) * 2.2 - d1);
  float molten = 0.78 + 0.05 * sin(uv.x * 3.0 + uTime * 0.6) * sin(uv.y * 4.0 - uTime * 0.4);
  float v = mix(molten, zinc, grown);
  // cool steel tint, matched to --zinc / --paper
  vec3 col = vec3(v * 0.93, v * 0.965, v);
  // soft vignette towards the text side
  col *= 1.0 - 0.10 * smoothstep(0.4, 1.4, length(gl_FragCoord.xy / uRes - vec2(0.75, 0.6)));
  gl_FragColor = vec4(col, 1.0);
}`;

const VERT = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

export function initZinc() {
  const canvas = $<HTMLCanvasElement>('[data-zinc-gl]');
  const section = $('[data-zinc]');
  if (!canvas || !section) return;
  const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
  if (!gl) return;

  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = (n: string) => gl.getUniformLocation(prog, n);
  const uRes = u('uRes'), uGrow = u('uGrow'), uLight = u('uLight'), uTime = u('uTime'), uScale = u('uScale');

  let grow = reducedMotion ? 1 : 0;
  let light = [0.4, 0.9];
  let target = [0.4, 0.9];
  let visible = false;
  let raf = 0;
  const t0 = performance.now();

  const size = () => {
    const k = dpr(isNarrow() ? 1 : 1.5);
    canvas.width = Math.round(canvas.clientWidth * k);
    canvas.height = Math.round(canvas.clientHeight * k);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uScale, isNarrow() ? 7 : 9);
  };
  const render = () => {
    raf = 0;
    light[0] += (target[0] - light[0]) * 0.08;
    light[1] += (target[1] - light[1]) * 0.08;
    gl.uniform1f(uGrow, grow);
    gl.uniform2f(uLight, light[0], light[1]);
    gl.uniform1f(uTime, (performance.now() - t0) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const settling = Math.abs(target[0] - light[0]) + Math.abs(target[1] - light[1]) > 0.002;
    if (visible && !reducedMotion && (settling || grow < 1)) raf = requestAnimationFrame(render);
  };
  const kick = () => !raf && (raf = requestAnimationFrame(render));

  size();
  new ResizeObserver(() => { size(); kick(); }).observe(canvas);
  visibility(section, v => { visible = v; if (v) kick(); });

  if (!reducedMotion) {
    ScrollTrigger.create({
      trigger: section,
      start: 'top 85%',
      end: 'center 45%',
      scrub: true,
      onUpdate: s => {
        grow = s.progress * 1.05;
        // the light also travels with the scroll, so grains flash even on touch screens
        target = [0.25 + s.progress * 1.2, 1.1 - s.progress * 0.5];
        kick();
      },
    });
    if (finePointer) {
      section.addEventListener('pointermove', e => {
        const r = canvas.getBoundingClientRect();
        target = [((e.clientX - r.left) / r.height) * 1, (r.bottom - e.clientY) / r.height];
        kick();
      });
    }
  }
  render();
}
