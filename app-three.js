// Railway Line Waves — rails + lane sim, with wobble & ink trap shape effects.
//
// Stripped to: lane simulator (sim.js) + rail bodies + per-rail Y wobble +
// ink trap hills. No sleepers, stations, patches, gradients, grain, presets.
//
// Loaded as a non-module <script>; THREE comes from the CDN global.

// Hard cap on the number of distinct rail "layers" the shader carries.
// Mirrors the GLSL `#define MAX_LANE_BUCKETS` and bounds the laneColors
// uniform array.
const MAX_LANE_BUCKETS = 9;

// HSL-spread defaults so each lane has a distinct hue out of the box. The
// user can override any one via the Lane colors pickers.
function defaultLaneColors(n) {
  const out = [];
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    c.setHSL(i / n, 0.62, 0.5);
    out.push('#' + c.getHexString());
  }
  return out;
}

// Curated palettes — name → array of MAX_LANE_BUCKETS hex colours. Picking
// one in the dropdown copies these straight into CONFIG.laneColors.
const PALETTES = {
  pastel: ['#ffadad','#ffd6a5','#fdffb6','#caffbf','#9bf6ff','#a0c4ff','#bdb2ff','#ffc6ff','#fffffc'],
  neon:   ['#ff006e','#fb5607','#ffbe0b','#06ffa5','#00b4d8','#3a86ff','#8338ec','#ff4d6d','#9d4edd'],
  earth:  ['#3a2e1f','#6f4e37','#a0522d','#cd853f','#deb887','#d2b48c','#bc8f8f','#f5deb3','#fff8dc'],
  sunset: ['#03071e','#370617','#6a040f','#9d0208','#d00000','#dc2f02','#e85d04','#f48c06','#ffba08'],
  ocean:  ['#03045e','#023e8a','#0077b6','#0096c7','#00b4d8','#48cae4','#90e0ef','#ade8f4','#caf0f8'],
  mono:   ['#0e0e0e','#262626','#3d3d3d','#555555','#6e6e6e','#888888','#a3a3a3','#bfbfbf','#dcdcdc'],
};

// ── Config ────────────────────────────────────────────────────────────────
const CONFIG = {
  speed:        0,        // world units / second — advances cameraX
  viewZoom:     0.57,
  segW:         1500,     // segment width in world units (matches SIM.SEG_W)
  laneSpace:    216,      // vertical distance between lanes
  railWidth:    4,        // rail half-thickness in world units
  // Soft body profile. railSoft = 0 → crisp SDF; 1 → full Gaussian halo.
  // railSigma = Gaussian sigma as a fraction of the rail half-width.
  railSoft:     0.19,
  railSigma:    0.61,
  railOpacity:  1.0,
  bgColor:      '#f4f3ea',

  // Rail body profile.
  //   0 = Gaussian halo (default — uses railSoft + railSigma)
  //   1 = Figma 6-stop vertical gradient (uses laneShoulderColors +
  //       railEdgeColor below; the body itself has soft transparent
  //       edges with a pastel shoulder around a saturated core, exactly
  //       matching figma's <linearGradient> with stops at 0/0.1/0.39/
  //       0.61/0.9/1.0). railSoft / railSigma are unused in this mode.
  railProfile:        0,
  laneShoulderColors: defaultLaneColors(MAX_LANE_BUCKETS),
  railEdgeColor:      '#C9C6BC',
  // Figma profile thresholds (only meaningful when railProfile === 'figma').
  // Both in normalized 0..1 of the rail's half-thickness (du), 0 = center,
  // 1 = body edge. Defaults match the figma "colour exploration 46" stops:
  //   profileCore     = 0.22  ↔  figma stops at offset 0.39 / 0.61
  //   profileShoulder = 0.80  ↔  figma stops at offset 0.10 / 0.90
  profileCore:     0.22,
  profileShoulder: 0.80,

  // Per-lane hue blending — each rail (owner-lane group) gets a distinct
  // color and is composited onto the running destination using the chosen
  // blend mode. Layering shows up where rails overlap (split/merge zones).
  blendMode:    'normal',  // normal | multiply | screen | darken | lighten
                           // | overlay | difference | plus-lighter
  laneColors:   defaultLaneColors(MAX_LANE_BUCKETS),

  // Palette HSL spread — hue offset wraps the spread around the colour
  // wheel; sat/light are applied uniformly. Editing any of these regenerates
  // CONFIG.laneColors from the HSL formula. Editing an individual swatch
  // overrides that one rail until the next regenerate.
  paletteHueOffset: 0.0,
  paletteSat:       0.62,
  paletteLight:     0.5,

  // ── Ticks — periodic gaps along every rail. Useful as a visual anchor
  // and as a zoetrope/wagon-wheel target: at speed = tickSpacing × frame
  // rate the gaps appear stationary; at small offsets they crawl forward
  // or backward like a strobed wheel.
  tickAmount:    0,        // 0 = no gaps, 1 = full clear gap at each tick
  tickSpacing:   100,      // world units between ticks
  tickWidth:     30,       // gap width in world units (along the rail)
  tickColor:     '#F1EFE8',// colour painted into the tick gap (defaults to
                           // bg so existing presets keep their look — change
                           // this to make ticks read as visible markers).
  tickMotionBlur: 0,       // 0 = crisp ticks (may strobe off-freeze at high
                           // speed); 1 = full motion-blur (ticks widen to
                           // cover one frame of camera travel — non-flicker
                           // but soft fat bars).

  // ── Ink traps — periodic asymmetric hills along each rail ────────────
  // Per-rail random pattern (hash of segment idx × lane Y). Each trap
  // shifts the rail's edge by a Gaussian profile so the rail "swells" out.
  inkTrapAmount:    0,        // peak hill height (world units; 0 = off)
  inkTrapSpacing:   1050,     // average distance between trap candidates
  inkTrapDensity:   0.45,     // 0..1 — probability a candidate slot fires
  inkTrapWidth:     368,      // hill half-width (world units)
  inkTrapDirection: 0.28,     // 0 = all upward, 1 = all downward, 0.5 = mixed

  // ── Bursts ────────────────────────────────────────────────────────────────
  // Finite painterly slugs of saturated colour layered on top of the desat
  // rail base. Each rail picks its own bursts (rid is part of the hash seed)
  // and scrolls them at its own velocity, so the rows desync in true Ikeda-
  // data-stream fashion. The X-envelope reuses figmaProfileAlpha so a burst
  // looks isotropic — same shoulder fall-off along X as the rail has along Y.
  burstAmount:      0,        // 0 = off, 1 = full saturation when a burst hits
  burstDensity:     0.5,      // 0..1 — fraction of cells that fire
  burstCell:        600,      // average cell width in world units
  burstLenMin:      0.25,     // shortest burst as fraction of cell (0..1)
  burstLenMax:      0.85,     // longest burst as fraction of cell (0..1)
  burstSpeed:       800,      // burst x-velocity in world units / second
  burstRailSpread:  0.6,      // 0 = all rails same speed, 1 = ±100% jitter per rail
  burstColor:       '#DE4D0E',// accent colour painted into the rail body
  burstLockToRail:  false,    // false = mode A (bursts drift at own velocity),
                              //  true = mode B (bursts pinned to rail flow,
                              //  per-rail X-scale acts as a parallax)

  // ── Phasing pills — single-group sleepers along a straight rail.
  // The simulator emits one rail forever; the renderer paints repeating
  // capsule "sleepers" inside the rail body. Animation/phasing effects
  // come from user-defined modulators (see CONFIG.modulators), not from
  // any built-in LFO — modulate camera speed, pill spacing, etc. to drive
  // the visual.
  // Only active when simMode === 'phasing'; defaults model
  // svg/sleepers_phasing.svg: vertical capsules, olive on a yellow bar.
  phasePillSpacing:  137,
  phasePillLength:   19,
  phasePillHeight:   68,
  phasePillOpacityA: 1,
  phaseColorA:       '#a2a792',

  // Stack pattern at the merge — each pattern is a hand-authored
  // SPLIT/MERGE script in sim.js (CONV_PATTERNS) using sub-lane offsets
  // for the rail end-positions.
  convergencePattern: 'adjacent',
  // 0..1 — narrows rails during the merge phase of the loop. Phase is
  // derived per segment from the lane-range across all conns: full spread
  // (rails at 0/3/6) → 0, fully merged (rails close together) → 1.
  // 0 = constant width; 1 = rail vanishes at the merge.
  convergenceTaper: 0,
  // 0..1 — fades every rail's color toward `mergeTintColor` by the merge
  // phase. Matches the figma "ribbon gradient" look where rails wash out
  // to a shared neutral near the junction, so the seam between rails
  // disappears instead of the greens visibly snapping in.
  colorMergeTaper: 0,
  // 0..1 — softens the colour fade by spatially blurring the phase array
  // used for it (the width-taper phase is untouched). 0 = fade confined
  // to the bend segment; 1 = bleeds ±6 segments into the straight sections.
  colorMergeSoftness: 0,
  // Target colour every rail washes toward as `colorMergeTaper` rises.
  // Defaults to the rail edge tone so the fade looks like the figma SVG
  // (saturated body → pale neutral). Use a colour close to bgColor for the
  // softest "rails dissolve into the background near the merge" look.
  mergeTintColor: '#C9C6BC',
  // When true, rail 0 (the trunk) composites *over* rails 1..N instead of
  // under them — so greens recede behind the yellow trunk at the merge.
  trunkOnTop: false,
  // 0..1 — fades non-trunk rails to transparent as they approach the
  // merge (peak phaseSoft). Makes split rails "grow out of" the trunk
  // gradually instead of popping in as a full-alpha wedge at the bend.
  mergeAlphaFade: 0,
  // 0..1 — pulls non-trunk rails toward the trunk's lane (Y = 0) by
  // softened phase, so the visual bend spreads across many segments even
  // though the script's bend is still confined to one segment. Combine
  // with Blend softness to widen the "splitting" zone.
  bendSpread: 0,

  // Topology drawing — when true, dragging in the minimap adds a MERGE
  // event to the active scripted-mode (or draw-mode) timeline. Click-to-
  // seek is paused while this is on. Shift-drag adds a SPLIT instead.
  minimapDrawMode: false,
  // User-drawn events. In scripted mode they layer on top of the active
  // preset; in draw mode they ARE the script. Persisted in presets.
  userEvents: [],
  // Initial lanes for draw mode (space/comma list of integers). Materialised
  // as a single INIT event at seg 0 in USER_EVENTS.
  drawInitLanes: '0 3 6',

  // Simulation
  simMode:      'procedural',  // 'scripted' | 'procedural' | 'phasing' | 'convergence'
  simScript:    'v1',
  loopSegs:     30,
  seed:         1,
  mergeChance:  0.20,
  splitChance:  0.17,
  spawnChance:  0.20,
  endChance:    0.05,
  maxTracks:    9,

  // ── Deploy overlay (figma frame-5 brand color sweep) ────────────────────
  // Active when simMode === 'deploy'. The overlay sits on top of the canvas
  // (svg#deploy-overlay in index.html) and is driven by deploy-overlay.js.
  // All these values are read live by that script — change them and the
  // looping timeline rebuilds.
  deploySweepDur:   2.0,        // seconds for one sweep
  deploySweepDepth: 0.14,       // target offset for the brand stop (0..1)
  deployHold:       0.8,        // pause at end before yoyo back
  deployOpacity:    0.85,       // overlay group opacity (0..1)
  deployBlend:      'multiply', // mix-blend-mode string
  deployBrandTop:   '#4F8669',
  deployBrandMid:   '#D8AB56',
  deployBrandBot:   '#E9C6C5',

  // PNG sequence export
  exportFrames: 120,
  exportFps:    30,

  // Lock the live render loop to this fps (0 = use detected refresh rate).
  // On a 120 Hz display, leaving this at 60 gives a perfectly predictable
  // freeze math (Snap-to-freeze multiplies by exactly 60), and locks the
  // per-frame camera step to a single deterministic value.
  targetFps:    60,

  // When true, the per-frame camera step is rounded to a whole number of
  // pixels in world units. Each tick then renders at an identical
  // sub-pixel offset every frame — AA is stable, no temporal aliasing
  // (the "tick flicker" / "pulsing" problem at non-freeze speeds).
  // Average speed stays exact via a fractional accumulator.
  cameraPixelSnap: true,

  // LFO modulators — each entry is { target, sweetSpot, amount, cycle,
  // waveform, enabled, t }. Edit/add via the Modulators panel; persisted
  // via preset save/load.
  modulators: [],
};

// Snapshot of the baked-in defaults — used by the "Revert to defaults"
// button. Cloned now (before any user mutation) so future changes to CONFIG
// don't leak in.
const DEFAULT_CONFIG = JSON.parse(JSON.stringify(CONFIG));

// ── Simulator init ───────────────────────────────────────────────────────
SIM.setScript(CONFIG.simScript);
SIM.setLoopSegs(CONFIG.loopSegs);
SIM.setSegW(CONFIG.segW);
SIM.setLaneSpace(CONFIG.laneSpace);
SIM.setCenterY(0);
SIM.setSeed(CONFIG.seed);
SIM.setMergeChance(CONFIG.mergeChance);
SIM.setSplitChance(CONFIG.splitChance);
SIM.setSpawnChance(CONFIG.spawnChance);
SIM.setEndChance(CONFIG.endChance);
SIM.setMaxTracks(CONFIG.maxTracks);
SIM.setMode(CONFIG.simMode);

