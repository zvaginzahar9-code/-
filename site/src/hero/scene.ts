import {
  ACESFilmicToneMapping,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CylinderGeometry,
  DirectionalLight,
  DynamicDrawUsage,
  Euler,
  ExtrudeGeometry,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Scene,
  Shape,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildTower, conductorPoints, DEFAULT_TOWER, type Member } from '../tower/model';
import type { HeroLayout } from './hero';
import { PHASE_AT } from './hero';
import { clamp, dpr, isNarrow, lerp, visibility } from '../core/env';
import { gsap } from '../core/smooth';

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const range = (p: number, a: number, b: number) => clamp((p - a) / (b - a));

const WIDTH: Record<Member['kind'], number> = { leg: 0.16, horizontal: 0.075, diagonal: 0.065, arm: 0.07, peak: 0.07, insulator: 0 };

/** Unit equal-leg angle (L-profile) running along +Y, centred on its heel. */
function angleGeometry() {
  const t = 0.16; // flange thickness relative to width
  const s = new Shape();
  s.moveTo(-0.5, -0.5);
  s.lineTo(0.5, -0.5);
  s.lineTo(0.5, -0.5 + t);
  s.lineTo(-0.5 + t, -0.5 + t);
  s.lineTo(-0.5 + t, 0.5);
  s.lineTo(-0.5, 0.5);
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -0.5);
  g.rotateX(-Math.PI / 2);
  return g;
}

