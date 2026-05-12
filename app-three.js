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

  // ── Ink traps — periodic asymmetric hills along each rail ────────────
  // Per-rail random pattern (hash of segment idx × lane Y). Each trap
  // shifts the rail's edge by a Gaussian profile so the rail "swells" out.
  inkTrapAmount:    0,        // peak hill height (world units; 0 = off)
  inkTrapSpacing:   1050,     // average distance between trap candidates
  inkTrapDensity:   0.45,     // 0..1 — probability a candidate slot fires
  inkTrapWidth:     368,      // hill half-width (world units)
  inkTrapDirection: 0.28,     // 0 = all upward, 1 = all downward, 0.5 = mixed

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

  // PNG sequence export
  exportFrames: 120,
  exportFps:    30,

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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
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
const segPhaseArray = new Float32Array(WORLD.bufferSegs);
const PHASE_MAX_RANGE   = 6;   // lanes 0..6 = full spread → phase 0
const PHASE_MERGE_RANGE = 3;   // any range ≤ this counts as "fully
                               // merged" → phase 1. Keeps width flat
                               // across stack/unstack within the merged
                               // zone (e.g. shuffle pattern).

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
      // No conns at this segment yet — treat as "fully spread" so the
      // adjacent-row interpolation doesn't mistakenly narrow.
      segPhaseArray[r] = 0;
    } else {
      const range = yMax - yMin;
      const denom = PHASE_MAX_RANGE - PHASE_MERGE_RANGE;
      segPhaseArray[r] = Math.max(0, Math.min(1,
        (PHASE_MAX_RANGE - range) / denom));
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
    uLaneColors:  { value: CONFIG.laneColors.map(h => new THREE.Color(h)) },

    // Ticks (zoetrope)
    uTickAmount:  { value: CONFIG.tickAmount },
    uTickSpacing: { value: CONFIG.tickSpacing },
    uTickWidth:   { value: CONFIG.tickWidth },

    // Ink traps
    uInkTrapAmount:    { value: CONFIG.inkTrapAmount },
    uInkTrapSpacing:   { value: CONFIG.inkTrapSpacing },
    uInkTrapDensity:   { value: CONFIG.inkTrapDensity },
    uInkTrapWidth:     { value: CONFIG.inkTrapWidth },
    uInkTrapDirection: { value: CONFIG.inkTrapDirection },

    // Convergence — flag enables per-conn merge tapering.
    uConvergenceMode:  { value: 0 },
    uConvergenceTaper: { value: CONFIG.convergenceTaper },
    uSegPhases:        { value: segPhaseArray },

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
    uniform vec3 uLaneColors[MAX_LANE_BUCKETS];

    uniform float uTickAmount;
    uniform float uTickSpacing;
    uniform float uTickWidth;

    uniform float uInkTrapAmount;
    uniform float uInkTrapSpacing;
    uniform float uInkTrapDensity;
    uniform float uInkTrapWidth;
    uniform float uInkTrapDirection;

    uniform float uPhaseEnabled;
    uniform float uPhaseSpacing;
    uniform float uPhaseLength;
    uniform float uPhaseHeight;
    uniform float uConvergenceMode;
    uniform float uConvergenceTaper;
    // Per-segment merge phase, one entry per buffer row. 0 = spread,
    // 1 = fully merged. Sized to match WORLD.bufferSegs (33).
    uniform float uSegPhases[33];

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
    float tickGap(float wx) {
      if (uTickAmount < 1e-3) return 1.0;
      float sp     = max(uTickSpacing, 1.0);
      float u      = wx / sp;
      float frac   = u - floor(u);
      float dist   = min(frac, 1.0 - frac) * sp;
      float halfW  = max(uTickWidth, 0.0) * 0.5;
      float aa     = max(fwidth(wx), 1e-4);
      float inside = 1.0 - smoothstep(halfW - aa, halfW + aa, dist);
      return 1.0 - inside * uTickAmount;
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
      for (int i = 0; i < MAX_LANE_BUCKETS; i++) laneCov[i] = 0.0;

      // Single per-fragment computation — applies uniformly to every rail
      // at this wx so all rails freeze together at the zoetrope speed.
      float gap = tickGap(wx);

      for (int r = 0; r < 33; r++) {
        if (float(r) >= uBufferSegs) break;

        // Phase at the START and END of this segment row. The start phase
        // is the previous row's end phase (same loop, one step earlier),
        // so the bend segment smoothly interpolates from spread to merge.
        float phaseEnd   = uSegPhases[r];
        float phaseStart = (r > 0) ? uSegPhases[r - 1] : phaseEnd;

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

          float fillCov = 1.0 - smoothstep(-aa, aa, d);
          float dHalo   = max(d, 0.0) / max(hHalfT, 1e-4);
          float bodyC   = exp(-(dHalo * dHalo) / (2.0 * sig * sig)) * softK;
          float alpha   = max(fillCov, bodyC) * clamp(uRailOpacity, 0.0, 1.0) * gap;
          if (alpha < 1e-4) continue;

          // Constant-index write — WebGL1 needs static indexing into local
          // float arrays on some drivers.
          for (int k = 0; k < MAX_LANE_BUCKETS; k++) {
            if (k == rid && alpha > laneCov[k]) laneCov[k] = alpha;
          }
        }
      }

      vec3 dst = uBgColor;
      float maxA = 0.0;
      for (int i = 0; i < MAX_LANE_BUCKETS; i++) {
        float a = laneCov[i];
        if (a < 1e-4) continue;
        vec3 src     = laneColor(i);
        vec3 blended = blendOp(dst, src, uBlendMode);
        dst = mix(dst, blended, a);
        if (a > maxA) maxA = a;
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
  { key: 'phasePillSpacing',   label: 'Pill spacing',  min: 20,   max: 800,   step: 1     },
  { key: 'phasePillLength',    label: 'Pill length',   min: 4,    max: 400,   step: 1     },
  { key: 'phasePillHeight',    label: 'Pill height',   min: 2,    max: 200,   step: 1     },
  { key: 'phasePillOpacityA',  label: 'Pill opacity',  min: 0,    max: 1,     step: 0.01  },
  { key: 'convergenceTaper',   label: 'Merge taper',   min: 0,    max: 1,     step: 0.01  },
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

function tick() {
  if (exporting) {
    // Discard accumulated dt so the first frame after export resumes cleanly.
    clock.getDelta();
    requestAnimationFrame(tick);
    return;
  }

  const dt = clock.getDelta();
  mat.uniforms.uTime.value += dt;

  // Run user-defined LFO modulators first so any value they touch — including
  // CONFIG.speed itself — is current when the rest of the frame uses it.
  stepModulators(dt);

  WORLD.cameraX += CONFIG.speed * dt;
  const worldLoop = SIM.WORLD_LOOP;
  if (Number.isFinite(worldLoop) && WORLD.cameraX >= worldLoop) WORLD.cameraX -= worldLoop;
  rebuildLaneData();
  mat.uniforms.uCameraX.value     = WORLD.cameraX;
  mat.uniforms.uLaneOriginX.value = WORLD.laneOriginSeg * CONFIG.segW;

  renderer.render(scene, camera);
  // Throttled minimap playhead update (~10 Hz).
  if ((tick._acc = (tick._acc || 0) + dt) >= 0.1) {
    tick._acc = 0;
    updateMinimapPlayhead();
  }
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
  mat.uniforms.uSegW.value             = CONFIG.segW;
  mat.uniforms.uLaneSpacePerUnit.value = CONFIG.laneSpace;

  mat.uniforms.uTickAmount.value  = CONFIG.tickAmount;
  mat.uniforms.uTickSpacing.value = CONFIG.tickSpacing;
  mat.uniforms.uTickWidth.value   = CONFIG.tickWidth;

  mat.uniforms.uInkTrapAmount.value    = CONFIG.inkTrapAmount;
  mat.uniforms.uInkTrapSpacing.value   = CONFIG.inkTrapSpacing;
  mat.uniforms.uInkTrapDensity.value   = CONFIG.inkTrapDensity;
  mat.uniforms.uInkTrapWidth.value     = CONFIG.inkTrapWidth;
  mat.uniforms.uInkTrapDirection.value = CONFIG.inkTrapDirection;

  mat.uniforms.uConvergenceMode.value  =
    (CONFIG.simMode === 'convergence'
      || CONFIG.simMode === 'draw'
      || CONFIG.simMode === 'procedural'
      || CONFIG.simMode === 'branching') ? 1 : 0;
  mat.uniforms.uConvergenceTaper.value = CONFIG.convergenceTaper;

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
  SIM.setMode(CONFIG.simMode);
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
  setVis('taper-only',       m === 'convergence' || m === 'draw' || m === 'procedural' || m === 'branching');
  setVis('loop-segs-label',  m === 'scripted' || m === 'draw');

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

  // Zoetrope freeze readout + snap button. Freeze speed = tickSpacing ×
  // refresh rate; zoom drops out because period and motion both scale with
  // it. We assume 60 Hz — common case; the button just sets CONFIG.speed.
  const FREEZE_HZ = 60;
  function updateFreezeHint() {
    const el = document.getElementById('freeze-hint');
    if (!el) return;
    const f = (CONFIG.tickSpacing | 0) * FREEZE_HZ;
    el.textContent = `freeze ≈ ${f.toLocaleString()} wu/s @ ${FREEZE_HZ} Hz`;
  }
  const snapBtn = document.getElementById('snap-freeze');
  if (snapBtn) {
    snapBtn.addEventListener('click', () => {
      CONFIG.speed = (CONFIG.tickSpacing | 0) * FREEZE_HZ;
      applyConfig();
      syncPanelToConfig();
    });
  }
  const tickSpacingEl = document.querySelector('#panel input[data-k="tickSpacing"]');
  if (tickSpacingEl) tickSpacingEl.addEventListener('input', updateFreezeHint);
  updateFreezeHint();

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
    el.value = CONFIG[key];
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
  if (typeof window._railwayRebuildModulators === 'function') {
    window._railwayRebuildModulators();
  }
}

bindGlobalControls();
applyConfig();

window.RAILWAY = { CONFIG, mat, applyConfig, renderer, scene, camera, WORLD, rebuildLaneData };
console.log('Railway minimal — sim + rails. Tweak via RAILWAY.CONFIG.');