const WORLD = {
  cameraX:       0,
  bufferSegs:    33,
  // Must be ≥ MAX_LANE_BUCKETS / SIM.MAX_RAILS — at saturation each segment
  // emits one conn per rail (plus one trunk-continuation if a SPLIT fires
  // that turn, but cap on rails ensures we never exceed MAX_LANE_BUCKETS).
  maxSlots:      MAX_LANE_BUCKETS,
  laneOriginSeg: 0,
};

// ── Three.js setup ───────────────────────────────────────────────────────
const canvas   = document.getElementById('scene');
// preserveDrawingBuffer is required for canvas.toBlob() during PNG export;
// without it the swap chain has already flipped by the time we read pixels.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(new THREE.Color(CONFIG.bgColor));

const scene  = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}
window.addEventListener('resize', resize);
resize();

// ── Lane data — Float RGBA texture (MAX_SLOTS × BUFFER_SEGS) ─────────────
// Each pixel (slot, seg) encodes one bezier connection:
//   .r = segment start X in world units (absolute)
//   .g = world Y of this connection's start lane
//   .b = world Y of this connection's end lane
//   .a = 0 if invalid; otherwise rail ID + 1 (so id ∈ [0,8] → a ∈ [1,9])
const laneDataArray = new Float32Array(WORLD.maxSlots * WORLD.bufferSegs * 4);
const laneDataTex   = new THREE.DataTexture(
  laneDataArray, WORLD.maxSlots, WORLD.bufferSegs,
  THREE.RGBAFormat, THREE.FloatType
);
laneDataTex.magFilter = THREE.NearestFilter;
laneDataTex.minFilter = THREE.NearestFilter;
laneDataTex.wrapS = THREE.ClampToEdgeWrapping;
laneDataTex.wrapT = THREE.ClampToEdgeWrapping;
laneDataTex.needsUpdate = true;

// Per-segment merge phase (0 = spread, 1 = fully merged) — derived from
// the lane-range across all conns at that segment. Used to taper rail
// width through the loop's spread→merge→spread cycle, regardless of which
// rail the conn belongs to.
const segPhaseArray     = new Float32Array(WORLD.bufferSegs);
// Triangular-blurred copy of segPhaseArray — only used to drive the
// colour blend, so soft-blending can spread several segments to either
// side of a bend while the width-taper stays tight on the bend itself.
const segPhaseSoftArray = new Float32Array(WORLD.bufferSegs);
const COLOR_SOFT_MAX_RADIUS = 6; // segments per side at slider = 1

// Auto-normalize the spread→merge phase to the active script's actual
// rail-range, so phase=0 always means "as spread as this script ever
// gets" and phase=1 means "as merged as it gets". One-pass scan over the
// loop, called whenever the simulation topology changes.
let PHASE_MAX_RANGE = 6;
let PHASE_MERGE_RANGE = 3;
function recomputePhaseRange() {
  const loopLen = Math.max(1, SIM.LOOP_SEGS || 1);
  let maxR = 0, minR = Infinity;
  for (let s = 0; s < loopLen; s++) {
    const conns = SIM.connectionsAt(s);
    if (!conns.length) continue;
    let yMin = Infinity, yMax = -Infinity;
    for (const c of conns) {
      if (c.y2 < yMin) yMin = c.y2;
      if (c.y2 > yMax) yMax = c.y2;
    }
    const range = yMax - yMin;
    if (range > maxR) maxR = range;
    if (range < minR) minR = range;
  }
  if (minR === Infinity) { minR = 0; maxR = 6; }
  if (maxR - minR < 1e-3) maxR = minR + 1;  // avoid div-by-zero on flat scripts
  PHASE_MAX_RANGE   = maxR;
  PHASE_MERGE_RANGE = minR;
}
recomputePhaseRange();

function rebuildLaneData() {
  const segW = CONFIG.segW;
  const cameraSeg = Math.floor(WORLD.cameraX / segW);
  const originSeg = cameraSeg - Math.floor(WORLD.bufferSegs / 2);
  WORLD.laneOriginSeg = originSeg;

  for (let r = 0; r < WORLD.bufferSegs; r++) {
    const seg = originSeg + r;
    const conns = SIM.connectionsAt(seg);
    const sxWorld = seg * segW;
    let yMin = Infinity, yMax = -Infinity;
    for (let c = 0; c < WORLD.maxSlots; c++) {
      const i = (r * WORLD.maxSlots + c) * 4;
      if (c < conns.length) {
        const conn = conns[c];
        const id = (typeof conn.id === 'number') ? conn.id : 0;
        laneDataArray[i    ] = sxWorld;
        laneDataArray[i + 1] = SIM.laneToY(conn.y1);
        laneDataArray[i + 2] = SIM.laneToY(conn.y2);
        laneDataArray[i + 3] = id + 1;
        if (conn.y2 < yMin) yMin = conn.y2;
        if (conn.y2 > yMax) yMax = conn.y2;
      } else {
        laneDataArray[i    ] = 0;
        laneDataArray[i + 1] = 0;
        laneDataArray[i + 2] = 0;
        laneDataArray[i + 3] = 0;
      }
    }
    if (yMax === -Infinity) {
      segPhaseArray[r] = 0;
    } else {
      const range = yMax - yMin;
      const denom = PHASE_MAX_RANGE - PHASE_MERGE_RANGE;
      segPhaseArray[r] = Math.max(0, Math.min(1,
        (PHASE_MAX_RANGE - range) / denom));
    }
  }

  // Triangular blur of the phase array → softened phase for colour blend.
  // Radius = colorMergeSoftness × COLOR_SOFT_MAX_RADIUS (in segments).
  const softness = Math.max(0, Math.min(1, CONFIG.colorMergeSoftness ?? 0));
  const radius   = Math.round(softness * COLOR_SOFT_MAX_RADIUS);
  if (radius === 0) {
    segPhaseSoftArray.set(segPhaseArray);
  } else {
    for (let r = 0; r < WORLD.bufferSegs; r++) {
      let sum = 0, weight = 0;
      for (let dr = -radius; dr <= radius; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= WORLD.bufferSegs) continue;
        const w = 1 - Math.abs(dr) / (radius + 1);
        sum    += segPhaseArray[rr] * w;
        weight += w;
      }
      segPhaseSoftArray[r] = weight > 0 ? sum / weight : 0;
    }
  }

  laneDataTex.needsUpdate = true;
}
rebuildLaneData();

