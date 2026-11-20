// 3D chess board: rendering, animation and pointer interaction.
// The board knows nothing about chess rules; a controller feeds it positions/moves
// and answers "which squares can this piece go to?".
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { getPieceGeometries, createPieceMaterials, pieceHeight, pieceRadius } from './pieces.js';
import {
  TOP, BOARD_STYLES, createBoardTopCanvas, createSideTexture, createGrainCanvas,
  createRadialCanvas, createOutlineCanvas, canvasTexture, shade,
} from './textures.js';

const FILES = 'abcdefgh';
const BOARD_H = 0.34;
const TABLE_Y = -BOARD_H - 0.12;
const TRAY_X = 5.5;
const TRAY_SCALE = 0.66;
const TRAY_STEP = 0.56;
const LIFT = 0.14;
const DRAG_H = 0.34;

export const sqToXZ = (sq) => ({ x: sq.charCodeAt(0) - 97 - 3.5, z: 3.5 - (sq.charCodeAt(1) - 49) });
export const xzToSq = (x, z) => {
  const f = Math.floor(x + 4), r = Math.floor(4 - z);
  return f >= 0 && f < 8 && r >= 0 && r < 8 ? FILES[f] + (r + 1) : null;
};
const sqDist = (a, b) => Math.hypot(a.charCodeAt(0) - b.charCodeAt(0), a.charCodeAt(1) - b.charCodeAt(1));