export function createTowerScene(canvas: HTMLCanvasElement, layout0: HeroLayout, onReady: () => void, still: boolean) {
  let L = layout0;
  const narrow = isNarrow();
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(dpr(narrow ? 1.5 : 1.75));
  renderer.setSize(L.w, L.h, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const sun = new DirectionalLight(0xfff4e0, 1.6);
  sun.position.set(-20, 40, 30);
  scene.add(sun, new HemisphereLight(0xe8eef2, 0x9aa1a5, 0.7));

  const camera = new PerspectiveCamera(12, L.w / L.h, 0.5, 2000);

  // ── members ─────────────────────────────────────────────
  const members = buildTower(DEFAULT_TOWER, narrow ? 0.85 : 1).filter(m => m.kind !== 'insulator');
  const N = members.length;
  const uniforms = { uSweep: { value: -2 }, uBand: { value: 1.4 } };
  const material = new MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.6, envMapIntensity: 1.1 });
  material.onBeforeCompile = shader => {
    shader.uniforms.uSweep = uniforms.uSweep;
    shader.uniforms.uBand = uniforms.uBand;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWY;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 wpZ = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wpZ = instanceMatrix * wpZ;
        #endif
        vWY = (modelMatrix * wpZ).y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWY;\nuniform float uSweep;\nuniform float uBand;\nfloat gZ;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        gZ = 1.0 - smoothstep(uSweep - uBand, uSweep, vWY);
        // black (raw rolled) steel → hot-dip galvanized zinc
        diffuseColor.rgb = mix(vec3(0.16, 0.17, 0.18), vec3(0.80, 0.83, 0.85), gZ);`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.72, 0.3, gZ);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(0.35, 1.0, gZ);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float edgeZ = smoothstep(uBand, 0.0, abs(vWY - uSweep + uBand * 0.5)) * step(-1.0, uSweep);
        totalEmissiveRadiance += vec3(1.0, 0.78, 0.25) * edgeZ * 0.55;`,
      );
  };
  const mesh = new InstancedMesh(angleGeometry(), material, N);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  scene.add(mesh);

  // final transforms + scattered start states
  const up = new Vector3(0, 1, 0);
  const finals: { pos: Vector3; quat: Quaternion; scale: Vector3; from: Vector3; spin: Quaternion; order: number }[] = [];
  const rnd = mulberry32(7);
  for (const m of members) {
    const a = new Vector3(...m.a);
    const b = new Vector3(...m.b);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const pos = a.clone().add(b).multiplyScalar(0.5);
    const quat = new Quaternion().setFromUnitVectors(up, dir.normalize());
    // turn the angle so its heel faces outwards
    const outward = Math.atan2(pos.x, pos.z);
    quat.multiply(new Quaternion().setFromAxisAngle(up, outward + Math.PI * 0.75));
    const w = WIDTH[m.kind];
    const out = new Vector3(pos.x, 0, pos.z).normalize();
    if (!isFinite(out.x)) out.set(1, 0, 0);
    const from = pos.clone().add(out.multiplyScalar(3 + rnd() * 5)).add(new Vector3((rnd() - 0.5) * 3, 2 + rnd() * 5, (rnd() - 0.5) * 3));
    const spin = new Quaternion().setFromEuler(new Euler((rnd() - 0.5) * 1.6, (rnd() - 0.5) * 1.6, (rnd() - 0.5) * 1.6));
    finals.push({ pos, quat, scale: new Vector3(w, len + w * 0.4, w), from, spin, order: m.order });
  }

  // ── drawing lines (blueprint) ───────────────────────────
  const linePos = new Float32Array(N * 6);
  members.forEach((m, i) => linePos.set([...m.a, ...m.b], i * 6));
  const lineGeo = new BufferGeometry();
  lineGeo.setAttribute('position', new BufferAttribute(linePos, 3));
  const lineMat = new LineBasicMaterial({ color: 0x1c2226, transparent: true, opacity: 0.9, depthWrite: false });
  const lines = new LineSegments(lineGeo, lineMat);
  scene.add(lines);

  // ── insulator strings (glass discs) ─────────────────────
  const conductors = conductorPoints(DEFAULT_TOWER);
  const discsPer = 9;
  const discGeo = new CylinderGeometry(0.17, 0.17, 0.05, 20);
  const discMat = new MeshPhysicalMaterial({ color: 0x9fb3b8, roughness: 0.08, metalness: 0, transmission: 0.2, thickness: 0.2, clearcoat: 1 });
  const discs = new InstancedMesh(discGeo, discMat, conductors.length * discsPer);
  const dm = new Matrix4();
  conductors.forEach((c, k) => {
    for (let i = 0; i < discsPer; i++) {
      dm.makeTranslation(c[0], c[1] + 0.12 + i * 0.17, c[2]);
      discs.setMatrixAt(k * discsPer + i, dm);
    }
  });
  scene.add(discs);

  // ── conductors: catenaries running along Z out of frame ─
  const wireMat = new MeshStandardMaterial({ color: 0x2b3135, metalness: 0.6, roughness: 0.45 });
  const wires: Mesh[] = [];
  const span = 70;
  const addWire = (x: number, y: number, sag: number, r: number) => {
    // only the span running away from the camera: the near span would sweep across the copy
    for (const s of [-1]) {
      const pts: Vector3[] = [];
      for (let i = 0; i <= 48; i++) {
        const t = i / 48;
        const z = s * t * span;
        // parabolic sag towards mid-span; the next tower is out of frame
        pts.push(new Vector3(x, y - sag * 4 * t * (1 - t), z));
      }
      const geo = new TubeGeometry(new CatmullRomCurve3(pts), 96, r, 5, false);
      const w = new Mesh(geo, wireMat);
      w.userData.count = geo.index!.count;
      geo.setDrawRange(0, 0);
      wires.push(w);
      scene.add(w);
    }
  };
  conductors.forEach(c => addWire(c[0], c[1], 6, 0.045));
  addWire(0, DEFAULT_TOWER.height, 4, 0.03); // earth wire

  // ── foundations + contact shadow ────────────────────────
  const fGeo = new BoxGeometry(0.9, 0.5, 0.9);
  const fMat = new MeshStandardMaterial({ color: 0xb4b8b6, roughness: 0.9 });
  const half = DEFAULT_TOWER.base / 2;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const f = new Mesh(fGeo, fMat);
    f.position.set(sx * half, -0.2, sz * half);
    scene.add(f);
  }
  const shadowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grd.addColorStop(0, 'rgba(28,34,38,0.38)');
    grd.addColorStop(1, 'rgba(28,34,38,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    return new CanvasTexture(c);
  })();
  const shadow = new Mesh(new PlaneGeometry(14, 14), new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  scene.add(shadow);

  // ── state ───────────────────────────────────────────────
  let p = 0;
  let shown = 0; // smoothed progress
  const tmpM = new Matrix4();
  const tmpQ = new Quaternion();
  const tmpV = new Vector3();
  const tmpS = new Vector3();

  function frame(prog: number) {
    const pDraw = range(prog, 0, PHASE_AT[1]);
    const pAsm = range(prog, PHASE_AT[1] - 0.02, PHASE_AT[2]);
    const pZinc = range(prog, PHASE_AT[2], PHASE_AT[3]);
    const pLine = range(prog, PHASE_AT[3], 1);

    // members fly in, bottom → top
    for (let i = 0; i < N; i++) {
      const f = finals[i];
      const local = clamp((pAsm * 1.18 - f.order) / 0.18);
      const e = easeOut(local);
      if (local <= 0) {
        tmpM.makeScale(0, 0, 0);
      } else {
        tmpV.lerpVectors(f.from, f.pos, e);
        tmpQ.copy(f.spin).slerp(f.quat, e);
        // last few percent: settle (tiny overshoot reads as "bolted on")
        tmpS.copy(f.scale).multiplyScalar(Math.min(1, 0.4 + local * 1.6));
        tmpM.compose(tmpV, tmpQ, tmpS);
      }
      mesh.setMatrixAt(i, tmpM);
    }
    mesh.instanceMatrix.needsUpdate = true;

    // blueprint lines: draw during phase 1, ghost while assembling, gone after galvanizing
    lineGeo.setDrawRange(0, Math.floor(N * (still ? 1 : Math.max(pDraw, 0.0001))) * 2);
    lineMat.opacity = 0.9 * (1 - 0.75 * easeInOut(pAsm)) * (1 - pZinc);
    lines.visible = lineMat.opacity > 0.01;

    // galvanizing sweep from the ground up
    uniforms.uSweep.value = lerp(-2, DEFAULT_TOWER.height + 3, easeInOut(pZinc));
    discs.visible = pAsm > 0.9;
    discs.scale.setScalar(1);

    shadow.material.opacity = easeOut(pAsm);
    for (const w of wires) (w.geometry as TubeGeometry).setDrawRange(0, Math.floor((w.userData.count as number) * easeInOut(pLine) / 6) * 6);

    // camera: flat elevation (matches the SVG drawing) → dolly-zoom into a low 3/4 view
    const t = easeInOut(clamp(pAsm * 0.35 + pZinc * 0.25 + pLine * 0.4));
    const fov = lerp(12, narrow ? 30 : 36, t);
    camera.fov = fov;
    const viewH = L.h / L.scale; // metres visible vertically at the tower in the flat view
    const dist0 = viewH / 2 / Math.tan(MathUtils.degToRad(12) / 2);
    const frameH = lerp(viewH, viewH * (narrow ? 1.05 : 0.95), t);
    const dist = frameH / 2 / Math.tan(MathUtils.degToRad(fov) / 2);
    // where the axis/ground sit on screen in the flat view
    const offX = (L.axisX - L.w / 2) / L.scale;
    const camY0 = (L.groundY - L.h / 2) / L.scale;
    const az = lerp(0, narrow ? 0.5 : 0.62, t) + Math.sin(pLine * Math.PI) * 0.05;
    const targetY = lerp(camY0, DEFAULT_TOWER.height * 0.47, t);
    const camH = lerp(camY0, 2.5, t); // camera height: low, looking up
    // the whole camera rig orbits the tower axis, so the tower stays where the drawing was
    const rx = lerp(-offX, -offX * 0.85, t);
    const ca = Math.cos(az);
    const sa = Math.sin(az);
    camera.position.set(rx * ca + dist * sa, camH, -rx * sa + dist * ca);
    camera.lookAt(rx * ca, targetY, -rx * sa);
    camera.updateProjectionMatrix();
    void dist0;
    renderer.render(scene, camera);
  }

  // ── loop: only while visible and while the value is still easing ──
  let visible = true;
  let raf = 0;
  const tick = () => {
    raf = 0;
    if (!visible) return;
    const target = still ? 1 : p;
    shown += (target - shown) * 0.14;
    if (Math.abs(target - shown) < 0.0004) shown = target;
    frame(shown);
    if (shown !== target) raf = requestAnimationFrame(tick);
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };
  visibility(canvas, v => {
    visible = v;
    if (v) kick();
  });
  document.addEventListener('visibilitychange', () => !document.hidden && kick());

  frame(still ? 1 : 0);
  // fade in once the first frame is on screen
  requestAnimationFrame(() => {
    onReady();
    gsap.fromTo(lineMat, { opacity: 0 }, { opacity: 0.9, duration: 0.6 });
  });

  return {
    setProgress(next: number) {
      p = next;
      kick();
    },
    resize(next: HeroLayout) {
      L = next;
      renderer.setSize(L.w, L.h, false);
      camera.aspect = L.w / L.h;
      frame(shown);
    },
  };
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