// ── Rail shader ──────────────────────────────────────────────────────────
const geo = new THREE.PlaneGeometry(2, 2);
const mat = new THREE.ShaderMaterial({
  uniforms: {
    uResolution:  { value: new THREE.Vector2(1, 1) },
    uTime:        { value: 0 },
    uZoom:        { value: CONFIG.viewZoom },
    uRailWidth:   { value: CONFIG.railWidth },
    uRailSoft:    { value: CONFIG.railSoft },
    uRailSigma:   { value: CONFIG.railSigma },
    uRailOpacity: { value: CONFIG.railOpacity },
    uBgColor:     { value: new THREE.Color(CONFIG.bgColor) },
    uBlendMode:   { value: 0 },
    uLaneColors:    { value: CONFIG.laneColors.map(h => new THREE.Color(h)) },
    // Figma-profile uniforms (only used when uRailProfile > 0.5)
    uRailProfile:   { value: CONFIG.railProfile },
    uLaneShoulder:  { value: CONFIG.laneShoulderColors.map(h => new THREE.Color(h)) },
    uRailEdgeColor: { value: new THREE.Color(CONFIG.railEdgeColor) },
    uProfileCore:     { value: CONFIG.profileCore },
    uProfileShoulder: { value: CONFIG.profileShoulder },

    // Ticks (zoetrope)
    uTickAmount:  { value: CONFIG.tickAmount },
    uTickSpacing: { value: CONFIG.tickSpacing },
    uTickWidth:   { value: CONFIG.tickWidth },
    uTickColor:   { value: new THREE.Color(CONFIG.tickColor || '#F1EFE8') },
    uTickMotionBlur: { value: CONFIG.tickMotionBlur ?? 0 },

    // Ink traps
    uInkTrapAmount:    { value: CONFIG.inkTrapAmount },
    uInkTrapSpacing:   { value: CONFIG.inkTrapSpacing },
    uInkTrapDensity:   { value: CONFIG.inkTrapDensity },
    uInkTrapWidth:     { value: CONFIG.inkTrapWidth },
    uInkTrapDirection: { value: CONFIG.inkTrapDirection },

    // Per-frame camera motion in world units — used to motion-blur narrow
    // periodic features (ticks) so they don't strobe when speed is high.
    uMotionStep:       { value: 0 },

    // Bursts
    uBurstAmount:      { value: CONFIG.burstAmount ?? 0 },
    uBurstDensity:     { value: CONFIG.burstDensity ?? 0.5 },
    uBurstCell:        { value: CONFIG.burstCell ?? 600 },
    uBurstLenMin:      { value: CONFIG.burstLenMin ?? 0.25 },
    uBurstLenMax:      { value: CONFIG.burstLenMax ?? 0.85 },
    uBurstSpeed:       { value: CONFIG.burstSpeed ?? 800 },
    uBurstRailSpread:  { value: CONFIG.burstRailSpread ?? 0.6 },
    uBurstColor:       { value: new THREE.Color(CONFIG.burstColor || '#DE4D0E') },
    uBurstLockToRail:  { value: CONFIG.burstLockToRail ? 1 : 0 },

    // Convergence — flag enables per-conn merge tapering.
    uConvergenceMode:    { value: 0 },
    uConvergenceTaper:   { value: CONFIG.convergenceTaper },
    uColorMergeTaper:    { value: CONFIG.colorMergeTaper ?? 0 },
    uMergeTintColor:     { value: new THREE.Color(CONFIG.mergeTintColor || '#C9C6BC') },
    uTrunkOnTop:         { value: CONFIG.trunkOnTop ? 1 : 0 },
    uMergeAlphaFade:     { value: CONFIG.mergeAlphaFade ?? 0 },
    uBendSpread:         { value: CONFIG.bendSpread ?? 0 },
    uSegPhases:        { value: segPhaseArray },
    uSegPhasesSoft:    { value: segPhaseSoftArray },

    // Phasing pills (group A only)
    uPhaseEnabled:    { value: 0 },
    uPhaseSpacing:    { value: CONFIG.phasePillSpacing },
    uPhaseLength:     { value: CONFIG.phasePillLength },
    uPhaseHeight:     { value: CONFIG.phasePillHeight },
    uPhaseOffsetA:    { value: 0 },
    uPhaseOpacityA:   { value: CONFIG.phasePillOpacityA },
    uPhaseColorA:     { value: new THREE.Color(CONFIG.phaseColorA) },

    // Topology
    uLaneData:    { value: laneDataTex },
    uCameraX:     { value: 0 },
    uSegW:        { value: CONFIG.segW },
    uBufferSegs:  { value: WORLD.bufferSegs },
    uMaxSlots:    { value: WORLD.maxSlots },
    uLaneOriginX: { value: 0 },
    uLaneSpacePerUnit: { value: CONFIG.laneSpace },
  },
  vertexShader: /* glsl */`
    varying vec2 vUV;
    void main() {
      vUV = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUV;

    uniform vec2  uResolution;
    uniform float uTime;
    uniform float uZoom;
    uniform float uRailWidth;
    uniform float uRailSoft;
    uniform float uRailSigma;
    uniform float uRailOpacity;
    uniform vec3  uBgColor;
    uniform int   uBlendMode;

    // Hard cap on lane buckets — must match MAX_LANE_BUCKETS in app-three.js.
    // Each bucket aggregates one rail's coverage.
    #define MAX_LANE_BUCKETS 9
    uniform vec3  uLaneColors[MAX_LANE_BUCKETS];
    uniform vec3  uLaneShoulder[MAX_LANE_BUCKETS];
    uniform vec3  uRailEdgeColor;
    uniform float uRailProfile;
    uniform float uProfileCore;
    uniform float uProfileShoulder;

    uniform float uTickAmount;
    uniform float uTickSpacing;
    uniform float uTickWidth;
    uniform vec3  uTickColor;
    uniform float uTickMotionBlur;

    uniform float uInkTrapAmount;
    uniform float uInkTrapSpacing;
    uniform float uInkTrapDensity;
    uniform float uInkTrapWidth;
    uniform float uInkTrapDirection;

    // Bursts
    uniform float uBurstAmount;
    uniform float uBurstDensity;
    uniform float uBurstCell;
    uniform float uBurstLenMin;
    uniform float uBurstLenMax;
    uniform float uBurstSpeed;
    uniform float uBurstRailSpread;
    uniform vec3  uBurstColor;
    uniform float uBurstLockToRail;
    uniform float uMotionStep;

    uniform float uPhaseEnabled;
    uniform float uPhaseSpacing;
    uniform float uPhaseLength;
    uniform float uPhaseHeight;
    uniform float uConvergenceMode;
    uniform float uConvergenceTaper;
    uniform float uColorMergeTaper;
    uniform vec3  uMergeTintColor;
    uniform float uTrunkOnTop;
    uniform float uMergeAlphaFade;
    uniform float uBendSpread;
    // Per-segment merge phase, one entry per buffer row. 0 = spread,
    // 1 = fully merged. Sized to match WORLD.bufferSegs (33).
    uniform float uSegPhases[33];
    uniform float uSegPhasesSoft[33];

    uniform float uPhaseOffsetA;
    uniform float uPhaseOpacityA;
    uniform vec3  uPhaseColorA;

    uniform sampler2D uLaneData;
    uniform float     uCameraX;
    uniform float     uSegW;
    uniform float     uBufferSegs;
    uniform float     uMaxSlots;
    uniform float     uLaneOriginX;
    uniform float     uLaneSpacePerUnit;

    // Fetch one connection record from the lane_data buffer.
    //   .r = segment start X (world)
    //   .g = start lane Y    (world)
    //   .b = end   lane Y    (world)
    //   .a = valid flag
    vec4 fetchLane(float slot, float seg) {
      float u = (slot + 0.5) / uMaxSlots;
      float v = (seg  + 0.5) / uBufferSegs;
      return texture2D(uLaneData, vec2(u, v));
    }

    // Smootherstep ribbon — flat tangents at both endpoints so branches
    // hold parallel to the axis before peeling off. Returns top/bot edges
    // around the lane centerline at parameter t along this connection.
    vec2 ribbonEdges(float y1, float y2, float t, float halfW) {
      float tc = clamp(t, 0.0, 1.0);
      float s  = tc * tc * tc * (tc * (tc * 6.0 - 15.0) + 10.0);
      float yc = mix(y1, y2, s);
      return vec2(yc - halfW, yc + halfW);
    }

    // Ink traps — soft Gaussian "hills" that spawn along the rail at
    // semi-random world-X positions, unique per rail (yLane). Each cell
    // of width uInkTrapSpacing has at most one trap. Returns vec2(up, down)
    // so the rail can swell on either side; uInkTrapDirection biases which.
    vec2 inkTrap(float wx, float yLane) {
      if (uInkTrapAmount < 1e-3 || uInkTrapDensity < 1e-3) return vec2(0.0);
      float spacing = max(uInkTrapSpacing, 1.0);
      float u       = wx / spacing;
      float cellIdx = floor(u);
      float laneU   = yLane / max(uLaneSpacePerUnit, 1.0);
      float w_      = max(uInkTrapWidth, 1.0);
      vec2  total   = vec2(0.0);
      // Sum ±1 neighbour cells so the function is continuous across cells.
      for (int k = -1; k <= 1; k++) {
        float ci   = cellIdx + float(k);
        float h1   = fract(sin(ci * 12.9898 + laneU * 78.233) * 43758.5453);
        float gate = 1.0 - smoothstep(uInkTrapDensity - 0.04, uInkTrapDensity, h1);
        if (gate < 0.001) continue;
        float h2 = fract(sin(ci * 39.346 + laneU * 11.135 + 4.7) * 22578.1459);
        float h3 = 0.55 + 0.45 * fract(sin(ci * 53.218 + laneU * 7.31 + 2.1) * 91237.13);
        float h4 = fract(sin(ci * 67.123 + laneU * 13.7  + 9.3) * 53219.7);
        float center   = (ci + mix(0.25, 0.75, h2)) * spacing;
        float dist     = wx - center;
        float strength = uInkTrapAmount * h3 * gate
                       * exp(-(dist * dist) / (w_ * w_ * 0.5));
        if (h4 < uInkTrapDirection) total.y += strength;
        else                        total.x += strength;
      }
      return total;
    }

    // Periodic-gap mask along world-X. Returns 1 (rail visible) outside the
    // tick zone, falling to (1 - uTickAmount) at each tick centre. Antialiased
    // against the screen-space dx so edges stay crisp at any zoom.
    // halfW is widened by half the per-frame camera motion (uMotionStep) so
    // a thin tick rendered at high scroll speed gets stretched into a soft
    // bar that covers the swept distance — kills temporal strobing instead
    // of a 2-wu tick teleporting 75 wu per frame.
    float tickGap(float wx) {
      if (uTickAmount < 1e-3) return 1.0;
      float sp     = max(uTickSpacing, 1.0);
      float u      = wx / sp;
      float frac   = u - floor(u);
      float dist   = min(frac, 1.0 - frac) * sp;
      float halfW  = max(uTickWidth, 0.0) * 0.5
                   + uMotionStep * 0.5 * clamp(uTickMotionBlur, 0.0, 1.0);
      float aa     = max(fwidth(wx), 1e-4);
      float inside = 1.0 - smoothstep(halfW - aa, halfW + aa, dist);
      return 1.0 - inside * uTickAmount;
    }
    // Same shape as tickGap but returns only the [0..1] inside-the-tick
    // factor, so main() can paint uTickColor on top of the rail composite.
    float tickInsideMask(float wx) {
      if (uTickAmount < 1e-3) return 0.0;
      float sp     = max(uTickSpacing, 1.0);
      float u      = wx / sp;
      float frac   = u - floor(u);
      float dist   = min(frac, 1.0 - frac) * sp;
      float halfW  = max(uTickWidth, 0.0) * 0.5
                   + uMotionStep * 0.5 * clamp(uTickMotionBlur, 0.0, 1.0);
      float aa     = max(fwidth(wx), 1e-4);
      return 1.0 - smoothstep(halfW - aa, halfW + aa, dist);
    }

    // Per-lane color, sourced from the user-controlled uLaneColors array.
    // Constant-index unroll keeps WebGL1 happy on drivers that reject
    // dynamic indexing into uniform arrays.
    vec3 laneColor(int idx) {
      vec3 c = uLaneColors[0];
      for (int k = 1; k < MAX_LANE_BUCKETS; k++) {
        if (k == idx) c = uLaneColors[k];
      }
      return c;
    }
    vec3 laneShoulder(int idx) {
      vec3 c = uLaneShoulder[0];
      for (int k = 1; k < MAX_LANE_BUCKETS; k++) {
        if (k == idx) c = uLaneShoulder[k];
      }
      return c;
    }

    // Figma 6-stop vertical profile (alpha + color), as a function of
    // du = |dY| / hHalfT  (0 at rail centerline, 1 at body edge).
    //   du < 0.22 : solid saturated core
    //   0.22 .. 0.8 : lerp saturated → pastel shoulder
    //   0.8 .. 1.0  : lerp pastel → edge color, alpha 1 → 0
    //   du > 1.0  : alpha 0 (outside body)
    float figmaProfileAlpha(float du) {
      float sh = max(uProfileShoulder, 0.001);
      if (du < sh)   return 1.0;
      if (du >= 1.0) return 0.0;
      return 1.0 - (du - sh) / max(1.0 - sh, 0.001);
    }
    vec3 figmaProfileColor(float du, vec3 saturated, vec3 pastel, vec3 edge) {
      float co = clamp(uProfileCore, 0.0, 0.99);
      float sh = clamp(uProfileShoulder, co + 0.001, 1.0);
      if (du < co) return saturated;
      if (du < sh) return mix(saturated, pastel, (du - co) / max(sh - co, 0.001));
      return mix(pastel, edge, clamp((du - sh) / max(1.0 - sh, 0.001), 0.0, 1.0));
    }

    // ── Bursts ──────────────────────────────────────────────────────────────
    // Per-rail painterly slugs scrolling along world-X. The cell partition +
    // per-cell hash mirrors Ikeda's data-stream pattern, but the envelope
    // is figmaProfileAlpha (same shoulder shape the rail's Y cross-section
    // uses) so the burst looks like an isotropic blob, not a digital dash.
    float burstHash11(float n) {
      return fract(sin(n * 91.3458) * 47453.5453);
    }
    float burstHash21(vec2 v) {
      return fract(sin(dot(v, vec2(127.1, 311.7))) * 43758.5453);
    }
    float burstAlpha(float wx, int rid, float time) {
      if (uBurstAmount < 1e-3) return 0.0;

      float ridF   = float(rid);
      // Per-rail velocity multiplier — symmetric around 1.0, range scaled
      // by uBurstRailSpread so spread=0 → all rails at 1.0x, spread=1 →
      // rails at 0.0..2.0x of base speed.
      float velMul = 1.0 + (burstHash11(ridF + 0.5) - 0.5) * 2.0 * clamp(uBurstRailSpread, 0.0, 1.0);

      // Mode A: bursts drift in world-X at their own absolute velocity
      // (independent of the camera's rail-scroll). Mode B: bursts pinned
      // to world-X but each rail's X is scaled, giving a parallax desync.
      float bx = (uBurstLockToRail > 0.5)
                 ? wx * velMul
                 : wx - velMul * uBurstSpeed * time;

      float cellW    = max(uBurstCell, 1.0);
      float u        = bx / cellW;
      float cellIdx  = floor(u);
      float cellFrac = u - cellIdx;

      // Per-cell, per-rail seeds for presence / length / position
      vec2 seed1 = vec2(cellIdx, ridF * 17.31 + 0.5);
      vec2 seed2 = vec2(cellIdx + 0.31, ridF * 17.31 + 1.71);
      vec2 seed3 = vec2(cellIdx + 0.71, ridF * 17.31 + 2.13);
      float r1   = burstHash21(seed1);
      float r2   = burstHash21(seed2);
      float r3   = burstHash21(seed3);

      // Density gate: a cell fires when r1 falls inside the density window.
      if (r1 > clamp(uBurstDensity, 0.0, 1.0)) return 0.0;

      float lmin     = clamp(uBurstLenMin, 0.01, 1.0);
      float lmax     = clamp(uBurstLenMax, lmin, 1.0);
      float burstLen = mix(lmin, lmax, r2);
      // Centre placed somewhere inside the cell that keeps the burst
      // entirely within it (no cross-cell bleed).
      float centre   = mix(burstLen * 0.5, 1.0 - burstLen * 0.5, r3);

      float d = abs(cellFrac - centre) / max(burstLen * 0.5, 0.001);
      if (d >= 1.0) return 0.0;

      // Same shoulder shape the rail uses along Y — burst reads as a soft
      // isotropic blob rather than a rectangle.
      return figmaProfileAlpha(d) * clamp(uBurstAmount, 0.0, 1.0);
    }

    // Figma-style blend ops. b = backdrop (running dst), s = source (lane
    // color). Result is RGB blend; the per-lane alpha then mixes it in.
    vec3 blendOp(vec3 b, vec3 s, int mode) {
      if (mode == 1) return b * s;                                            // Multiply
      if (mode == 2) return 1.0 - (1.0 - b) * (1.0 - s);                      // Screen
      if (mode == 3) return min(b, s);                                        // Darken
      if (mode == 4) return max(b, s);                                        // Lighten
      if (mode == 5) return mix(2.0 * b * s,                                  // Overlay
                                1.0 - 2.0 * (1.0 - b) * (1.0 - s),
                                step(vec3(0.5), b));
      if (mode == 6) return abs(b - s);                                       // Difference
      if (mode == 7) return min(vec3(1.0), b + s);                            // Plus lighter
      return s;                                                                // Normal
    }

    // Render the rail body at this fragment. Two-stage:
    //   1. scan every connection, accumulate a max-coverage value into the
    //      owner lane's bucket (so multiple conns of the same rail collapse
    //      into one layer)
    //   2. composite each lane's color onto the destination using the
    //      chosen blend mode — this is where the layering effect happens
    vec4 drawRailTopology(float wx, float wy) {
      float baseHalfW = uRailWidth;
      float sig   = max(uRailSigma, 0.05);
      float softK = clamp(uRailSoft, 0.0, 1.0);
      float aa    = max(fwidth(wy), 1e-4);
      float laneTol = max(uLaneSpacePerUnit * 0.5, 0.5);

      float laneCov[MAX_LANE_BUCKETS];
      vec3  laneCol[MAX_LANE_BUCKETS];
      // Max rail coverage at this fragment *before* the tick gap is applied
      // — used by the tick painter so uTickColor only shows up where rails
      // were drawn, not across the full background.
      float rawMaxA = 0.0;
      for (int i = 0; i < MAX_LANE_BUCKETS; i++) {
        laneCov[i] = 0.0;
        laneCol[i] = vec3(0.0);
      }

      // Single per-fragment computation — applies uniformly to every rail
      // at this wx so all rails freeze together at the zoetrope speed.
      float gap = tickGap(wx);

      for (int r = 0; r < 33; r++) {
        if (float(r) >= uBufferSegs) break;

        // Phase at the START and END of this segment row. The start phase
        // is the previous row's end phase (same loop, one step earlier),
        // so the bend segment smoothly interpolates from spread to merge.
        float phaseEnd       = uSegPhases[r];
        float phaseStart     = (r > 0) ? uSegPhases[r - 1] : phaseEnd;
        float phaseSoftEnd   = uSegPhasesSoft[r];
        float phaseSoftStart = (r > 0) ? uSegPhasesSoft[r - 1] : phaseSoftEnd;

        for (int s = 0; s < 9; s++) {
          if (float(s) >= uMaxSlots) break;
          vec4 conn = fetchLane(float(s), float(r));
          if (conn.a < 0.5) break;
          // Rail ID is encoded as alpha-1 (so a=0 means invalid, a∈[1,9]
          // are rail IDs 0..8). Round-then-subtract guards against any
          // float roundoff in the texture sample.
          int rid = int(conn.a + 0.5) - 1;
          if (rid < 0 || rid >= MAX_LANE_BUCKETS) continue;
          float sx = conn.r;
          float y1 = conn.g;
          float y2 = conn.b;
          float t  = (wx - sx) / uSegW;
          if (t < 0.0 || t >= 1.0) continue;

          // Pull non-trunk rails toward the trunk's lane (Y = 0) by the
          // softened phase, so the visible bend stretches across many
          // segments instead of being confined to the one segment where
          // the SPLIT/MERGE event fires. uSegPhasesSoft is continuous
          // across segment boundaries, so y1/y2 stay continuous too.
          if (rid != 0 && uConvergenceMode > 0.5 && uBendSpread > 0.0) {
            y1 = mix(y1, 0.0, clamp(uBendSpread * phaseSoftStart, 0.0, 1.0));
            y2 = mix(y2, 0.0, clamp(uBendSpread * phaseSoftEnd,   0.0, 1.0));
          }

          float halfW = baseHalfW;
          if (uConvergenceMode > 0.5 && uConvergenceTaper > 0.0) {
            // Width follows the loop phase: full width during spread
            // segments, narrowed during the merge segments. Slider at 1
            // narrows to MIN_FACTOR (not zero) so rails stay visible
            // through the merge. Interpolates across bends via t.
            const float MIN_FACTOR = 0.15;
            float phase  = mix(phaseStart, phaseEnd, t);
            float factor = mix(1.0, MIN_FACTOR, uConvergenceTaper * phase);
            halfW = baseHalfW * factor;
          }

          vec2  edges  = ribbonEdges(y1, y2, t, halfW);
          float yMid   = (edges.x + edges.y) * 0.5;
          float hHalf  = (edges.y - edges.x) * 0.5;
          float yIdent = (y1 + y2) * 0.5;
          vec2  trap   = inkTrap(wx, yIdent);
          float yMidT  = yMid + (trap.y - trap.x) * 0.5;
          float hHalfT = hHalf + (trap.x + trap.y) * 0.5;
          float dY     = wy - yMidT;

          // Strip SDF — distance to rail y-edges only. X is gated by the
          // t-range check above; without x-edges, collinear conns butt up
          // flush at segment boundaries.
          float d = abs(dY) - hHalfT;

          // Per-rail color, optionally washed toward a shared neutral tint
          // (uMergeTintColor) as the segment phase climbs into the merge.
          // Every rail desaturates the same way, so by the time greens and
          // yellow meet they're all the same pale shade and the colour seam
          // dissolves — matching the figma ribbon-gradient look where each
          // rail fades into a near-background tone before converging.
          // Early-out: if this fragment is well outside the rail body
          // there's nothing to paint, so we can skip the (expensive) merge
          // tint + burst computation entirely. 1.5 covers the figma
          // shoulder (du≤1) plus a small margin for the gaussian halo.
          if (abs(dY) > hHalfT * 1.5) continue;

          float colorMix = (uConvergenceMode > 0.5 && uColorMergeTaper > 0.0)
                           ? clamp(uColorMergeTaper * mix(phaseSoftStart, phaseSoftEnd, t), 0.0, 1.0)
                           : 0.0;
          vec3 ridSat  = mix(laneColor(rid),    uMergeTintColor, colorMix);
          vec3 ridShl  = mix(laneShoulder(rid), uMergeTintColor, colorMix);

          // Burst layer — periodic painterly slugs of uBurstColor scrolled
          // along this rail's world-X at its own velocity. Mixed into both
          // the saturated core and the shoulder so the burst inherits the
          // rail's Y cross-section automatically (figma profile downstream).
          // Skipped entirely when uBurstAmount is 0 (cheap test inside the
          // function, but the conditional saves a function-call worth of
          // hashing for the common "no bursts" case).
          float bA = (uBurstAmount > 1e-3) ? burstAlpha(wx, rid, uTime) : 0.0;
          if (bA > 0.0) {
            ridSat = mix(ridSat, uBurstColor,                    bA);
            ridShl = mix(ridShl, mix(uBurstColor, ridShl, 0.4),  bA);
          }

          float alpha;
          vec3  fragCol;
          if (uRailProfile > 0.5) {
            // Figma profile — body itself has soft edges. du = 0 at the
            // rail center, du = 1 at the body's outer edge.
            float du   = abs(dY) / max(hHalfT, 1e-4);
            float pA   = figmaProfileAlpha(du);
            alpha      = pA * clamp(uRailOpacity, 0.0, 1.0);
            fragCol    = figmaProfileColor(du, ridSat, ridShl, uRailEdgeColor);
          } else {
            // Gaussian profile (default) — crisp body + soft halo outside.
            float fillCov = 1.0 - smoothstep(-aa, aa, d);
            float dHalo   = max(d, 0.0) / max(hHalfT, 1e-4);
            float bodyC   = exp(-(dHalo * dHalo) / (2.0 * sig * sig)) * softK;
            alpha         = max(fillCov, bodyC) * clamp(uRailOpacity, 0.0, 1.0);
            fragCol       = ridSat;
          }
          // Fade non-trunk rails out toward the merge so they "grow out
          // of" the trunk instead of popping in as a full-alpha wedge.
          // Uses the softened phase so the fade extends gently across
          // neighbouring segments when Blend softness is up.
          if (rid != 0 && uConvergenceMode > 0.5 && uMergeAlphaFade > 0.0) {
            alpha *= 1.0 - clamp(uMergeAlphaFade * mix(phaseSoftStart, phaseSoftEnd, t), 0.0, 1.0);
          }
          // Save raw alpha (before tick gap) so the tick painter can mask
          // its colour to "where the rail would have been", and only then
          // apply the gap to the rail's composited alpha.
          float rawA = alpha;
          alpha *= gap;
          if (rawA > rawMaxA) rawMaxA = rawA;
          if (alpha < 1e-4) continue;

          // Constant-index write — WebGL1 needs static indexing into local
          // arrays on some drivers.
          for (int k = 0; k < MAX_LANE_BUCKETS; k++) {
            if (k == rid && alpha > laneCov[k]) {
              laneCov[k] = alpha;
              laneCol[k] = fragCol;
            }
          }
        }
      }

      vec3 dst = uBgColor;
      float maxA = 0.0;
      // Pass 1: composite rails 1..N (non-trunk) first when trunk-on-top
      // is on, so the trunk paints over the greens. When off, just walk
      // 0..N in order (original behaviour).
      int startI = (uTrunkOnTop > 0.5) ? 1 : 0;
      for (int i = 0; i < MAX_LANE_BUCKETS; i++) {
        if (i < startI) continue;
        float a = laneCov[i];
        if (a < 1e-4) continue;
        // Both profiles now write the per-fragment color (post merge-taper
        // colour blend) into laneCol[i] at write time, so composite from
        // there regardless of profile.
        vec3 src     = laneCol[i];
        vec3 blended = blendOp(dst, src, uBlendMode);
        dst = mix(dst, blended, a);
        if (a > maxA) maxA = a;
      }
      // Pass 2: rail 0 last (on top) when trunk-on-top is on. Forces
      // *normal* blend for the trunk regardless of the global blend mode —
      // otherwise modes like darken would re-mix it with the greens
      // underneath and the trunk wouldn't actually paint over.
      if (uTrunkOnTop > 0.5) {
        float a0 = laneCov[0];
        if (a0 >= 1e-4) {
          vec3 src = laneCol[0];
          dst = mix(dst, src, a0);
          if (a0 > maxA) maxA = a0;
        }
      }
      // Paint uTickColor on top of the composited rails, masked by the
      // tick-inside factor and the raw rail coverage so the tick only
      // shows where a rail body exists (not across empty background).
      float tInside = tickInsideMask(wx);
      if (tInside > 1e-4 && rawMaxA > 1e-4) {
        float tickPaint = tInside * uTickAmount * rawMaxA;
        dst = mix(dst, uTickColor, tickPaint);
        if (tickPaint > maxA) maxA = tickPaint;
      }
      return vec4(dst, maxA);
    }

    // Repeating pill SDF mask — period 'spacing' along world-X, centered on
    // lane Y. Pill = rounded rect; corner radius is half of the shorter
    // side so both horizontal and vertical capsule shapes work.
    // 'offset' shifts the pattern in world-X so each voice can drift.
    float phasePillMask(float wx, float wy, float laneY, float offset, float spacing) {
      float sp      = max(spacing, 1.0);
      float ux      = mod(wx - offset, sp) - sp * 0.5;
      float halfL   = max(uPhaseLength * 0.5, 0.5);
      float halfH   = max(uPhaseHeight * 0.5, 0.5);
      float r       = min(halfL, halfH);
      float dx      = abs(ux)           - (halfL - r);
      float dy      = abs(wy - laneY)   - (halfH - r);
      vec2  q       = max(vec2(dx, dy), 0.0);
      float d       = length(q) + min(max(dx, dy), 0.0) - r;
      float aa      = max(fwidth(wx) + fwidth(wy), 1e-4);
      return 1.0 - smoothstep(-aa, aa, d);
    }

    void main() {
      // Screen → world. viewH = world units that fit vertically; uZoom
      // scales it (smaller zoom = see more).
      float aspect = uResolution.x / uResolution.y;
      float viewH  = 1000.0 / uZoom;
      float viewW  = viewH * aspect;
      float wx = uCameraX + (vUV.x - 0.5) * viewW;
      float wy = (vUV.y - 0.5) * viewH;

      // drawRailTopology already starts dst at uBgColor, so no extra bg
      // composite needed in main().
      vec4 rail = drawRailTopology(wx, wy);
      vec3 col  = rail.rgb;

      // Phasing pills sit *inside* the rail body — the pill mask is gated by
      // the rail's own coverage so pills can never paint outside the strip.
      if (uPhaseEnabled > 0.5 && rail.a > 1e-3) {
        float laneY = 0.0;  // single rail at lane center; CENTER_Y is 0
        float mA = phasePillMask(wx, wy, laneY, uPhaseOffsetA, uPhaseSpacing) * rail.a
                 * clamp(uPhaseOpacityA, 0.0, 1.0);
        col = mix(col, uPhaseColorA, mA);
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `,
});