export const Ease = {
  linear: (t) => t,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inCubic: (t) => t * t * t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outBounce: (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
};

class Tweener {
  constructor() { this.items = []; }
  add(o) {
    const tw = { ...o, start: performance.now() + (o.delay || 0), begun: false };
    tw.promise = new Promise((r) => (tw.resolve = r));
    this.items.push(tw);
    return tw;
  }
  _step(tw, t) {
    if (!tw.begun) { tw.begun = true; tw.begin && tw.begin(); }
    tw.update && tw.update(tw.ease ? tw.ease(t) : t, t);
  }
  update(now) {
    if (!this.items.length) return false;
    const list = this.items;
    this.items = [];
    for (const tw of list) {
      if (now < tw.start) { this.items.push(tw); continue; }
      const t = tw.dur > 0 ? Math.min(1, (now - tw.start) / tw.dur) : 1;
      this._step(tw, t);
      if (t >= 1) { tw.done && tw.done(); tw.resolve(); } else this.items.push(tw);
    }
    return true;
  }
  finish(tag) {
    for (let guard = 0; guard < 10; guard++) {
      const pick = this.items.filter((t) => !tag || t.tag === tag);
      if (!pick.length) return;
      this.items = this.items.filter((t) => !pick.includes(t));
      pick.sort((a, b) => a.start - b.start);
      for (const tw of pick) { this._step(tw, 1); tw.done && tw.done(); tw.resolve(); }
    }
  }
  get busy() { return this.items.length > 0; }
}

export class Board3D {
  constructor(container, { onSound } = {}) {
    this.container = container;
    this.onSound = onSound || (() => {});
    this.animSpeed = 1;
    this.showLegal = true;
    this.theme = 'light';
    this.styleKey = 'walnut';
    this.orientation = 'w';
    this.tw = new Tweener();
    this.camTw = new Tweener();
    this.bySquare = new Map();
    this.trays = { w: [], b: [] };
    this.inter = { enabled: false, canPick: () => false, getTargets: () => [], onMove: () => false };
    this.selected = null;
    this.targets = new Map();
    this.needsRender = true;
    this.idle = false;
    this.running = true;
    this.checkSq = null;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this._pid = 0;
    this._styleCache = new Map();
    // image ("sprite") piece sets
    this.sets = { w: null, b: null };
    this._sprites = new Set();
    this._spriteMats = new Map();
    this._badgeTex = new Map();
    this.roleIcons = null;
    this._unitPlane = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    this._badgeGeo = new THREE.CircleGeometry(0.5, 40);
    this._spriteBaseGeo = new THREE.LatheGeometry([
      new THREE.Vector2(0, 0), new THREE.Vector2(0.35, 0), new THREE.Vector2(0.362, 0.012),
      new THREE.Vector2(0.362, 0.045), new THREE.Vector2(0.35, 0.062), new THREE.Vector2(0.3, 0.07),
      new THREE.Vector2(0, 0.07),
    ], 56);
    this._initRenderer();
    this._initScene();
    this._initBoard();
    this._initHighlights();
    this.setBoardStyle(this.styleKey);
    this._initControls();
    this.resize();
    this.setView('default', false);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ------------------------------------------------------------------ setup
  _initRenderer() {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.setClearColor(0x000000, 0);
    const el = r.domElement;
    el.className = 'board-canvas';
    el.style.touchAction = 'none';
    this.container.appendChild(el);
    this.maxAniso = r.capabilities.getMaxAnisotropy();
    // our listeners are registered before OrbitControls so we can veto orbiting
    el.addEventListener('pointerdown', (e) => this._onDown(e));
    el.addEventListener('pointermove', (e) => this._onMove(e));
    el.addEventListener('pointerup', (e) => this._onUp(e));
    el.addEventListener('pointercancel', (e) => this._onCancel(e));
    el.addEventListener('pointerleave', () => { if (!this._gesture) this._setHover(null); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; });
    el.addEventListener('webglcontextrestored', () => { this.contextLost = false; this.needsRender = true; });
  }

  _initScene() {
    const scene = (this.scene = new THREE.Scene());
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = this.envTex;
    scene.environmentIntensity = 0.85;
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);

    this.hemi = new THREE.HemisphereLight(0xfff4e6, 0x3b3128, 0.55);
    scene.add(this.hemi);
    const key = (this.key = new THREE.DirectionalLight(0xfff0db, 2.3));
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 50 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.025;
    key.shadow.radius = 4;
    scene.add(key, key.target);
    this.rim = new THREE.DirectionalLight(0x9fbcff, 0.0);
    scene.add(this.rim);
    this._placeLights();

    const ground = (this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 90),
      new THREE.ShadowMaterial({ opacity: 0.22, transparent: true }),
    ));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = TABLE_Y;
    ground.receiveShadow = true;
    scene.add(ground);

    this.root = new THREE.Group();
    scene.add(this.root);
    const grain = canvasTexture(createGrainCanvas(7), { repeat: true });
    this.pieceMats = createPieceMaterials(grain, grain);
  }

  _placeLights() {
    const s = this.orientation === 'w' ? 1 : -1;
    // key light from the left and slightly behind -> shadows fall toward the viewer (visible)
    this.key.position.set(-9 * s, 12.5, -3.5 * s);
    this.rim.position.set(8 * s, 5, -9 * s);
  }

  _initBoard() {
    const g = (this.boardGroup = new THREE.Group());
    this.scene.add(g);
    this.sideMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.5, clearcoat: 0.45, clearcoatRoughness: 0.3 });
    const body = new THREE.Mesh(new RoundedBoxGeometry(TOP + 0.1, BOARD_H, TOP + 0.1, 4, 0.05), this.sideMat);
    body.position.y = -BOARD_H / 2;
    body.castShadow = true; body.receiveShadow = true;
    this.plinthMat = new THREE.MeshPhysicalMaterial({ color: 0x222222, roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.35 });
    const plinth = new THREE.Mesh(new RoundedBoxGeometry(TOP + 0.6, 0.12, TOP + 0.6, 4, 0.045), this.plinthMat);
    plinth.position.y = -BOARD_H - 0.06;
    plinth.castShadow = true; plinth.receiveShadow = true;
    const topGeo = new THREE.PlaneGeometry(TOP, TOP);
    topGeo.rotateX(-Math.PI / 2);
    this.topMat = new THREE.MeshPhysicalMaterial({ roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.16 });
    const top = new THREE.Mesh(topGeo, this.topMat);
    top.position.y = 0.002;
    top.receiveShadow = true;
    g.add(body, plinth, top);
  }

  _initHighlights() {
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    const mk = (color, opacity, y, map = null, geo = plane) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color, opacity, map, transparent: true, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      }));
      m.position.y = y; m.visible = false; m.renderOrder = 2;
      this.scene.add(m);
      return m;
    };
    this.hlFrom = mk(0xffd84d, 0.32, 0.006);
    this.hlTo = mk(0xffd84d, 0.42, 0.006);
    this.hlSel = mk(0x5fd38a, 0.42, 0.007);
    this.hlHover = mk(0xffffff, 0.9, 0.009, canvasTexture(createOutlineCanvas(), {}));
    const cgeo = new THREE.PlaneGeometry(1.6, 1.6);
    cgeo.rotateX(-Math.PI / 2);
    this.hlCheck = mk(0xffffff, 1, 0.008, canvasTexture(createRadialCanvas('rgba(255,45,45,0.95)', 'rgba(255,0,0,0)', 128, 0.12)), cgeo);
    this.dotGeo = new THREE.CircleGeometry(0.15, 40).rotateX(-Math.PI / 2);
    this.ringGeo = new THREE.RingGeometry(0.4, 0.47, 56).rotateX(-Math.PI / 2);
    this.markerMat = new THREE.MeshBasicMaterial({
      color: 0x1b4d2a, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.markers = [];
    // promotion / effect ring
    const rg = new THREE.RingGeometry(0.3, 0.42, 64).rotateX(-Math.PI / 2);
    this.fxRing = mk(0xfff2b0, 0, 0.012, null, rg);
    this.fxRing.material.blending = THREE.AdditiveBlending;
  }

  _initControls() {
    const c = (this.controls = new OrbitControls(this.camera, this.renderer.domElement));
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.enablePan = false;
    c.rotateSpeed = 0.7;
    c.zoomSpeed = 0.8;
    c.minPolarAngle = 0.0;
    c.maxPolarAngle = 1.32;
    c.target.set(0, 0, 0);
    c.addEventListener('start', () => { this._userCam = true; this._setHover(null); });
  }

  // ---------------------------------------------------------------- styling
  setBoardStyle(key) {
    if (!BOARD_STYLES[key]) key = 'walnut';
    this.styleKey = key;
    const st = BOARD_STYLES[key];
    let tex = this._styleCache.get(key);
    if (!tex) {
      const top = canvasTexture(createBoardTopCanvas(key, 2048), { aniso: Math.min(12, this.maxAniso) });
      const side = canvasTexture(createSideTexture(key), { repeat: true, aniso: 4 });
      side.repeat.set(2, 1);
      tex = { top, side };
      this._styleCache.set(key, tex);
    }
    this.topMat.map = tex.top; this.topMat.needsUpdate = true;
    this.sideMat.map = tex.side; this.sideMat.needsUpdate = true;
    this.plinthMat.color.set(shade(st.side, 0.75));
    this.hlFrom.material.color.setHex(st.hl.last);
    this.hlTo.material.color.setHex(st.hl.last);
    this.hlSel.material.color.setHex(st.hl.sel);
    this.markerMat.color.setHex(st.hl.dot);
    this.needsRender = true;
  }

  setTheme(theme) {
    this.theme = theme;
    const dark = theme === 'dark';
    this.hemi.intensity = dark ? 0.22 : 0.4;
    this.hemi.groundColor.set(dark ? 0x10131a : 0x3b3128);
    this.key.intensity = dark ? 2.9 : 2.6;
    this.key.color.set(dark ? 0xffe2bd : 0xfff0db);
    this.rim.intensity = dark ? 1.2 : 0.35;
    this.scene.environmentIntensity = dark ? 0.38 : 0.55;
    this.ground.material.opacity = dark ? 0.5 : 0.24;
    this.renderer.toneMappingExposure = dark ? 0.95 : 0.92;
    for (const m of this._spriteMats.values()) {
      const f = this._spriteTint(m.userData.color);
      m.color.setRGB(f, f, f * (m.userData.color === 'b' && f < 0.8 ? 1.08 : 1));
    }
    this.needsRender = true;
  }

  setAnimSpeed(v) { this.animSpeed = Math.max(0.25, v || 1); }
  setShowLegal(v) { this.showLegal = !!v; if (!v) this._hideMarkers(); }

  // ---------------------------------------------------------------- camera
  setOrientation(color, animate = true) {
    this.orientation = color === 'b' ? 'b' : 'w';
    this._placeLights();
    this.setView('default', animate);
  }

  _fitPoints() {
    const pts = [];
    const B = TOP / 2 + 0.3;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      pts.push(new THREE.Vector3(sx * B, TABLE_Y, sz * B));
      pts.push(new THREE.Vector3(sx * 3.5, 1.15, sz * 3.5));
    }
    if (this.camera.aspect > 1.05 && this.container.clientWidth >= 640) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        pts.push(new THREE.Vector3(sx * (TRAY_X + 0.35), TABLE_Y, sz * 4.4));
        pts.push(new THREE.Vector3(sx * (TRAY_X + 0.3), TABLE_Y + 0.75, sz * 4.4));
      }
    }
    return pts;
  }

  _fitDistance(polar, az) {
    const cam = this.camera.clone();
    const target = this.controls.target;
    const pts = this._fitPoints();
    const mx = 0.95, my = 0.92;
    let lo = 3, hi = 80;
    const sph = new THREE.Spherical();
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      sph.set(mid, Math.max(0.0001, polar), az);
      cam.position.setFromSpherical(sph).add(target);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      let ok = true;
      for (const p of pts) {
        const v = p.clone().project(cam);
        if (Math.abs(v.x) > mx || Math.abs(v.y) > my || v.z > 1) { ok = false; break; }
      }
      if (ok) hi = mid; else lo = mid;
    }
    return hi;
  }

  _viewParams(preset) {
    const az = this.orientation === 'w' ? 0 : Math.PI;
    if (preset === 'top') return { polar: 0.001, az };
    if (preset === 'low') return { polar: 1.1, az };
    return { polar: 0.8, az };
  }

  setView(preset = 'default', animate = true, dur = 900) {
    this.viewPreset = preset;
    this._userCam = false;
    const { polar, az } = this._viewParams(preset);
    const dist = this._fitDistance(polar, az);
    this.controls.minDistance = dist * 0.55;
    this.controls.maxDistance = dist * 1.9;
    this._animateCamera(polar, az, dist, animate ? dur : 0);
  }

  _animateCamera(polar, az, dist, dur, ease = Ease.inOutCubic) {
    const target = this.controls.target;
    const from = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(target));
    if (!isFinite(from.radius) || from.radius < 0.01) from.set(dist, polar, az);
    let dTheta = az - from.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    this.camTw.finish();
    const sph = new THREE.Spherical();
    return this.camTw.add({
      dur, ease,
      update: (e) => {
        sph.set(from.radius + (dist - from.radius) * e, Math.max(0.0001, from.phi + (polar - from.phi) * e), from.theta + dTheta * e);
        this.camera.position.setFromSpherical(sph).add(target);
        this.camera.lookAt(target);
      },
    }).promise;
  }

  intro() {
    const { polar, az } = this._viewParams('default');
    const dist = this._fitDistance(polar, az);
    const target = this.controls.target;
    const startS = new THREE.Spherical(dist * 1.45, 0.42, az + Math.PI * 0.6);
    this.camTw.finish();
    this.camera.position.setFromSpherical(startS).add(target);
    this.camera.lookAt(target);
    this.controls.minDistance = dist * 0.55;
    this.controls.maxDistance = dist * 1.9;
    this._userCam = false;
    this.viewPreset = 'default';
    return this._animateCamera(polar, az, dist, 2000, Ease.inOutSine);
  }

  setIdle(on) {
    this.idle = !!on;
    this.controls.enabled = !on;
    if (on) {
      this._clearSelect();
      const { az } = this._viewParams('default');
      const dist = this._fitDistance(0.92, az);
      this._animateCamera(0.92, this._idleTheta ?? az + 0.5, dist * 0.96, 0);
    }
    this.needsRender = true;
  }

  pause() { this.running = false; }
  resume() { this.running = true; this.needsRender = true; this._last = performance.now(); }

  get trayVisible() { return this.container.clientWidth >= 640; }

  _applyTrayVisibility() {
    const v = this.trayVisible;
    for (const c of ['w', 'b']) for (const o of this.trays[c]) o.group.visible = v;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._applyTrayVisibility();
    if (!this._userCam && !this.camTw.busy && !this.idle) {
      const { polar, az } = this._viewParams(this.viewPreset || 'default');
      const dist = this._fitDistance(polar, az);
      this.controls.minDistance = dist * 0.55;
      this.controls.maxDistance = dist * 1.9;
      const sph = new THREE.Spherical(dist, Math.max(0.0001, polar), az);
      this.camera.position.setFromSpherical(sph).add(this.controls.target);
      this.camera.lookAt(this.controls.target);
    }
    this.needsRender = true;
  }

  // ---------------------------------------------------------------- pieces
  _sqPos(sq, y = 0) {
    const { x, z } = sqToXZ(sq);
    return new THREE.Vector3(x, y, z);
  }

  _trayPos(capturer, i) {
    const s = capturer === 'w' ? 1 : -1;
    return new THREE.Vector3(s * TRAY_X, TABLE_Y, s * (4.15 - i * TRAY_STEP));
  }

  _yaw(type, color) {
    if (type === 'n') return color === 'w' ? Math.PI * (5 / 6) : -Math.PI / 6;
    return color === 'w' ? 0 : Math.PI;
  }

  _createPiece(type, color, square) {
    const group = new THREE.Group();
    const o = { id: ++this._pid, type, color, square, group, scale: 1 };
    this._buildVisual(o);
    if (square) group.position.copy(this._sqPos(square));
    this.root.add(group);
    return o;
  }

  _buildVisual(o) {
    for (const c of [...o.group.children]) o.group.remove(c);
    this._sprites.delete(o);
    o.bb = null;
    const set = this.sets[o.color];
    if (set && set.tex) { this._buildSprite(o, set); return; }
    const mesh = new THREE.Mesh(getPieceGeometries()[o.type], this.pieceMats[o.color]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.rotation.y = this._yaw(o.type, o.color);
    mesh.userData.piece = o;
    o.group.add(mesh);
    o.mesh = mesh;
    o.hits = [mesh];
  }

  // ---- image pieces: camera-facing sprite on a side-coloured base + role badge
  _spriteTint(color) {
    const same = this.sets.w && this.sets.b && this.sets.w.id === this.sets.b.id;
    let f = this.theme === 'dark' ? 0.9 : 1;
    if (same && color === 'b') f *= 0.58;
    return f;
  }

  _spriteMat(set, role, color) {
    const key = `${set.id}|${role}|${color}`;
    let m = this._spriteMats.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        map: set.tex[role], transparent: true, alphaTest: 0.12, toneMapped: false, side: THREE.DoubleSide,
      });
      m.userData = { color, setId: set.id };
      this._spriteMats.set(key, m);
    }
    const f = this._spriteTint(color);
    m.color.setRGB(f, f, f * (color === 'b' && f < 0.8 ? 1.08 : 1));
    return m;
  }

  _badgeMat(color, role) {
    const key = color + role + (this.roleIcons ? 'i' : 't');
    let m = this._badgeTex.get(key);
    if (m) return m;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const light = color === 'w';
    ctx.beginPath();
    ctx.arc(64, 64, 58, 0, Math.PI * 2);
    ctx.fillStyle = light ? '#f6efe2' : '#26211e';
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.strokeStyle = light ? '#b49a6b' : '#8f7d58';
    ctx.stroke();
    const icon = this.roleIcons?.[(light ? 'b' : 'w') + role];
    if (icon && icon.complete && icon.naturalWidth) {
      ctx.drawImage(icon, 14, 12, 100, 100);
    } else {
      const g = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }[role];
      ctx.fillStyle = light ? '#2a2420' : '#f4ecdf';
      ctx.font = '72px "Segoe UI Symbol", "Noto Sans Symbols 2", "Apple Symbols", serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(g + '︎', 64, 70);
    }
    const tex = canvasTexture(c, {});
    m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, depthWrite: false });
    this._badgeTex.set(key, m);
    return m;
  }

  _buildSprite(o, set) {
    const SIZE = { k: 1.2, q: 1.12, b: 1.04, n: 1.0, r: 0.96, p: 0.82 };
    const BASE = { k: 1, q: 1, b: 0.96, n: 0.96, r: 0.96, p: 0.86 };
    const base = new THREE.Mesh(this._spriteBaseGeo, this.pieceMats[o.color]);
    base.scale.set(BASE[o.type], 1, BASE[o.type]);
    base.castShadow = true;
    base.receiveShadow = true;
    base.userData.piece = o;
    const bb = new THREE.Group();
    bb.position.y = 0.06;
    const aspect = set.aspect[o.type] || 1;
    let h = SIZE[o.type] * set.scale;
    let w = h * aspect;
    const maxW = 1.0 * set.scale;
    if (w > maxW) { w = maxW; h = w / aspect; }
    const plane = new THREE.Mesh(this._unitPlane, this._spriteMat(set, o.type, o.color));
    plane.scale.set(set.flip && o.color === 'b' ? -w : w, h, 1);
    plane.castShadow = true;
    plane.userData.piece = o;
    plane.renderOrder = 1;
    bb.add(plane);
    if (set.badge) {
      const badge = new THREE.Mesh(this._badgeGeo, this._badgeMat(o.color, o.type));
      const bs = 0.3;
      badge.scale.setScalar(bs);
      badge.position.set(Math.min(w / 2, 0.42) - bs * 0.25, Math.max(h - bs * 0.35, bs * 0.9), 0.02);
      badge.renderOrder = 2;
      bb.add(badge);
    }
    bb.quaternion.copy(this.camera.quaternion);
    o.group.add(base, bb);
    o.mesh = base;
    o.bb = bb;
    o.hits = [plane, base];
    this._sprites.add(o);
  }

  /** sets: { w: preparedSet|null, b: preparedSet|null } — null = classic 3D pieces */
  setPieceSets(sets) {
    const w = sets?.w || null, b = sets?.b || null;
    if (this.sets.w === w && this.sets.b === b) return;
    this._clearSelect();
    this.tw.finish('piece');
    this.tw.finish('ui');
    this.sets = { w, b };
    const all = [...this.bySquare.values(), ...this.trays.w, ...this.trays.b];
    for (const o of all) this._buildVisual(o);
    this.needsRender = true;
  }

  setRoleIcons(map) {
    if (!map) return;
    const icons = {};
    for (const [k, url] of Object.entries(map)) { const img = new Image(); img.src = url; icons[k] = img; }
    this.roleIcons = icons;
    this._badgeTex.clear();
  }

  _dropGroup(o) {
    this.root.remove(o.group);
    this._sprites.delete(o);
  }

  _removePiece(o, animate) {
    if (!animate) { this._dropGroup(o); return; }
    const s0 = o.group.scale.x, y0 = o.group.position.y;
    this.tw.add({
      tag: 'piece', dur: 220 / this.animSpeed, ease: Ease.inCubic,
      update: (e) => { o.group.scale.setScalar(Math.max(0.001, s0 * (1 - e))); o.group.position.y = y0 - e * 0.2; },
      done: () => this._dropGroup(o),
    });
  }

  _appear(o, mode, delay = 0) {
    const g = o.group, s = o.scale;
    if (!mode) { g.scale.setScalar(s); return; }
    if (mode === 'drop') {
      const end = g.position.clone();
      const h0 = 3.2 + Math.random() * 1.2;
      g.position.y = end.y + h0;
      g.visible = false;
      this.tw.add({
        tag: 'piece', delay, dur: 620 / this.animSpeed, ease: Ease.outBounce,
        begin: () => { g.visible = true; },
        update: (e) => { g.position.y = end.y + h0 * (1 - e); },
        done: () => { g.position.copy(end); g.visible = true; },
      });
      return;
    }
    g.scale.setScalar(0.001);
    this.tw.add({
      tag: 'piece', delay, dur: 300 / this.animSpeed, ease: Ease.outBack,
      update: (e) => g.scale.setScalar(Math.max(0.001, s * e)),
      done: () => g.scale.setScalar(s),
    });
  }

  _slide(o, to, animate) {
    const g = o.group;
    const end = to.clone();
    if (!animate) { g.position.copy(end); return; }
    const start = g.position.clone();
    const d = start.distanceTo(end);
    const h = 0.15 + Math.min(d, 6) * 0.05;
    this.tw.add({
      tag: 'piece', dur: (240 + Math.min(d, 7) * 40) / this.animSpeed, ease: Ease.linear,
      update: (k) => {
        const e = Ease.inOutCubic(k);
        g.position.lerpVectors(start, end, e);
        g.position.y += 4 * h * e * (1 - e);
      },
      done: () => g.position.copy(end),
    });
  }

  /**
   * Sync the board to a position (array from chess.js board()).
   * animate: false | true (slide/pop) | 'drop' (pieces fall in)
   */
  setPosition(board, { animate = true, captured = null } = {}) {
    this.tw.finish('piece');
    this._clearSelect();
    const want = new Map();
    for (const row of board) for (const c of row) if (c) want.set(c.square, c);
    const next = new Map();
    const free = [];
    for (const [sq, o] of this.bySquare) {
      const w = want.get(sq);
      if (w && w.type === o.type && w.color === o.color) {
        next.set(sq, o); want.delete(sq);
        o.group.position.copy(this._sqPos(sq)); o.group.quaternion.identity(); o.group.scale.setScalar(1);
      } else free.push(o);
    }
    let i = 0;
    const order = [...want.entries()].sort((a, b) => (a[0][1] - b[0][1]) || (a[0].charCodeAt(0) - b[0].charCodeAt(0)));
    for (const [sq, w] of order) {
      let best = null, bd = Infinity;
      if (animate !== 'drop') {
        for (const o of free) {
          if (o.type === w.type && o.color === w.color) {
            const d = sqDist(o.square, sq);
            if (d < bd) { bd = d; best = o; }
          }
        }
      }
      if (best) {
        free.splice(free.indexOf(best), 1);
        best.square = sq;
        best.group.quaternion.identity(); best.group.scale.setScalar(1);
        next.set(sq, best);
        this._slide(best, this._sqPos(sq), !!animate);
      } else {
        const o = this._createPiece(w.type, w.color, sq);
        next.set(sq, o);
        const rank = +sq[1];
        const wave = animate === 'drop' ? (w.color === 'w' ? rank - 1 : 8 - rank) * 70 + Math.random() * 120 : 0;
        this._appear(o, animate ? (animate === 'drop' ? 'drop' : 'pop') : null, wave);
      }
      i++;
    }
    for (const o of free) this._removePiece(o, !!animate && animate !== 'drop');
    this.bySquare = next;
    if (captured) this.setCaptured(captured, !!animate && animate !== 'drop');
    this.needsRender = true;
  }

  setCaptured(caps, animate = false) {
    for (const c of ['w', 'b']) {
      const want = caps[c] || [];
      const have = this.trays[c];
      let i = 0;
      while (i < want.length && i < have.length && have[i].type === want[i]) i++;
      for (const o of have.splice(i)) this._removePiece(o, animate);
      for (let j = i; j < want.length; j++) {
        const o = this._createPiece(want[j], c === 'w' ? 'b' : 'w', null);
        o.scale = TRAY_SCALE;
        o.group.position.copy(this._trayPos(c, j));
        o.group.scale.setScalar(TRAY_SCALE);
        o.group.visible = this.trayVisible;
        this._appear(o, animate ? 'pop' : null, j * 30);
        have.push(o);
      }
    }
    this.needsRender = true;
  }

  clearAll() {
    this.tw.finish('piece');
    this._clearSelect();
    for (const o of this.bySquare.values()) this._dropGroup(o);
    for (const c of ['w', 'b']) for (const o of this.trays[c]) this._dropGroup(o);
    for (const ch of [...this.root.children]) this.root.remove(ch);
    this._sprites.clear();
    this.bySquare = new Map();
    this.trays = { w: [], b: [] };
    this.setLastMove(null);
    this.setCheck(null);
    this.needsRender = true;
  }

  _arc(o, end, { dur, delay = 0, h, knight = false, tag = 'piece' }) {
    const g = o.group;
    const start = g.position.clone();
    const dir = new THREE.Vector3(end.x - start.x, 0, end.z - start.z);
    const len = dir.length();
    const axis = len > 1e-4 ? new THREE.Vector3(dir.z / len, 0, -dir.x / len) : new THREE.Vector3(1, 0, 0);
    const q = new THREE.Quaternion();
    return this.tw.add({
      tag, dur, delay, ease: Ease.linear,
      begin: () => start.copy(g.position),
      update: (k) => {
        const e = Ease.inOutCubic(k);
        g.position.lerpVectors(start, end, e);
        g.position.y += 4 * h * e * (1 - e);
        const lean = knight ? Math.sin(Math.PI * k) * 0.32 : -Math.sin(Math.PI * 2 * k) * 0.09;
        q.setFromAxisAngle(axis, lean);
        g.quaternion.copy(q);
      },
      done: () => { g.position.copy(end); g.quaternion.identity(); },
    });
  }

  _squash(o, delay) {
    const g = o.group;
    this.tw.add({
      tag: 'piece', dur: 170, delay,
      update: (k) => {
        const s = Math.sin(k * Math.PI) * 0.07;
        g.scale.set(o.scale * (1 + s * 0.5), o.scale * (1 - s), o.scale * (1 + s * 0.5));
      },
      done: () => g.scale.setScalar(o.scale),
    });
  }

  _toTray(victim, capturer, delay) {
    const list = this.trays[capturer];
    const idx = list.length;
    list.push(victim);
    victim.square = null;
    const end = this._trayPos(capturer, idx);
    const g = victim.group;
    const sp = this.animSpeed;
    const start = new THREE.Vector3();
    const spin = (Math.random() < 0.5 ? -1 : 1) * (Math.PI * (1 + Math.random()));
    const yaw0 = victim.mesh.rotation.y;
    const axis = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
    const q = new THREE.Quaternion();
    // knocked: small hop + wobble, then fly to tray
    this.tw.add({
      tag: 'piece', delay, dur: 700 / sp, ease: Ease.linear,
      begin: () => start.copy(g.position),
      update: (k) => {
        const e = Ease.inOutCubic(k);
        g.position.lerpVectors(start, end, e);
        g.position.y += 4 * 1.7 * e * (1 - e);
        const s = 1 + (TRAY_SCALE - 1) * e;
        g.scale.setScalar(s);
        victim.mesh.rotation.y = yaw0 + spin * e;
        q.setFromAxisAngle(axis, Math.sin(Math.PI * k) * 0.9);
        g.quaternion.copy(q);
      },
      done: () => {
        g.position.copy(end); g.quaternion.identity(); victim.scale = TRAY_SCALE; g.scale.setScalar(TRAY_SCALE);
        victim.mesh.rotation.y = yaw0 + spin;
        g.visible = this.trayVisible;
      },
    });
    this._squash(victim, delay + 700 / sp);
    this.tw.add({ tag: 'piece', dur: 1, delay: delay + 700 / sp, done: () => this.onSound('tray') });
  }

  /** Animate a chess.js verbose move. Returns a promise resolved when done. */
  playMove(m, { instant = false } = {}) {
    this.tw.finish('piece');
    this._clearSelect(true);
    const o = this.bySquare.get(m.from);
    if (!o) return Promise.resolve(false);
    const sp = this.animSpeed;
    const flags = m.flags || '';
    let victimSq = null;
    if (flags.includes('e')) victimSq = m.to[0] + m.from[1];
    else if (m.captured) victimSq = m.to;
    const victim = victimSq ? this.bySquare.get(victimSq) : null;
    this.bySquare.delete(m.from);
    if (victimSq) this.bySquare.delete(victimSq);
    this.bySquare.set(m.to, o);
    o.square = m.to;

    const d = sqDist(m.from, m.to);
    const knight = o.type === 'n';
    const dur = (knight ? 520 : 270 + Math.min(d, 7) * 45) / sp;
    const h = knight ? 0.95 : 0.24 + Math.min(d, 7) * 0.055;
    const last = this._arc(o, this._sqPos(m.to), { dur, h, knight });
    this._squash(o, dur);
    let total = dur + 170;

    if (victim) {
      this._toTray(victim, m.color, dur * 0.82);
      total = Math.max(total, dur * 0.82 + 900 / sp);
    }
    if (flags.includes('k') || flags.includes('q')) {
      const r = m.from[1];
      const [rf, rt] = flags.includes('k') ? ['h' + r, 'f' + r] : ['a' + r, 'd' + r];
      const rook = this.bySquare.get(rf);
      if (rook) {
        this.bySquare.delete(rf);
        this.bySquare.set(rt, rook);
        rook.square = rt;
        const rd = 330 / sp;
        this._arc(rook, this._sqPos(rt), { dur: rd, delay: dur * 0.45, h: 0.75 });
        this._squash(rook, dur * 0.45 + rd);
        total = Math.max(total, dur * 0.45 + rd + 170);
      }
    }
    let sound = victim ? 'capture' : flags.includes('k') || flags.includes('q') ? 'castle' : 'move';
    if (m.promotion) {
      const np = this._createPiece(m.promotion, o.color, m.to);
      np.group.scale.setScalar(0.001);
      np.group.visible = false;
      this.bySquare.set(m.to, np);
      const t0 = dur + 60 / sp;
      this.tw.add({
        tag: 'piece', delay: t0, dur: 200 / sp, ease: Ease.inCubic,
        update: (e) => { o.group.scale.setScalar(Math.max(0.001, 1 - e)); o.group.position.y = e * 0.15; },
        done: () => this._dropGroup(o),
      });
      this.tw.add({
        tag: 'piece', delay: t0 + 140 / sp, dur: 420 / sp, ease: Ease.outBack,
        begin: () => { np.group.visible = true; },
        update: (e) => np.group.scale.setScalar(Math.max(0.001, e)),
        done: () => { np.group.visible = true; np.group.scale.setScalar(1); },
      });
      this._ringFx(m.to, t0 + 100 / sp);
      this.tw.add({ tag: 'piece', dur: 1, delay: t0 + 140 / sp, done: () => this.onSound('promote') });
      total = Math.max(total, t0 + 600 / sp);
    }
    this.tw.add({ tag: 'piece', dur: 1, delay: dur, done: () => this.onSound(sound, m) });
    this.needsRender = true;
    const p = new Promise((res) => setTimeout(() => res(true), instant ? 0 : total));
    if (instant) this.tw.finish('piece');
    void last;
    return p;
  }

  _ringFx(sq, delay) {
    const r = this.fxRing;
    const p = this._sqPos(sq);
    this.tw.add({
      tag: 'fx', delay, dur: 650 / this.animSpeed, ease: Ease.outCubic,
      begin: () => { r.position.set(p.x, 0.012, p.z); r.visible = true; },
      update: (e) => { r.scale.setScalar(0.6 + e * 1.6); r.material.opacity = 0.9 * (1 - e); },
      done: () => { r.visible = false; },
    });
  }

  topple(square) {
    const o = this.bySquare.get(square);
    if (!o) return;
    const g = o.group;
    const R = pieceRadius(o.type) * 0.98;
    const { x, z } = sqToXZ(square);
    const dir = x <= 0 ? 1 : -1;
    const pivot = new THREE.Vector3(x + dir * R, 0, z);
    const rel0 = new THREE.Vector3(-dir * R, 0, 0);
    const final = THREE.MathUtils.degToRad(80);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const q = new THREE.Quaternion();
    // wobble, then fall
    this.tw.add({
      tag: 'fx', delay: 350, dur: 420, ease: Ease.linear,
      update: (k) => {
        const a = Math.sin(k * Math.PI * 3) * 0.06 * (1 - k);
        q.setFromAxisAngle(zAxis, a);
        g.quaternion.copy(q);
      },
    });
    this.tw.add({
      tag: 'fx', delay: 780, dur: 950, ease: Ease.outBounce,
      update: (e) => {
        const ang = -dir * final * e;
        q.setFromAxisAngle(zAxis, ang);
        const rel = rel0.clone().applyQuaternion(q);
        g.position.copy(pivot).add(rel);
        g.quaternion.copy(q);
      },
    });
    this.tw.add({ tag: 'fx', dur: 1, delay: 780 + 950 * 0.36, done: () => this.onSound('thud') });
  }

  celebrate(square) {
    const o = this.bySquare.get(square);
    if (!o) return;
    const g = o.group;
    const base = g.position.y;
    for (let i = 0; i < 2; i++) {
      this.tw.add({
        tag: 'fx', delay: 900 + i * 420, dur: 380, ease: Ease.linear,
        update: (k) => { g.position.y = base + Math.sin(Math.PI * k) * 0.35; },
        done: () => { g.position.y = base; },
      });
      this._squash(o, 900 + i * 420 + 380);
    }
  }

  // ------------------------------------------------------------ highlights
  _place(mesh, sq, y) {
    if (!sq) { mesh.visible = false; return; }
    const p = this._sqPos(sq);
    mesh.position.set(p.x, y ?? mesh.position.y, p.z);
    mesh.visible = true;
  }

  setLastMove(from, to) {
    this._place(this.hlFrom, from);
    this._place(this.hlTo, to);
    this.needsRender = true;
  }

  setCheck(square) {
    this.checkSq = square || null;
    this._place(this.hlCheck, square);
    this.needsRender = true;
  }

  _setHover(sq) {
    if (this._hoverSq === sq) return;
    this._hoverSq = sq;
    this._place(this.hlHover, sq);
    this.needsRender = true;
  }

  _showMarkers(list) {
    this._hideMarkers();
    if (!this.showLegal) return;
    list.forEach((t, i) => {
      let m = this.markers[i];
      if (!m) {
        m = { dot: new THREE.Mesh(this.dotGeo, this.markerMat), ring: new THREE.Mesh(this.ringGeo, this.markerMat) };
        m.dot.renderOrder = m.ring.renderOrder = 3;
        m.dot.visible = m.ring.visible = false;
        this.scene.add(m.dot, m.ring);
        this.markers.push(m);
      }
      const mesh = t.capture ? m.ring : m.dot;
      const p = this._sqPos(t.to);
      mesh.position.set(p.x, 0.01, p.z);
      mesh.visible = true;
      mesh.scale.setScalar(0.01);
      this.tw.add({ tag: 'ui', dur: 160, delay: i * 12, ease: Ease.outBack, update: (e) => mesh.scale.setScalar(Math.max(0.01, e)) });
    });
    this.needsRender = true;
  }

  _hideMarkers() {
    this.tw.finish('ui');
    for (const m of this.markers) { m.dot.visible = false; m.ring.visible = false; }
    this.needsRender = true;
  }

  // ------------------------------------------------------------ interaction
  setInteraction(opts) {
    this.inter = { ...this.inter, ...opts };
    if (!this.inter.enabled) { this._clearSelect(); this._setHover(null); this.renderer.domElement.style.cursor = ''; }
  }

  _select(o) {
    if (this.selected === o) return;
    this._clearSelect();
    this.selected = o;
    this._place(this.hlSel, o.square);
    const targets = this.inter.getTargets(o.square) || [];
    this.targets = new Map(targets.map((t) => [t.to, t]));
    this._showMarkers(targets);
    const g = o.group;
    const y0 = g.position.y;
    this.tw.add({ tag: 'ui', dur: 140, ease: Ease.outCubic, update: (e) => { g.position.y = y0 + (LIFT - y0) * e; } });
    this.onSound('pick');
  }

  _clearSelect(keepPosition = false) {
    const o = this.selected;
    this.selected = null;
    this.targets = new Map();
    this.hlSel.visible = false;
    this._hideMarkers();
    this._setHover(null);
    if (o && !keepPosition && this.bySquare.get(o.square) === o) {
      const g = o.group;
      const start = g.position.clone();
      const end = this._sqPos(o.square);
      this.tw.add({
        tag: 'piece', dur: 160, ease: Ease.outCubic,
        update: (e) => { g.position.lerpVectors(start, end, e); },
        done: () => { g.position.copy(end); g.quaternion.identity(); },
      });
    }
    this.needsRender = true;
  }

  deselect() { this._clearSelect(); }

  _setNdc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  _rayPlane(y) {
    const { origin, direction } = this.raycaster.ray;
    if (Math.abs(direction.y) < 1e-6) return null;
    const t = (y - origin.y) / direction.y;
    if (t < 0) return null;
    return origin.clone().addScaledVector(direction, t);
  }

  _pick(e) {
    this._setNdc(e);
    const meshes = [];
    for (const o of this.bySquare.values()) meshes.push(...(o.hits || [o.mesh]));
    const hits = this.raycaster.intersectObjects(meshes, false);
    const hitPiece = hits.length ? hits[0].object.userData.piece : null;
    const pt = this._rayPlane(0);
    const sqOnBoard = pt ? xzToSq(pt.x, pt.z) : null;
    return { hitPiece, square: sqOnBoard, point: pt };
  }

  _onDown(e) {
    if (!this.inter.enabled || this.idle || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (this._gesture) return;
    const { hitPiece, square } = this._pick(e);
    // 1) a target square (or an enemy piece standing on a target) -> move
    const targetSq = hitPiece && this.targets.has(hitPiece.square) ? hitPiece.square : (square && this.targets.has(square) ? square : null);
    if (this.selected && targetSq) {
      this.controls.enabled = false;
      this._gesture = { type: 'target', square: targetSq, id: e.pointerId };
      return;
    }
    // 2) own piece -> select / start drag
    const cand = hitPiece || (square ? this.bySquare.get(square) : null);
    if (cand && this.inter.canPick(cand.color, cand.square)) {
      this.controls.enabled = false;
      const was = this.selected === cand;
      this._select(cand);
      this._gesture = { type: 'piece', piece: cand, x: e.clientX, y: e.clientY, dragging: false, was, id: e.pointerId };
      try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }
    // 3) anything else: clear selection, allow orbit
    if (this.selected) this._clearSelect();
  }

  _onMove(e) {
    const g = this._gesture;
    if (g && g.type === 'piece' && e.pointerId === g.id) {
      if (!g.dragging && Math.hypot(e.clientX - g.x, e.clientY - g.y) > 6) {
        g.dragging = true;
        this.tw.finish('ui');
        this.renderer.domElement.style.cursor = 'grabbing';
      }
      if (g.dragging) {
        this._setNdc(e);
        const pt = this._rayPlane(0);
        if (pt) {
          const lim = 4.6;
          pt.x = Math.max(-lim, Math.min(lim, pt.x));
          pt.z = Math.max(-lim, Math.min(lim, pt.z));
          const grp = g.piece.group;
          const prev = grp.position.clone();
          grp.position.set(pt.x, DRAG_H, pt.z);
          // lean in the direction of travel
          const v = new THREE.Vector3(pt.x - prev.x, 0, pt.z - prev.z);
          const sp = Math.min(1, v.length() * 4);
          if (sp > 0.001) {
            v.normalize();
            const axis = new THREE.Vector3(v.z, 0, -v.x);
            grp.quaternion.slerp(new THREE.Quaternion().setFromAxisAngle(axis, -0.35 * sp), 0.35);
          } else grp.quaternion.slerp(new THREE.Quaternion(), 0.2);
          const sq = xzToSq(pt.x, pt.z);
          this._setHover(sq && this.targets.has(sq) ? sq : null);
          this.needsRender = true;
        }
      }
      return;
    }
    if (g || !this.inter.enabled || this.idle || e.pointerType !== 'mouse') return;
    // hover feedback (mouse only)
    const { hitPiece, square } = this._pick(e);
    const tgt = hitPiece && this.targets.has(hitPiece.square) ? hitPiece.square : square && this.targets.has(square) ? square : null;
    const cand = hitPiece || (square ? this.bySquare.get(square) : null);
    let cursor = '';
    if (this.selected && tgt) { cursor = 'pointer'; this._setHover(tgt); }
    else if (cand && cand !== this.selected && this.inter.canPick(cand.color, cand.square)) {
      cursor = 'grab';
      this._setHover(cand.square);
    } else this._setHover(null);
    this.renderer.domElement.style.cursor = cursor;
  }

  _onUp(e) {
    const g = this._gesture;
    if (!g || e.pointerId !== g.id) return;
    this._gesture = null;
    this.controls.enabled = !this.idle;
    try { this.renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    this.renderer.domElement.style.cursor = '';
    if (g.type === 'target') {
      const { hitPiece, square } = this._pick(e);
      const sq = hitPiece && this.targets.has(hitPiece.square) ? hitPiece.square : square;
      if (sq === g.square && this.selected) this._commit(this.selected.square, sq, false);
      return;
    }
    if (g.type === 'piece') {
      if (g.dragging) {
        const grp = g.piece.group;
        const sq = xzToSq(grp.position.x, grp.position.z);
        this._setHover(null);
        if (sq && this.targets.has(sq)) this._commit(g.piece.square, sq, true);
        else {
          // snap back, keep selection
          const start = grp.position.clone();
          const end = this._sqPos(g.piece.square, LIFT);
          this.tw.add({
            tag: 'ui', dur: 200, ease: Ease.outCubic,
            update: (k) => { grp.position.lerpVectors(start, end, k); grp.quaternion.slerp(new THREE.Quaternion(), k); },
            done: () => grp.quaternion.identity(),
          });
          if (sq && sq !== g.piece.square) this.onSound('illegal');
        }
      } else if (g.was) {
        this._clearSelect();
      }
    }
  }

  _onCancel(e) {
    const g = this._gesture;
    if (!g || e.pointerId !== g.id) return;
    this._gesture = null;
    this.controls.enabled = !this.idle;
    if (g.type === 'piece') this._clearSelect();
  }

  _commit(from, to, dropped) {
    const piece = this.bySquare.get(from);
    const res = this.inter.onMove(from, to, { dropped });
    if (res === 'pending') {
      // keep the piece hovering over the destination until the controller decides
      this._pending = { piece, from };
      this._hideMarkers();
      const p = this._sqPos(to, LIFT);
      const grp = piece.group;
      const start = grp.position.clone();
      this.tw.add({ tag: 'ui', dur: 160, update: (k) => grp.position.lerpVectors(start, p, k) });
      return;
    }
    if (!res) this._clearSelect();
  }

  cancelPending() {
    const pd = this._pending;
    this._pending = null;
    if (!pd) return;
    this.selected = pd.piece;
    this._clearSelect();
  }

  clearPending() { this._pending = null; }

  // ------------------------------------------------------------------ loop
  _loop(now) {
    requestAnimationFrame(this._loop);
    if (!this.running || this.contextLost) return;
    const dt = Math.min(0.05, (now - (this._last || now)) / 1000);
    this._last = now;
    let dirty = this.needsRender;
    if (this.tw.update(now)) dirty = true;
    if (this.camTw.update(now)) dirty = true;
    else if (this.idle) {
      const t = this.controls.target;
      const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(t));
      s.theta += dt * 0.11;
      this._idleTheta = s.theta;
      this.camera.position.setFromSpherical(s).add(t);
      this.camera.lookAt(t);
      dirty = true;
    } else if (this.controls.update()) dirty = true;
    if (this.checkSq) {
      this.hlCheck.material.opacity = 0.62 + Math.sin(now / 210) * 0.3;
      dirty = true;
    }
    const sel = this.selected;
    if (sel && !this._gesture?.dragging && !this._pending && !this.tw.busy) {
      sel.group.position.y = LIFT + Math.sin(now / 260) * 0.018;
      dirty = true;
    }
    if (dirty) {
      if (this._sprites.size) {
        const q = this.camera.quaternion;
        for (const o of this._sprites) o.bb.quaternion.copy(q);
      }
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  }
}

// --------------------------------------------------------------- thumbnails
export function renderPieceThumbnails(size = 112) {
  let r;
  try {
    r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return null;
  }
  r.setPixelRatio(1);
  r.setSize(size, size, false);
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.1;
  r.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(r);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.9;
  const key = new THREE.DirectionalLight(0xfff1de, 2.2);
  key.position.set(-2.5, 4, 3.5);
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0x404040, 0.5));
  const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  const grain = canvasTexture(createGrainCanvas(7), { repeat: true });
  const mats = createPieceMaterials(grain, grain);
  const geos = getPieceGeometries();
  const out = {};
  for (const color of ['w', 'b']) {
    for (const type of ['k', 'q', 'r', 'b', 'n', 'p']) {
      const mesh = new THREE.Mesh(geos[type], mats[color]);
      if (type === 'n') mesh.rotation.y = Math.PI * 0.92;
      scene.add(mesh);
      const h = pieceHeight(type);
      const cy = h * 0.5;
      const dist = 2.75;
      cam.position.set(0, cy + dist * 0.32, dist);
      cam.lookAt(0, cy * 0.92, 0);
      r.render(scene, cam);
      out[color + type] = r.domElement.toDataURL('image/png');
      scene.remove(mesh);
    }
  }
  grain.dispose();
  mats.w.dispose(); mats.b.dispose();
  r.dispose();
  try { r.forceContextLoss(); } catch { /* ignore */ }
  return out;
}