const quad = new THREE.Mesh(geo, mat);
scene.add(quad);

function updateResolution() {
  const size = new THREE.Vector2();
  renderer.getSize(size);
  mat.uniforms.uResolution.value.set(size.x, size.y);
}
window.addEventListener('resize', updateResolution);
updateResolution();

// ── Modulators — generic LFO automation for any allowlisted CONFIG key.
// Each entry runs a wave shape over `cycle` seconds, computes
// sweetSpot + amount × wave(phase), clamps to the target's range, and
// writes back into CONFIG. _applyConfigCore() then pushes the new value to
// the relevant uniform/SIM call. Skips buildMinimap() to keep cost low.
const MOD_TARGETS = [
  { key: 'speed',             label: 'Camera speed',  min: 0,    max: 30000, step: 1     },
  { key: 'viewZoom',          label: 'Zoom',          min: 0.05, max: 2,     step: 0.01  },
  { key: 'segW',              label: 'Segment width', min: 40,   max: 8000,  step: 1     },
  { key: 'laneSpace',         label: 'Lane spacing',  min: 40,   max: 600,   step: 1     },
  { key: 'railWidth',         label: 'Rail width',    min: 4,    max: 200,   step: 1     },
  { key: 'railSoft',          label: 'Rail soft',     min: 0,    max: 1,     step: 0.01  },
  { key: 'railSigma',         label: 'Rail sigma',    min: 0.2,  max: 1.5,   step: 0.01  },
  { key: 'railOpacity',       label: 'Rail opacity',  min: 0,    max: 1,     step: 0.01  },
  { key: 'tickAmount',        label: 'Tick amount',   min: 0,    max: 1,     step: 0.01  },
  { key: 'tickSpacing',       label: 'Tick spacing',  min: 20,   max: 2000,  step: 1     },
  { key: 'tickWidth',         label: 'Tick width',    min: 2,    max: 500,   step: 1     },
  { key: 'inkTrapAmount',     label: 'Ink trap amt',  min: 0,    max: 400,   step: 1     },
  { key: 'inkTrapWidth',      label: 'Ink trap width',min: 20,   max: 800,   step: 1     },
  { key: 'inkTrapDensity',    label: 'Ink trap dens', min: 0,    max: 1,     step: 0.01  },
  { key: 'burstAmount',       label: 'Burst amount',  min: 0,    max: 1,     step: 0.01  },
  { key: 'burstDensity',      label: 'Burst density', min: 0,    max: 1,     step: 0.01  },
  { key: 'burstCell',         label: 'Burst cell',    min: 50,   max: 5000,  step: 1     },
  { key: 'burstSpeed',        label: 'Burst speed',   min: 0,    max: 5000,  step: 1     },
  { key: 'phasePillSpacing',   label: 'Pill spacing',  min: 20,   max: 800,   step: 1     },
  { key: 'phasePillLength',    label: 'Pill length',   min: 4,    max: 400,   step: 1     },
  { key: 'phasePillHeight',    label: 'Pill height',   min: 2,    max: 200,   step: 1     },
  { key: 'phasePillOpacityA',  label: 'Pill opacity',  min: 0,    max: 1,     step: 0.01  },
  { key: 'convergenceTaper',   label: 'Merge taper',   min: 0,    max: 1,     step: 0.01  },
  { key: 'colorMergeTaper',    label: 'Colour blend',  min: 0,    max: 1,     step: 0.01  },
  { key: 'colorMergeSoftness', label: 'Blend softness',min: 0,    max: 1,     step: 0.01  },
  { key: 'mergeAlphaFade',     label: 'Branch fade',   min: 0,    max: 1,     step: 0.01  },
  { key: 'bendSpread',         label: 'Bend spread',   min: 0,    max: 1,     step: 0.01  },
  { key: 'spawnChance',        label: 'Spawn chance',  min: 0,    max: 1,     step: 0.01  },
  { key: 'endChance',          label: 'End chance',    min: 0,    max: 1,     step: 0.01  },
];
// Each waveform is a "shape function" 0..1 → 0..1 over one cycle. The
// stepModulator code lerps min..max by the shape's output. The shape
// determines both timing (sharp vs eased extremes) and asymmetry
// (saw-up ramps then snaps, saw-down snaps then ramps). Triangle-based
// shapes use the helper `t` = 1 - 2|p - 0.5| (ramps 0→1→0 across cycle)
// so the easing applies symmetrically to both halves.
const MOD_WAVEFORMS = [
  { key: 'sin',      label: 'Sine',          fn: (p) => 0.5 - 0.5 * Math.cos(2 * Math.PI * p) },
  { key: 'tri',      label: 'Linear',        fn: (p) => 1 - 2 * Math.abs(p - 0.5) },
  { key: 'smooth',   label: 'Smooth',        fn: (p) => { const t = 1 - 2 * Math.abs(p - 0.5); return t * t * (3 - 2 * t); } },
  { key: 'smoother', label: 'Smoother',      fn: (p) => { const t = 1 - 2 * Math.abs(p - 0.5); return t * t * t * (t * (t * 6 - 15) + 10); } },
  { key: 'easeIn',   label: 'Ease in',       fn: (p) => { const t = 1 - 2 * Math.abs(p - 0.5); return t * t * t; } },
  { key: 'easeOut',  label: 'Ease out',      fn: (p) => { const t = 1 - 2 * Math.abs(p - 0.5); const u = 1 - t; return 1 - u * u * u; } },
  { key: 'sq',       label: 'Hold',          fn: (p) => p < 0.5 ? 1 : 0 },
  { key: 'sawUp',    label: 'Saw ↑ (ramp)',  fn: (p) => p },
  { key: 'sawDown',  label: 'Saw ↓ (snap)',  fn: (p) => 1 - p },
];
// Migrate any pre-min/max modulators (sweetSpot + amount) to the new shape
// in place, so old presets keep working.
function migrateModulator(m) {
  if (!m) return;
  if (typeof m.min !== 'number' || typeof m.max !== 'number') {
    const ss  = (typeof m.sweetSpot === 'number') ? m.sweetSpot : 0;
    const amt = (typeof m.amount    === 'number') ? m.amount    : 0;
    m.min = ss - amt;
    m.max = ss + amt;
  }
}
function stepModulators(dt) {
  const list = CONFIG.modulators;
  if (!Array.isArray(list) || list.length === 0) return;
  let touched = false;
  for (const m of list) {
    if (!m || !m.enabled) continue;
    migrateModulator(m);
    const tgt = MOD_TARGETS.find(t => t.key === m.target);
    if (!tgt) continue;
    const cycle = Math.max(m.cycle || 0.05, 0.05);
    m.t = (((m.t || 0) + dt) % cycle + cycle) % cycle;
    const wave = (MOD_WAVEFORMS.find(w => w.key === m.waveform) || MOD_WAVEFORMS[0]).fn;
    const v01  = wave(m.t / cycle);                        // shape fn returns 0..1
    let val    = m.min + (m.max - m.min) * v01;
    val = Math.max(tgt.min, Math.min(tgt.max, val));
    CONFIG[m.target] = val;
    touched = true;
  }
  if (touched) {
    _applyConfigCore(true);
    syncModulatedSliders();
  }
}
// Push live modulated values into their slider + readout so the user sees
// the wobble. Only touches inputs whose data-k matches an enabled modulator.
function syncModulatedSliders() {
  for (const m of CONFIG.modulators || []) {
    if (!m || !m.enabled) continue;
    const v = CONFIG[m.target];
    if (typeof v !== 'number') continue;
    const inp = document.querySelector(`#panel input[data-k="${m.target}"]`);
    if (inp) inp.value = v;
    const ro = document.querySelector(`#panel [data-v="${m.target}"]`);
    if (ro) {
      if (ro.tagName === 'INPUT') ro.value = v;
      else ro.textContent = v.toFixed(2);
    }
  }
}

// ── Animation loop ───────────────────────────────────────────────────────
const clock = new THREE.Clock();
let exporting = false;   // when true, the export loop drives sim/render manually
// Fixed-step motion: each rAF firing advances cameraX by speed × (1 /
// detectedRefreshHz), regardless of when rAF actually fired. This gives
// perfectly even per-frame motion — required for stable zoetrope ticks.
// `RENDER_HZ` is updated by detectRefreshRate() once 60 rAF samples are
// in; until then it sits at 60.
let DETECTED_HZ = 60;
let RENDER_HZ   = 60;
function recomputeRenderHz() {
  const cap = CONFIG.targetFps | 0;
  RENDER_HZ = (cap > 0) ? cap : DETECTED_HZ;
  if (statsHzReadout) {
    const lockLabel = (cap > 0) ? `locked ${cap}` : 'auto';
    statsHzReadout.textContent = `${lockLabel} fps · detected ${DETECTED_HZ} Hz`;
  }
  // Keep the freeze-speed readout in sync — the freeze multiple shifts
  // when RENDER_HZ changes.
  if (typeof window._railwayUpdateFreezeHint === 'function') {
    window._railwayUpdateFreezeHint();
  }
}
function setDetectedHz(hz) {
  DETECTED_HZ = hz;
  recomputeRenderHz();
}

// Live FPS panel — uses mrdoob/Stats.js, pinned bottom-left, plus a small
// readout under it showing the detected refresh rate so you can sanity-
// check what the fixed-step animation loop is assuming.
let stats = null;
let statsHzReadout = null;
if (typeof Stats !== 'undefined') {
  stats = new Stats();
  stats.showPanel(0); // 0 = fps, 1 = ms, 2 = mb (click to cycle)
  stats.dom.style.position = 'fixed';
  stats.dom.style.left     = '6px';
  stats.dom.style.bottom   = '6px';
  stats.dom.style.top      = 'auto';
  stats.dom.style.zIndex   = '20';
  document.body.appendChild(stats.dom);

  statsHzReadout = document.createElement('div');
  statsHzReadout.textContent = `detected ${RENDER_HZ} Hz`;
  statsHzReadout.style.cssText = 'position:fixed;left:6px;bottom:54px;'
    + 'z-index:20;color:#aaa;font:11px/1 monospace;padding:3px 6px;'
    + 'background:rgba(0,0,0,.55);border-radius:3px;pointer-events:none;';
  document.body.appendChild(statsHzReadout);
}

// Last wall-clock timestamp at which we accepted a render frame. Used by
// the FPS cap below to skip rAF firings that would put us above target.
let lastRenderedTs = 0;
function tick(timestamp) {
  if (stats) stats.begin();
  if (exporting) {
    clock.getDelta();
    if (stats) stats.end();
    requestAnimationFrame(tick);
    return;
  }

  // FPS cap: when CONFIG.targetFps > 0, skip rAF firings that arrive
  // sooner than 1/targetFps after the last accepted frame. We allow a
  // ~0.5 ms slop so a 120 Hz display capped at 60 picks exactly every
  // other rAF (16.67 ms target, intervals of ~8.33 ms).
  if (RENDER_HZ > 0 && CONFIG.targetFps > 0) {
    const now = (typeof timestamp === 'number') ? timestamp : performance.now();
    const target = 1000 / RENDER_HZ;
    if (now - lastRenderedTs < target - 0.5) {
      if (stats) stats.end();
      requestAnimationFrame(tick);
      return;
    }
    lastRenderedTs = now;
  }

  // The actual dt is for things that *want* wall-clock fidelity (uTime
  // for shader procedurals that don't need to lock to the rail rhythm).
  const rawDt = clock.getDelta();
  const wallDt = Math.min(rawDt, 1 / 15);
  // Fixed dt that drives camera motion — constant per frame, so the
  // camera advances by the same world distance every render regardless
  // of rAF jitter. Ticks lock to the visible rail rhythm.
  const frameDt = 1 / RENDER_HZ;

  mat.uniforms.uTime.value += frameDt;

  // Modulators run on frameDt so their LFOs phase-lock to the same
  // frame clock that drives camera motion — keeps anything they touch
  // (including CONFIG.speed) consistent with the rendered cadence.
  stepModulators(frameDt);

  // Advance the camera. When cameraPixelSnap is on, the per-frame step
  // is rounded to a whole-pixel multiple in world units so ticks land
  // at identical sub-pixel offsets every frame — the only way to get a
  // sharp 1-2 wu wide tick to render flicker-free at any speed. The
  // fractional residual is accumulated so the long-run average speed
  // still equals CONFIG.speed exactly.
  const desiredStep = CONFIG.speed * frameDt;
  let snappedStep = desiredStep;
  if (CONFIG.cameraPixelSnap) {
    const fbHeight = (renderer.domElement && renderer.domElement.height) || 1080;
    const pixelWu  = (1000 / Math.max(CONFIG.viewZoom, 1e-3)) / fbHeight;
    const total    = desiredStep + (tick._snapResidual || 0);
    const wholePx  = Math.round(total / pixelWu);
    snappedStep    = wholePx * pixelWu;
    tick._snapResidual = total - snappedStep;
  } else {
    tick._snapResidual = 0;
  }
  WORLD.cameraX += snappedStep;
  const worldLoop = SIM.WORLD_LOOP;
  if (Number.isFinite(worldLoop) && WORLD.cameraX >= worldLoop) WORLD.cameraX -= worldLoop;
  rebuildLaneData();
  mat.uniforms.uCameraX.value     = WORLD.cameraX;
  mat.uniforms.uLaneOriginX.value = WORLD.laneOriginSeg * CONFIG.segW;
  // World-units travelled this frame. Used by tick AA's optional
  // motion-blur slider — uses the actual snapped step, not the desired
  // one, so the motion blur matches what was rendered.
  mat.uniforms.uMotionStep.value  = Math.abs(snappedStep);

  renderer.render(scene, camera);
  // Throttled minimap playhead update (~10 Hz).
  if ((tick._acc = (tick._acc || 0) + frameDt) >= 0.1) {
    tick._acc = 0;
    updateMinimapPlayhead();
  }
  if (stats) stats.end();
  requestAnimationFrame(tick);
}
tick();

// ── PNG sequence export ──────────────────────────────────────────────────
// Walks the sim forward N frames at the configured fps (using current
// CONFIG.speed for camera travel), captures each rendered canvas as a PNG,
// and writes them out. Prefers the File System Access API for direct folder
// writes; falls back to a single .zip download via JSZip otherwise.
async function exportPngSequence() {
  const btn = document.getElementById('export-btn');
  if (!btn || exporting) return;

  const N   = Math.max(1, CONFIG.exportFrames | 0);
  const fps = Math.max(1, CONFIG.exportFps | 0);
  const dt  = 1 / fps;

  let dirHandle = null;
  if (window.showDirectoryPicker) {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      if (e.name === 'AbortError') return;   // user cancelled
      console.warn('Directory picker unavailable, falling back to ZIP', e);
    }
  }
  const zip = (!dirHandle && typeof JSZip !== 'undefined') ? new JSZip() : null;
  if (!dirHandle && !zip) {
    alert('PNG export needs either the File System Access API (Chrome/Edge)\n'
        + 'or JSZip. Neither is available in this browser.');
    return;
  }

  exporting = true;
  btn.disabled = true;
  const origLabel = btn.textContent;

  try {
    for (let i = 0; i < N; i++) {
      btn.textContent = `Exporting ${i + 1}/${N}…`;

      // Advance one frame's worth of sim, then render.
      mat.uniforms.uTime.value += dt;
      stepModulators(dt);
      WORLD.cameraX += CONFIG.speed * dt;
      rebuildLaneData();
      mat.uniforms.uCameraX.value     = WORLD.cameraX;
      mat.uniforms.uLaneOriginX.value = WORLD.laneOriginSeg * CONFIG.segW;
      mat.uniforms.uMotionStep.value  = Math.abs(CONFIG.speed) * dt;
      renderer.render(scene, camera);

      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const filename = `frame_${String(i).padStart(5, '0')}.png`;

      if (dirHandle) {
        const fh = await dirHandle.getFileHandle(filename, { create: true });
        const w  = await fh.createWritable();
        await w.write(blob);
        await w.close();
      } else {
        zip.file(filename, blob);
      }
      // Yield to the browser so the button label and any UI redraws happen.
      await new Promise(r => setTimeout(r, 0));
    }

    if (zip) {
      btn.textContent = 'Building ZIP…';
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `railway-${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  } finally {
    btn.textContent = origLabel;
    btn.disabled = false;
    exporting = false;
  }
}

// ── Panel wiring ─────────────────────────────────────────────────────────
const BLEND_MODES = ['normal', 'multiply', 'screen', 'darken', 'lighten',
                     'overlay', 'difference', 'plus-lighter'];
function blendModeIdx(name) {
  const i = BLEND_MODES.indexOf(name);
  return i < 0 ? 0 : i;
}

// Tracks the previous simMode across applyConfig() calls so we can detect
// the moment the user switches into phasing and seed it with sleeper-look
// defaults — but only if they haven't already moved those fields away from
// the global defaults.
let _prevSimMode = null;

function applyConfig() {
  if (CONFIG.simMode === 'convergence' && _prevSimMode !== 'convergence') {
    if (CONFIG.railWidth   === DEFAULT_CONFIG.railWidth)   CONFIG.railWidth   = 80;
    if (CONFIG.railSoft    === DEFAULT_CONFIG.railSoft)    CONFIG.railSoft    = 0;
    if (CONFIG.railSigma   === DEFAULT_CONFIG.railSigma)   CONFIG.railSigma   = 0.2;
    if (CONFIG.railOpacity === DEFAULT_CONFIG.railOpacity) CONFIG.railOpacity = 1;
    if (CONFIG.bgColor     === DEFAULT_CONFIG.bgColor)     CONFIG.bgColor     = '#f4f3ea';
    if (CONFIG.viewZoom    === DEFAULT_CONFIG.viewZoom)    CONFIG.viewZoom    = 0.6;
    if (CONFIG.segW        === DEFAULT_CONFIG.segW)        CONFIG.segW        = 1500;
    if (CONFIG.laneSpace   === DEFAULT_CONFIG.laneSpace)   CONFIG.laneSpace   = 216;
    syncPanelToConfig();
  }
  if (CONFIG.simMode === 'phasing' && _prevSimMode !== 'phasing') {
    if (CONFIG.railWidth   === DEFAULT_CONFIG.railWidth)   CONFIG.railWidth   = 54;
    if (CONFIG.railSoft    === DEFAULT_CONFIG.railSoft)    CONFIG.railSoft    = 0;
    if (CONFIG.railSigma   === DEFAULT_CONFIG.railSigma)   CONFIG.railSigma   = 0.2;
    if (CONFIG.railOpacity === DEFAULT_CONFIG.railOpacity) CONFIG.railOpacity = 1;
    if (CONFIG.bgColor     === DEFAULT_CONFIG.bgColor)     CONFIG.bgColor     = '#f4f3ea';
    if (CONFIG.viewZoom    === DEFAULT_CONFIG.viewZoom)    CONFIG.viewZoom    = 0.6;
    // Yellow bar like the SVG; only override the first lane swatch (rail 0
    // is the only rail in phasing mode).
    if (Array.isArray(CONFIG.laneColors) &&
        CONFIG.laneColors[0] === DEFAULT_CONFIG.laneColors[0]) {
      CONFIG.laneColors[0] = '#ffc83d';
    }
    syncPanelToConfig();
  }
  _prevSimMode = CONFIG.simMode;

  _applyConfigCore();
}

function _applyConfigCore(skipMinimap) {
  mat.uniforms.uZoom.value        = CONFIG.viewZoom;
  mat.uniforms.uRailWidth.value   = CONFIG.railWidth;
  mat.uniforms.uRailSoft.value    = CONFIG.railSoft;
  mat.uniforms.uRailSigma.value   = CONFIG.railSigma;
  mat.uniforms.uRailOpacity.value = CONFIG.railOpacity;
  mat.uniforms.uBgColor.value.set(CONFIG.bgColor);
  mat.uniforms.uBlendMode.value   = blendModeIdx(CONFIG.blendMode);
  for (let i = 0; i < MAX_LANE_BUCKETS; i++) {
    const hex = CONFIG.laneColors[i] || '#000000';
    mat.uniforms.uLaneColors.value[i].set(hex);
  }
  // Figma-profile uniforms — shoulder colors fall back to the lane color
  // so the gaussian default mode still works for presets that don't
  // include shoulder values.
  mat.uniforms.uRailProfile.value = (CONFIG.railProfile === 'figma' || CONFIG.railProfile === 1) ? 1 : 0;
  for (let i = 0; i < MAX_LANE_BUCKETS; i++) {
    const hex = (CONFIG.laneShoulderColors && CONFIG.laneShoulderColors[i])
              || CONFIG.laneColors[i]
              || '#000000';
    mat.uniforms.uLaneShoulder.value[i].set(hex);
  }
  mat.uniforms.uRailEdgeColor.value.set(CONFIG.railEdgeColor || '#C9C6BC');
  mat.uniforms.uProfileCore.value     = (typeof CONFIG.profileCore     === 'number') ? CONFIG.profileCore     : 0.22;
  mat.uniforms.uProfileShoulder.value = (typeof CONFIG.profileShoulder === 'number') ? CONFIG.profileShoulder : 0.80;
  mat.uniforms.uSegW.value             = CONFIG.segW;
  mat.uniforms.uLaneSpacePerUnit.value = CONFIG.laneSpace;

  mat.uniforms.uTickAmount.value  = CONFIG.tickAmount;
  mat.uniforms.uTickSpacing.value = CONFIG.tickSpacing;
  mat.uniforms.uTickWidth.value   = CONFIG.tickWidth;
  mat.uniforms.uTickColor.value.set(CONFIG.tickColor || '#F1EFE8');
  mat.uniforms.uTickMotionBlur.value = CONFIG.tickMotionBlur ?? 0;

  mat.uniforms.uInkTrapAmount.value    = CONFIG.inkTrapAmount;
  mat.uniforms.uInkTrapSpacing.value   = CONFIG.inkTrapSpacing;
  mat.uniforms.uInkTrapDensity.value   = CONFIG.inkTrapDensity;
  mat.uniforms.uInkTrapWidth.value     = CONFIG.inkTrapWidth;
  mat.uniforms.uInkTrapDirection.value = CONFIG.inkTrapDirection;

  mat.uniforms.uBurstAmount.value     = CONFIG.burstAmount     ?? 0;
  mat.uniforms.uBurstDensity.value    = CONFIG.burstDensity    ?? 0.5;
  mat.uniforms.uBurstCell.value       = CONFIG.burstCell       ?? 600;
  mat.uniforms.uBurstLenMin.value     = CONFIG.burstLenMin     ?? 0.25;
  mat.uniforms.uBurstLenMax.value     = CONFIG.burstLenMax     ?? 0.85;
  mat.uniforms.uBurstSpeed.value      = CONFIG.burstSpeed      ?? 800;
  mat.uniforms.uBurstRailSpread.value = CONFIG.burstRailSpread ?? 0.6;
  mat.uniforms.uBurstColor.value.set(CONFIG.burstColor || '#DE4D0E');
  mat.uniforms.uBurstLockToRail.value = CONFIG.burstLockToRail ? 1 : 0;

  // FPS cap may have changed via the panel — propagate to the loop.
  recomputeRenderHz();

  mat.uniforms.uConvergenceMode.value  =
    (CONFIG.simMode === 'convergence'
      || CONFIG.simMode === 'draw'
      || CONFIG.simMode === 'procedural'
      || CONFIG.simMode === 'branching'
      || CONFIG.simMode === 'scripted') ? 1 : 0;
  mat.uniforms.uConvergenceTaper.value = CONFIG.convergenceTaper;
  mat.uniforms.uColorMergeTaper.value  = CONFIG.colorMergeTaper ?? 0;
  mat.uniforms.uMergeTintColor.value.set(CONFIG.mergeTintColor || '#C9C6BC');
  mat.uniforms.uTrunkOnTop.value     = CONFIG.trunkOnTop ? 1 : 0;
  mat.uniforms.uMergeAlphaFade.value = CONFIG.mergeAlphaFade ?? 0;
  mat.uniforms.uBendSpread.value     = CONFIG.bendSpread ?? 0;

  mat.uniforms.uPhaseEnabled.value  = (CONFIG.simMode === 'phasing') ? 1 : 0;
  mat.uniforms.uPhaseSpacing.value  = CONFIG.phasePillSpacing;
  mat.uniforms.uPhaseLength.value   = CONFIG.phasePillLength;
  mat.uniforms.uPhaseHeight.value   = CONFIG.phasePillHeight;
  mat.uniforms.uPhaseOpacityA.value = CONFIG.phasePillOpacityA;
  mat.uniforms.uPhaseColorA.value.set(CONFIG.phaseColorA);

  SIM.setScript(CONFIG.simScript);
  // Draw mode: the user's INIT lanes are materialised as a single INIT
  // event at seg 0 in USER_EVENTS. Subsequent SPLIT/MERGE events the user
  // draws are appended after it.
  if (CONFIG.simMode === 'draw') {
    const events = Array.isArray(CONFIG.userEvents) ? CONFIG.userEvents.slice() : [];
    const noInit = !events.some(e => String(e.type).toUpperCase() === 'INIT');
    if (noInit) {
      events.unshift({ seg: 0, type: 'INIT', from: CONFIG.drawInitLanes || '3' });
    } else {
      // Keep the INIT in sync with the text input.
      for (const e of events) {
        if (String(e.type).toUpperCase() === 'INIT') {
          e.from = CONFIG.drawInitLanes || '3';
          break;
        }
      }
    }
    CONFIG.userEvents = events;
    SIM.setUserEvents(events);
  } else if (Array.isArray(CONFIG.userEvents)) {
    SIM.setUserEvents(CONFIG.userEvents);
  }
  SIM.setConvergencePattern(CONFIG.convergencePattern);
  SIM.setLoopSegs(CONFIG.loopSegs);
  SIM.setSegW(CONFIG.segW);
  SIM.setLaneSpace(CONFIG.laneSpace);
  SIM.setSeed(CONFIG.seed);
  SIM.setMergeChance(CONFIG.mergeChance);
  SIM.setSplitChance(CONFIG.splitChance);
  SIM.setSpawnChance(CONFIG.spawnChance);
  SIM.setEndChance(CONFIG.endChance);
  SIM.setMaxTracks(CONFIG.maxTracks);
  // 'deploy' is a UI-level mode — the engine itself runs 'draw' topology
  // (3 stacked rails per drawInitLanes) so the deploy overlay layers on top.
  SIM.setMode(CONFIG.simMode === 'deploy' ? 'draw' : CONFIG.simMode);
  recomputePhaseRange();
  rebuildLaneData();

  renderer.setClearColor(new THREE.Color(CONFIG.bgColor));

  // Mode-conditional panel sections — hide knobs that don't apply.
  const m = CONFIG.simMode;
  const setVis = (id, vis) => {
    const el = document.getElementById(id);
    if (el) el.style.display = vis ? '' : 'none';
  };
  setVis('scripted-only',    m === 'scripted');
  setVis('procedural-only',  m === 'procedural' || m === 'branching');
  setVis('branching-only',   m === 'branching');
  setVis('phasing-only',     m === 'phasing');
  setVis('convergence-only', m === 'convergence');
  setVis('draw-only',        m === 'draw');
  setVis('deploy-only',      m === 'deploy');
  setVis('taper-only',       m === 'convergence' || m === 'draw' || m === 'procedural' || m === 'branching' || m === 'scripted');
  setVis('loop-segs-label',  m === 'scripted' || m === 'draw' || m === 'deploy');

  // Notify the deploy overlay that CONFIG changed so it can rebuild its
  // timeline / show or hide based on the new simMode.
  if (typeof window.refreshDeployOverlay === 'function') {
    window.refreshDeployOverlay();
  }

  if (!skipMinimap) buildMinimap();
}

// ── Minimap ──────────────────────────────────────────────────────────────
// SVG diagram of the rail topology. Scripted mode: full loop. Procedural
// mode: rolling window around current cameraX. Click to seek the camera.
const SVG_NS = 'http://www.w3.org/2000/svg';
const MM = { W: 600, H: 110, PAD_X: 6, PAD_Y: 8 };
const MM_WINDOW_BEHIND = 6;
const MM_WINDOW_AHEAD  = 24;
let minimapPlayhead = null;
let minimapInfo = null;       // { segStart, segCount, segPerUnit, isProcedural }

function mmSegX(segOffset, segCount) {
  const span = MM.W - 2 * MM.PAD_X;
  return MM.PAD_X + (segOffset / segCount) * span;
}
function mmLaneY(l, laneCount) {
  // Match the shader: lane 0 at the bottom.
  const span = Math.max(1, laneCount - 1);
  return MM.H - MM.PAD_Y - (l / span) * (MM.H - 2 * MM.PAD_Y);
}
function mmCubicPath(x1, y1, x2, y2) {
  const cpx = x1 + (x2 - x1) * 0.5;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} `
       + `C ${cpx.toFixed(1)} ${y1.toFixed(1)}, ${cpx.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

function buildMinimap() {
  const svg = document.getElementById('minimap');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const isProcedural = CONFIG.simMode === 'procedural';
  const laneCount = SIM.LANE_COUNT;
  let segStart, segCount;
  if (isProcedural) {
    const cameraSeg = Math.floor(WORLD.cameraX / CONFIG.segW);
    segStart = cameraSeg - MM_WINDOW_BEHIND;
    segCount = MM_WINDOW_BEHIND + MM_WINDOW_AHEAD;
  } else {
    segStart = 0;
    segCount = (CONFIG.simMode === 'convergence') ? SIM.CONV_LOOP : SIM.LOOP_SEGS;
  }
  minimapInfo = { segStart, segCount, isProcedural };

  // Faint lane guides.
  for (let l = 0; l < laneCount; l++) {
    const y = mmLaneY(l, laneCount);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', MM.PAD_X);
    line.setAttribute('x2', MM.W - MM.PAD_X);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', 'rgba(255,255,255,0.05)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
  }

  // Connections.
  for (let i = 0; i < segCount; i++) {
    const seg = segStart + i;
    const conns = SIM.connectionsAt(seg);
    const x1 = mmSegX(i,     segCount);
    const x2 = mmSegX(i + 1, segCount);
    for (const c of conns) {
      const yA = mmLaneY(c.y1, laneCount);
      const yB = mmLaneY(c.y2, laneCount);
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', mmCubicPath(x1, yA, x2, yB));
      path.setAttribute('stroke', 'rgba(200,210,220,0.7)');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-linecap', 'round');
      svg.appendChild(path);
    }
  }

  // Playhead — created once, repositioned each frame.
  minimapPlayhead = document.createElementNS(SVG_NS, 'line');
  minimapPlayhead.setAttribute('y1', 0);
  minimapPlayhead.setAttribute('y2', MM.H);
  minimapPlayhead.setAttribute('stroke', '#6aa3c4');
  minimapPlayhead.setAttribute('stroke-width', '1.5');
  svg.appendChild(minimapPlayhead);

  // Highlight user-drawn events on top of the preset conns. The script
  // loops every LOOP_SEGS, so an event at seg N appears at every absolute
  // segment whose mod-LOOP_SEGS equals N. INIT events are rendered as a
  // dot per starting lane on the first segment column.
  const showUserEvents =
    (CONFIG.simMode === 'scripted' || CONFIG.simMode === 'draw')
    && SIM.getUserEvents;
  if (showUserEvents) {
    const userEvents = SIM.getUserEvents();
    const loopLen = Math.max(1, SIM.LOOP_SEGS);
    for (const ev of userEvents) {
      const type = String(ev.type).toUpperCase();
      if (type === 'INIT') {
        // Render INIT lanes as dots in the first visible segment column.
        const tokens = String(ev.from).replace(/,/g, ' ').split(/\s+/);
        for (const tok of tokens) {
          const lane = parseFloat(tok);
          if (!Number.isFinite(lane)) continue;
          const cx = mmSegX(0, segCount);
          const cy = mmLaneY(lane, laneCount);
          const dot = document.createElementNS(SVG_NS, 'circle');
          dot.setAttribute('cx', cx);
          dot.setAttribute('cy', cy);
          dot.setAttribute('r', 3);
          dot.setAttribute('fill', 'rgba(255, 200, 80, 0.95)');
          svg.appendChild(dot);
        }
        continue;
      }
      const k = ((ev.seg % loopLen) + loopLen) % loopLen;
      for (let i = 0; i < segCount; i++) {
        const absSeg = segStart + i;
        if (((absSeg % loopLen) + loopLen) % loopLen !== k) continue;
        const x1 = mmSegX(i,     segCount);
        const x2 = mmSegX(i + 1, segCount);
        const yA = mmLaneY(parseFloat(ev.from), laneCount);
        const yB = mmLaneY(parseFloat(ev.to ?? ev.from), laneCount);
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', mmCubicPath(x1, yA, x2, yB));
        path.setAttribute('stroke',
          type === 'SPLIT' ? 'rgba(120, 220, 255, 0.95)'
                           : 'rgba(255, 200, 80, 0.95)');
        path.setAttribute('stroke-width', '2.2');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-linecap', 'round');
        svg.appendChild(path);
      }
    }
  }

  // Drag-to-draw — active in scripted (with Draw toggle on) and draw
  // modes. Maps client (x,y) to integer (seg, lane); commits MERGE on
  // plain drag, SPLIT on shift-drag. End-segment is forced to start_seg+1
  // so each drawn line spans exactly one segment.
  let dragStart = null;
  let dragShift = false;
  let ghostPath = null;
  const pxToSegLane = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    const xRel = (clientX - rect.left) / rect.width * MM.W;
    const yRel = (clientY - rect.top)  / rect.height * MM.H;
    const segOffset = ((xRel - MM.PAD_X) / (MM.W - 2 * MM.PAD_X)) * segCount;
    const seg = Math.round(segStart + segOffset);
    const span = Math.max(1, laneCount - 1);
    const laneOffset = ((MM.H - MM.PAD_Y - yRel) / (MM.H - 2 * MM.PAD_Y)) * span;
    const lane = Math.max(0, Math.min(laneCount - 1, Math.round(laneOffset)));
    return { seg, lane };
  };
  const drawingActive = () =>
    (CONFIG.simMode === 'scripted' && CONFIG.minimapDrawMode)
    || CONFIG.simMode === 'draw';

  svg.onmousedown = (ev) => {
    if (!drawingActive() || ev.button !== 0) return;
    dragStart = pxToSegLane(ev.clientX, ev.clientY);
    dragShift = !!ev.shiftKey;
    ev.preventDefault();
  };
  svg.onmousemove = (ev) => {
    if (!dragStart) return;
    const cur = pxToSegLane(ev.clientX, ev.clientY);
    const x1 = mmSegX(dragStart.seg - segStart,     segCount);
    const x2 = mmSegX(dragStart.seg - segStart + 1, segCount);
    const yA = mmLaneY(dragStart.lane, laneCount);
    const yB = mmLaneY(cur.lane,       laneCount);
    if (!ghostPath) {
      ghostPath = document.createElementNS(SVG_NS, 'path');
      ghostPath.setAttribute('stroke',
        dragShift ? 'rgba(120, 220, 255, 0.7)' : 'rgba(255, 200, 80, 0.6)');
      ghostPath.setAttribute('stroke-width', '2.2');
      ghostPath.setAttribute('stroke-dasharray', '3 3');
      ghostPath.setAttribute('fill', 'none');
      svg.appendChild(ghostPath);
    }
    ghostPath.setAttribute('d', mmCubicPath(x1, yA, x2, yB));
  };
  const commitDrag = (ev) => {
    if (!dragStart) return;
    const end = pxToSegLane(ev.clientX, ev.clientY);
    if (end.lane !== dragStart.lane) {
      SIM.addUserEvent({
        seg:  dragStart.seg,
        type: dragShift ? 'SPLIT' : 'MERGE',
        from: dragStart.lane,
        to:   end.lane,
      });
      CONFIG.userEvents = SIM.getUserEvents();
    }
    dragStart = null;
    dragShift = false;
    if (ghostPath) { ghostPath.remove(); ghostPath = null; }
    buildMinimap();
  };
  svg.onmouseup    = commitDrag;
  svg.onmouseleave = (ev) => {
    if (dragStart) commitDrag(ev);
  };

  // Click-to-seek (suppressed during draw mode so drag doesn't also seek).
  svg.onclick = (ev) => {
    if (drawingActive()) return;
    const rect = svg.getBoundingClientRect();
    const xRel = (ev.clientX - rect.left) / rect.width * MM.W;
    const segOffset = ((xRel - MM.PAD_X) / (MM.W - 2 * MM.PAD_X)) * segCount;
    const segAbs = segStart + segOffset;
    const newCam = segAbs * CONFIG.segW;
    const wl = SIM.WORLD_LOOP;
    WORLD.cameraX = Number.isFinite(wl) ? ((newCam % wl) + wl) % wl : Math.max(0, newCam);
  };

  svg.style.cursor = drawingActive() ? 'crosshair' : 'crosshair';

  updateMinimapPlayhead();
}

function updateMinimapPlayhead() {
  if (!minimapPlayhead || !minimapInfo) return;
  const { segStart, segCount } = minimapInfo;
  const cameraSegFloat = WORLD.cameraX / CONFIG.segW;
  const offset = cameraSegFloat - segStart;
  // In procedural mode the window slides with the camera; rebuild every so
  // often so the playhead doesn't drift off the edge.
  if (minimapInfo.isProcedural &&
      (offset < 0 || offset > segCount)) {
    buildMinimap();
    return;
  }
  const x = mmSegX(offset, segCount);
  minimapPlayhead.setAttribute('x1', x);
  minimapPlayhead.setAttribute('x2', x);
}

// Auto-wire any [data-k] input/select in the panel to its CONFIG key.
function bindGlobalControls() {
  document.querySelectorAll('#panel input[data-k], #panel select[data-k]').forEach((el) => {
    const key = el.dataset.k;
    if (!(key in CONFIG)) return;
    const isNum   = el.type === 'range' || el.type === 'number';
    const isColor = el.type === 'color';
    const isCheck = el.type === 'checkbox';
    if (isCheck) {
      el.checked = !!CONFIG[key];
      el.addEventListener('change', () => {
        CONFIG[key] = el.checked;
        applyConfig();
      });
      return;
    }
    el.value = CONFIG[key];

    let readout = document.querySelector(`#panel [data-v="${key}"]`);
    let numInput = null;
    if (el.type === 'range' && readout && readout.tagName === 'SPAN') {
      numInput = document.createElement('input');
      numInput.type = 'number';
      numInput.className = 'num-readout';
      if (el.min  !== '') numInput.min  = el.min;
      if (el.max  !== '') numInput.max  = el.max;
      if (el.step !== '') numInput.step = el.step;
      numInput.value = +CONFIG[key];
      numInput.dataset.v = key;
      readout.replaceWith(numInput);
      readout = numInput;
      numInput.addEventListener('input', () => {
        const v = parseFloat(numInput.value);
        if (Number.isNaN(v)) return;
        CONFIG[key] = v;
        el.value = v;
        applyConfig();
      });
    }
    const setReadout = (v) => {
      if (!readout) return;
      if (numInput) numInput.value = v;
      else readout.textContent = isNum ? (+v).toFixed(2) : String(v);
    };
    setReadout(CONFIG[key]);
    el.addEventListener('input', () => {
      const v = isNum   ? parseFloat(el.value)
              : isColor ? el.value
              : el.value;
      CONFIG[key] = v;
      setReadout(v);
      applyConfig();
    });
  });

  // Palette controls — dropdown of curated palettes, three HSL knobs that
  // re-derive all lane colours from a spread, and a randomize button that
  // jitters the HSL knobs into a fresh palette.
  function regenerateLaneColors() {
    const c = new THREE.Color();
    const n = MAX_LANE_BUCKETS;
    for (let i = 0; i < n; i++) {
      const h = ((i / n) + CONFIG.paletteHueOffset) % 1;
      c.setHSL((h + 1) % 1, CONFIG.paletteSat, CONFIG.paletteLight);
      CONFIG.laneColors[i] = '#' + c.getHexString();
    }
  }

  const paletteSelect = document.getElementById('palette-select');
  if (paletteSelect) {
    paletteSelect.addEventListener('change', () => {
      const name = paletteSelect.value;
      if (name === 'default') {
        CONFIG.paletteHueOffset = DEFAULT_CONFIG.paletteHueOffset;
        CONFIG.paletteSat       = DEFAULT_CONFIG.paletteSat;
        CONFIG.paletteLight     = DEFAULT_CONFIG.paletteLight;
        regenerateLaneColors();
      } else if (Array.isArray(PALETTES[name])) {
        for (let i = 0; i < MAX_LANE_BUCKETS; i++) {
          CONFIG.laneColors[i] = PALETTES[name][i] || '#000000';
        }
      }
      applyConfig();
      syncPanelToConfig();
    });
  }

  // HSL knobs piggy-back on the generic data-k binding (which already syncs
  // CONFIG and the readout). We add a second listener that, *after* the
  // generic one runs, regenerates lane colours from the new HSL params and
  // re-pushes them. The dropdown drifts to "(custom)" — we don't track that.
  ['paletteHueOffset', 'paletteSat', 'paletteLight'].forEach((k) => {
    const inp = document.querySelector(`#panel input[data-k="${k}"]`);
    if (!inp) return;
    inp.addEventListener('input', () => {
      regenerateLaneColors();
      applyConfig();
      // Update only the swatches — leave the slider/readout for this knob
      // alone (the generic binding already set them) to avoid value flicker
      // mid-drag.
      document.querySelectorAll('#lane-color-row input[data-lane]').forEach((el) => {
        const i = parseInt(el.dataset.lane, 10);
        const c = CONFIG.laneColors && CONFIG.laneColors[i];
        if (c) el.value = c;
      });
    });
  });

  const rndBtn = document.getElementById('palette-randomize');
  if (rndBtn) {
    rndBtn.addEventListener('click', () => {
      CONFIG.paletteHueOffset = Math.random();
      CONFIG.paletteSat       = 0.4 + Math.random() * 0.4;
      CONFIG.paletteLight     = 0.4 + Math.random() * 0.2;
      regenerateLaneColors();
      applyConfig();
      syncPanelToConfig();
    });
  }

  // Rail color pickers — one per possible rail ID (0..MAX_LANE_BUCKETS-1).
  const laneRow = document.getElementById('lane-color-row');
  if (laneRow) {
    laneRow.innerHTML = '';
    for (let i = 0; i < MAX_LANE_BUCKETS; i++) {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.dataset.lane = String(i);
      inp.value = CONFIG.laneColors[i];
      inp.title = `Rail ${i}`;
      inp.addEventListener('input', () => {
        CONFIG.laneColors[i] = inp.value;
        applyConfig();
      });
      laneRow.appendChild(inp);
    }
  }

  // Shoulder color pickers — figma profile only. Same shape as lane-color-row.
  const shoulderRow = document.getElementById('shoulder-color-row');
  if (shoulderRow) {
    shoulderRow.innerHTML = '';
    for (let i = 0; i < MAX_LANE_BUCKETS; i++) {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.dataset.shoulder = String(i);
      inp.value = (CONFIG.laneShoulderColors && CONFIG.laneShoulderColors[i]) || CONFIG.laneColors[i] || '#000000';
      inp.title = `Rail ${i} shoulder`;
      inp.addEventListener('input', () => {
        if (!Array.isArray(CONFIG.laneShoulderColors)) {
          CONFIG.laneShoulderColors = CONFIG.laneColors.slice();
        }
        CONFIG.laneShoulderColors[i] = inp.value;
        applyConfig();
      });
      shoulderRow.appendChild(inp);
    }
  }

  // Zoetrope freeze readout + snap button. Freeze speed = tickSpacing ×
  // refresh rate; zoom drops out because period and motion both scale with
  // it. We auto-detect the refresh rate by sampling rAF intervals — 60 Hz
  // is just the initial guess until the measurement settles. On ProMotion
  // 120 Hz Macs / 144 Hz monitors the freeze multiple is very different.
  let FREEZE_HZ = 60;
  function updateFreezeHint() {
    const el = document.getElementById('freeze-hint');
    if (!el) return;
    // Use the rate the loop is actually rendering at — that's what makes
    // ticks freeze. RENDER_HZ tracks either the FPS cap or the detected
    // refresh rate, whichever is in effect.
    const rate = RENDER_HZ || FREEZE_HZ;
    const f = (CONFIG.tickSpacing | 0) * rate;
    el.textContent = `freeze ≈ ${f.toLocaleString()} wu/s @ ${rate} Hz`;
  }
  // Make this reachable from setDetectedHz / panel changes so the readout
  // tracks the live RENDER_HZ.
  window._railwayUpdateFreezeHint = updateFreezeHint;
  const snapBtn = document.getElementById('snap-freeze');
  if (snapBtn) {
    snapBtn.addEventListener('click', () => {
      CONFIG.speed = (CONFIG.tickSpacing | 0) * (RENDER_HZ || FREEZE_HZ);
      applyConfig();
      syncPanelToConfig();
    });
  }
  const tickSpacingEl = document.querySelector('#panel input[data-k="tickSpacing"]');
  if (tickSpacingEl) tickSpacingEl.addEventListener('input', updateFreezeHint);
  updateFreezeHint();

  // Measure refresh rate by sampling 60 rAF intervals, then take the
  // median (robust against the odd jittered frame) and round to a sane
  // value (60 / 90 / 120 / 144 / 165).
  (function detectRefreshRate() {
    const samples = [];
    let prev = null, count = 0;
    function probe(ts) {
      if (prev !== null) samples.push(ts - prev);
      prev = ts;
      if (++count < 60) {
        requestAnimationFrame(probe);
      } else {
        samples.sort((a, b) => a - b);
        const medianMs = samples[samples.length >> 1];
        if (medianMs > 0.5) {
          const fps = 1000 / medianMs;
          // Snap to common refresh rates.
          const stops = [30, 60, 75, 90, 120, 144, 165, 240];
          let best = stops[0], bestErr = Infinity;
          for (const s of stops) {
            const err = Math.abs(s - fps);
            if (err < bestErr) { best = s; bestErr = err; }
          }
          FREEZE_HZ = best;
          // Inform the fixed-step animation loop. RENDER_HZ tracks either
          // the user's FPS cap (CONFIG.targetFps) or this detected rate.
          setDetectedHz(best);
          updateFreezeHint();
        }
      }
    }
    requestAnimationFrame(probe);
  })();

  // Preset save / revert + drag-and-drop load.
  const saveBtn   = document.getElementById('preset-save');
  const revertBtn = document.getElementById('preset-revert');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const json = JSON.stringify(CONFIG, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `railway-preset-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }
  if (revertBtn) {
    revertBtn.addEventListener('click', () => {
      Object.assign(CONFIG, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
      applyConfig();
      syncPanelToConfig();
    });
  }

  // Drop a .json preset anywhere on the page to load it. Show a full-window
  // overlay while a file is being dragged so the target is obvious.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.items || []).some(it => it.kind === 'file')) return;
    dragDepth++;
    document.body.classList.add('dragging-preset');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('dragging-preset');
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging-preset');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const incoming = JSON.parse(text);
      if (typeof incoming !== 'object' || incoming === null) throw new Error('Preset JSON must be an object.');
      // Only copy keys that actually exist in the current schema — silently
      // ignores unknown fields so older / newer presets degrade gracefully.
      for (const key of Object.keys(CONFIG)) {
        if (key in incoming) CONFIG[key] = incoming[key];
      }
      applyConfig();
      syncPanelToConfig();
    } catch (err) {
      console.error('Failed to load preset:', err);
      alert('Could not load preset: ' + err.message);
    }
  });

  // Export button.
  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      exportPngSequence().catch(err => {
        console.error('Export failed', err);
        exportBtn.textContent = 'Export PNG sequence';
        exportBtn.disabled = false;
        exporting = false;
      });
    });
  }

  // Re-roll button — bumps the procedural seed.
  const reroll = document.getElementById('reroll-btn');
  if (reroll) {
    reroll.addEventListener('click', () => {
      CONFIG.seed = Math.floor(Math.random() * 99999) + 1;
      const seedEl = document.querySelector('#panel input[data-k="seed"]');
      if (seedEl) seedEl.value = CONFIG.seed;
      applyConfig();
    });
  }

  // ── Modulators panel ────────────────────────────────────────────────────
  function rebuildModulatorsList() {
    const root = document.getElementById('modulators-list');
    if (!root) return;
    root.innerHTML = '';
    CONFIG.modulators = CONFIG.modulators || [];
    // Drop any modulator whose target was removed from MOD_TARGETS so old
    // presets don't render stale rows.
    const validKeys = new Set(MOD_TARGETS.map(t => t.key));
    CONFIG.modulators = CONFIG.modulators.filter(m => m && validKeys.has(m.target));
    CONFIG.modulators.forEach((m, idx) => root.appendChild(renderModCard(m, idx)));
  }
  function renderModCard(m, idx) {
    const card = document.createElement('div');
    card.className = 'mod-card' + (m.enabled ? '' : ' disabled');
    card.dataset.idx = idx;

    // Row 1: target select + remove button.
    const row1 = document.createElement('div');
    row1.className = 'mod-row';
    const sel = document.createElement('select');
    for (const t of MOD_TARGETS) {
      const opt = document.createElement('option');
      opt.value = t.key; opt.textContent = t.label;
      if (t.key === m.target) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      m.target = sel.value;
      // Re-anchor the new target's range around its current value so the
      // user starts from "stays put" rather than an arbitrary span.
      const tgtNew = MOD_TARGETS.find(t => t.key === m.target) || MOD_TARGETS[0];
      const cur    = CONFIG[m.target];
      const range  = (tgtNew.max - tgtNew.min) * 0.1;
      if (typeof cur === 'number') {
        m.min = cur;
        m.max = cur + range;
      }
      rebuildModulatorsList();
    });
    row1.appendChild(sel);
    const rm = document.createElement('button');
    rm.className = 'mod-remove';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.addEventListener('click', () => {
      CONFIG.modulators.splice(idx, 1);
      rebuildModulatorsList();
    });
    row1.appendChild(rm);
    card.appendChild(row1);

    const tgt = MOD_TARGETS.find(t => t.key === m.target) || MOD_TARGETS[0];
    migrateModulator(m);

    // Row 2: min + max — wave is mapped 0..1 across [min, max] so an
    // asymmetric range like 1200..2400 stays at 1200 minimum.
    const row2 = document.createElement('div');
    row2.className = 'mod-row';
    row2.appendChild(makeNumLabel('Min', m.min, tgt.step, (v) => m.min = v));
    row2.appendChild(makeNumLabel('Max', m.max, tgt.step, (v) => m.max = v));
    card.appendChild(row2);

    // Row 3: cycle + waveform.
    const row3 = document.createElement('div');
    row3.className = 'mod-row';
    row3.appendChild(makeNumLabel('Cycle s', m.cycle, 0.1, (v) => m.cycle = Math.max(0.05, v)));
    const wsel = document.createElement('select');
    for (const w of MOD_WAVEFORMS) {
      const opt = document.createElement('option');
      opt.value = w.key; opt.textContent = w.label;
      if (w.key === m.waveform) opt.selected = true;
      wsel.appendChild(opt);
    }
    wsel.addEventListener('change', () => { m.waveform = wsel.value; });
    row3.appendChild(wsel);
    card.appendChild(row3);

    // Row 4: enabled toggle.
    const row4 = document.createElement('div');
    row4.className = 'mod-row';
    const tg = document.createElement('label');
    tg.className = 'mod-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!m.enabled;
    cb.addEventListener('change', () => {
      m.enabled = cb.checked;
      card.classList.toggle('disabled', !m.enabled);
    });
    tg.appendChild(cb);
    tg.appendChild(document.createTextNode(' enabled'));
    row4.appendChild(tg);
    card.appendChild(row4);

    return card;
  }
  function makeNumLabel(text, val, step, onChange) {
    const lab = document.createElement('label');
    lab.className = 'mod-num';
    lab.appendChild(document.createTextNode(text));
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = step;
    inp.value = val;
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (!Number.isNaN(v)) onChange(v);
    });
    lab.appendChild(inp);
    return lab;
  }
  function addModulator() {
    const tgt = MOD_TARGETS[0];
    const cur = CONFIG[tgt.key];
    const span = (tgt.max - tgt.min) * 0.1;
    const min  = (typeof cur === 'number') ? cur : tgt.min;
    CONFIG.modulators = CONFIG.modulators || [];
    CONFIG.modulators.push({
      target:   tgt.key,
      min:      min,
      max:      Math.min(min + span, tgt.max),
      cycle:    6,
      waveform: 'sin',
      enabled:  true,
      t:        0,
    });
    rebuildModulatorsList();
  }
  // Expose for syncPanelToConfig (preset load/revert) and initial render.
  window._railwayRebuildModulators = rebuildModulatorsList;
  const addBtn = document.getElementById('add-modulator');
  if (addBtn) addBtn.addEventListener('click', addModulator);
  rebuildModulatorsList();

  // Minimap draw mode + clear-drawings buttons.
  const drawToggle = document.getElementById('draw-toggle');
  if (drawToggle) {
    drawToggle.checked = !!CONFIG.minimapDrawMode;
    drawToggle.addEventListener('change', () => {
      CONFIG.minimapDrawMode = drawToggle.checked;
      buildMinimap();
    });
  }
  const clearDrawings = document.getElementById('clear-drawings');
  if (clearDrawings) {
    clearDrawings.addEventListener('click', () => {
      SIM.clearUserEvents();
      CONFIG.userEvents = [];
      buildMinimap();
    });
  }

  // Collapse button.
  const toggle = document.getElementById('panel-toggle');
  const panel  = document.getElementById('panel');
  if (toggle && panel) {
    toggle.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      toggle.textContent = panel.classList.contains('collapsed') ? '+' : '–';
    });
  }
}

// Push the current CONFIG values back into every panel control. Used after
// preset import or revert — touches the data-k inputs/selects, the [data-v]
// readouts (which the range-binding rewrites into editable number inputs),
// and the lane-color pickers (whose values come from CONFIG.laneColors[i]).
function syncPanelToConfig() {
  document.querySelectorAll('#panel input[data-k], #panel select[data-k]').forEach((el) => {
    const key = el.dataset.k;
    if (!(key in CONFIG)) return;
    if (el.type === 'checkbox') el.checked = !!CONFIG[key];
    else el.value = CONFIG[key];
  });
  document.querySelectorAll('#panel [data-v]').forEach((el) => {
    const key = el.dataset.v;
    if (!(key in CONFIG)) return;
    if (el.tagName === 'INPUT') el.value = CONFIG[key];
    else el.textContent = (typeof CONFIG[key] === 'number')
      ? Number(CONFIG[key]).toFixed(2) : String(CONFIG[key]);
  });
  document.querySelectorAll('#lane-color-row input[data-lane]').forEach((el) => {
    const i = parseInt(el.dataset.lane, 10);
    const c = CONFIG.laneColors && CONFIG.laneColors[i];
    if (c) el.value = c;
  });
  document.querySelectorAll('#shoulder-color-row input[data-shoulder]').forEach((el) => {
    const i = parseInt(el.dataset.shoulder, 10);
    const c = (CONFIG.laneShoulderColors && CONFIG.laneShoulderColors[i])
            || (CONFIG.laneColors && CONFIG.laneColors[i]);
    if (c) el.value = c;
  });
  if (typeof window._railwayRebuildModulators === 'function') {
    window._railwayRebuildModulators();
  }
}

bindGlobalControls();
applyConfig();

window.RAILWAY = { CONFIG, mat, applyConfig, renderer, scene, camera, WORLD, rebuildLaneData };
console.log('Railway minimal — sim + rails. Tweak via RAILWAY.CONFIG.');

// Load the default preset on page open. Drops back to the built-in
// DEFAULT_CONFIG silently if the file isn't reachable so the page still
// renders something. Same shape as the drag-drop loader: copy only
// schema-matching keys, then re-apply + sync panel.
(async () => {
  try {
    const res = await fetch('presets/colourExploration_merging_05.json?t=' + Date.now());
    if (!res.ok) return;
    const incoming = await res.json();
    if (typeof incoming !== 'object' || incoming === null) return;
    for (const key of Object.keys(CONFIG)) {
      if (key in incoming) CONFIG[key] = incoming[key];
    }
    applyConfig();
    if (typeof syncPanelToConfig === 'function') syncPanelToConfig();
  } catch (err) {
    console.warn('Default preset load failed:', err);
  }
})();
