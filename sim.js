// Lane simulator — persistent-rail port. Each rail has a stable id (0..8)
// and a current lane index. SPLIT spawns new rails (capped at MAX_RAILS);
// MERGE relocates a rail to a target lane (overlapping any rail already
// there) — rails do not die. The renderer uses rail IDs to color each rail
// independently, so overlapping rails composite via the chosen blend mode.
//
// Connection record: { id, y1, y2 } where y1=start lane, y2=end lane, id=
// stable rail identifier. Each segment's rails each emit exactly one conn;
// SPLITs additionally emit one extra conn per spawned rail.

const SIM = (() => {

  // Hard cap on simultaneous rails — must match MAX_LANE_BUCKETS in
  // app-three.js / its GLSL #define. IDs are reused only when a rail is
  // ever removed, but in this model rails persist forever, so once 9 rails
  // exist, further SPLITs become no-ops.
  const MAX_RAILS = 9;

  // ── Scripts (match TD tables sim_script_v1, sim_script_v5) ───────────────
  const SCRIPTS = {
    v1: [
      { seg: 0,  type: 'INIT',  from: 3 },
      { seg: 5,  type: 'SPLIT', from: 3, to: 2 },
      { seg: 5,  type: 'SPLIT', from: 3, to: 4 },
      { seg: 13, type: 'MERGE', from: 2, to: 3 },
      { seg: 13, type: 'MERGE', from: 4, to: 3 },
      { seg: 20, type: 'SPLIT', from: 3, to: 2 },
      { seg: 20, type: 'SPLIT', from: 3, to: 4 },
      { seg: 28, type: 'MERGE', from: 2, to: 3 },
      { seg: 28, type: 'MERGE', from: 4, to: 3 },
    ],
    v5: [
      { seg: 0,  type: 'INIT',  from: 3 },
      { seg: 5,  type: 'SPLIT', from: 3, to: 2 },
      { seg: 5,  type: 'SPLIT', from: 3, to: 4 },
      { seg: 10, type: 'SPLIT', from: 2, to: 1 },
      { seg: 10, type: 'SPLIT', from: 4, to: 5 },
      { seg: 18, type: 'MERGE', from: 1, to: 2 },
      { seg: 18, type: 'MERGE', from: 5, to: 4 },
      { seg: 23, type: 'MERGE', from: 2, to: 3 },
      { seg: 23, type: 'MERGE', from: 4, to: 3 },
    ],
  };

  let ACTIVE = SCRIPTS.v1;

  // Built-in convergence patterns — three rails at lanes 0/3/6 always start
  // and end the loop at those lanes, but how they stack at the merge segment
  // (seg 8) varies. Lane positions are floats so rails can sit at sub-lane
  // offsets (rendered as-is, no width thinning).
  //   adjacent — order preserved, lanes 2/3/4 (touching)
  //   stacked  — heavy overlap near centre (2.85/3/3.15)
  //   swap     — yellow→top, red→middle, purple→bottom (lanes 2.5/3.5/4.5)
  //   gap      — yellow+red touching at top, purple separated (2/3/5)
  //   inverted — full reverse: purple→top, yellow stays, red→bottom
  const CONV_PATTERNS = {
    adjacent: [
      { seg: 0,  type: 'INIT',  from: '0 3 6' },
      { seg: 8,  type: 'MERGE', from: 0, to: 2 },
      { seg: 8,  type: 'MERGE', from: 6, to: 4 },
      { seg: 16, type: 'MERGE', from: 2, to: 0 },
      { seg: 16, type: 'MERGE', from: 4, to: 6 },
    ],
    stacked: [
      { seg: 0,  type: 'INIT',  from: '0 3 6' },
      { seg: 8,  type: 'MERGE', from: 0, to: 2.85 },
      { seg: 8,  type: 'MERGE', from: 6, to: 3.15 },
      { seg: 16, type: 'MERGE', from: 2.85, to: 0 },
      { seg: 16, type: 'MERGE', from: 3.15, to: 6 },
    ],
    swap: [
      { seg: 0,  type: 'INIT',  from: '0 3 6' },
      { seg: 8,  type: 'MERGE', from: 0, to: 3.5 },
      { seg: 8,  type: 'MERGE', from: 3, to: 2.5 },
      { seg: 8,  type: 'MERGE', from: 6, to: 4.5 },
      { seg: 16, type: 'MERGE', from: 3.5, to: 0 },
      { seg: 16, type: 'MERGE', from: 2.5, to: 3 },
      { seg: 16, type: 'MERGE', from: 4.5, to: 6 },
    ],
    gap: [
      { seg: 0,  type: 'INIT',  from: '0 3 6' },
      { seg: 8,  type: 'MERGE', from: 3, to: 2 },
      { seg: 8,  type: 'MERGE', from: 0, to: 3 },
      { seg: 8,  type: 'MERGE', from: 6, to: 5 },
      { seg: 16, type: 'MERGE', from: 2, to: 3 },
      { seg: 16, type: 'MERGE', from: 3, to: 0 },
      { seg: 16, type: 'MERGE', from: 5, to: 6 },
    ],
    inverted: [
      { seg: 0,  type: 'INIT',  from: '0 3 6' },
      { seg: 8,  type: 'MERGE', from: 0, to: 4 },
      { seg: 8,  type: 'MERGE', from: 6, to: 2 },
      { seg: 16, type: 'MERGE', from: 4, to: 0 },
      { seg: 16, type: 'MERGE', from: 2, to: 6 },
    ],
    // Tight sub-lane stack at centre with order reversed — top rail goes
    // to the bottom of the stack, bottom rail to the top, so the ribbons
    // cross over each other while overlapping at centre.
    weave: [
      { seg: 0,  type: 'INIT',  from: '0 3 6' },
      { seg: 8,  type: 'MERGE', from: 0, to: 3.2 },
      { seg: 8,  type: 'MERGE', from: 3, to: 3.0 },
      { seg: 8,  type: 'MERGE', from: 6, to: 2.8 },
      { seg: 16, type: 'MERGE', from: 3.2, to: 0 },
      { seg: 16, type: 'MERGE', from: 3.0, to: 3 },
      { seg: 16, type: 'MERGE', from: 2.8, to: 6 },
    ],
    // Long, varied braid section — outer rails repeatedly cross at
    // irregular intervals and varying widths, middle rail drifts around
    // sub-lane offsets. Loop is 48 segments (declared in CONV_LOOPS) so
    // the merged zone occupies segs 8–40 (~33 segs of variation).
    braid: [
      { seg: 0,  type: 'INIT',  from: '0 3 6' },
      // Bend in.
      { seg: 8,  type: 'MERGE', from: 0, to: 3.2 },
      { seg: 8,  type: 'MERGE', from: 6, to: 2.8 },
      // Wide cross — outer rails fan to ±0.4.
      { seg: 10, type: 'MERGE', from: 3.2, to: 2.6 },
      { seg: 10, type: 'MERGE', from: 2.8, to: 3.4 },
      { seg: 11, type: 'MERGE', from: 3,   to: 2.85 },
      // Pull back to medium cross, swapping order again.
      { seg: 13, type: 'MERGE', from: 2.6, to: 3.3 },
      { seg: 13, type: 'MERGE', from: 3.4, to: 2.7 },
      { seg: 15, type: 'MERGE', from: 2.85, to: 3.15 },
      // Wider still.
      { seg: 17, type: 'MERGE', from: 3.3, to: 2.5 },
      { seg: 17, type: 'MERGE', from: 2.7, to: 3.5 },
      // Tight cross with middle drift.
      { seg: 19, type: 'MERGE', from: 2.5, to: 3.4 },
      { seg: 19, type: 'MERGE', from: 3.5, to: 2.6 },
      { seg: 19, type: 'MERGE', from: 3.15, to: 2.95 },
      // Medium swap.
      { seg: 22, type: 'MERGE', from: 3.4, to: 2.7 },
      { seg: 22, type: 'MERGE', from: 2.6, to: 3.3 },
      { seg: 24, type: 'MERGE', from: 2.95, to: 3.05 },
      // Tight cross — outer rails close in.
      { seg: 26, type: 'MERGE', from: 2.7, to: 3.4 },
      { seg: 26, type: 'MERGE', from: 3.3, to: 2.6 },
      { seg: 28, type: 'MERGE', from: 3.05, to: 2.85 },
      // Medium swap.
      { seg: 30, type: 'MERGE', from: 3.4, to: 2.7 },
      { seg: 30, type: 'MERGE', from: 2.6, to: 3.3 },
      // Outer rails fan out, middle returns to centre.
      { seg: 32, type: 'MERGE', from: 2.7, to: 2.5 },
      { seg: 32, type: 'MERGE', from: 3.3, to: 3.5 },
      { seg: 32, type: 'MERGE', from: 2.85, to: 3 },
      // Final cross.
      { seg: 34, type: 'MERGE', from: 2.5, to: 3.3 },
      { seg: 34, type: 'MERGE', from: 3.5, to: 2.7 },
      // Settle to weave-end positions for clean bend-out.
      { seg: 36, type: 'MERGE', from: 3.3, to: 3.2 },
      { seg: 36, type: 'MERGE', from: 2.7, to: 2.8 },
      // Bend out.
      { seg: 40, type: 'MERGE', from: 3.2, to: 0 },
      { seg: 40, type: 'MERGE', from: 2.8, to: 6 },
    ],
    // Bends down to the adjacent stack (narrow) and then stacks/unstacks
    // twice while still narrow before bending back. Demonstrates merge
    // and split events happening at the smaller, tapered rail width.
    shuffle: [
      { seg: 0,  type: 'INIT',  from: '0 3 6' },
      { seg: 8,  type: 'MERGE', from: 0, to: 2 },
      { seg: 8,  type: 'MERGE', from: 6, to: 4 },
      { seg: 10, type: 'MERGE', from: 2, to: 3 },
      { seg: 10, type: 'MERGE', from: 4, to: 3 },
      { seg: 12, type: 'MERGE', from: 3, to: 2 },
      { seg: 12, type: 'MERGE', from: 3, to: 4 },
      { seg: 14, type: 'MERGE', from: 2, to: 3 },
      { seg: 14, type: 'MERGE', from: 4, to: 3 },
      { seg: 15, type: 'MERGE', from: 3, to: 2 },
      { seg: 15, type: 'MERGE', from: 3, to: 4 },
      { seg: 16, type: 'MERGE', from: 2, to: 0 },
      { seg: 16, type: 'MERGE', from: 4, to: 6 },
    ],
  };
  // Per-pattern loop length. Patterns not listed here use DEFAULT_CONV_LOOP.
  const CONV_LOOPS = {
    braid: 48,
  };
  const DEFAULT_CONV_LOOP = 24;
  let CONV_SCRIPT = CONV_PATTERNS.adjacent;
  let CONV_LOOP = DEFAULT_CONV_LOOP;

  // User-drawn events appended to the active scripted-mode timeline.
  // Same shape as ACTIVE entries: { seg, type, from, to }. Persist across
  // script changes so a v1↔v5 swap doesn't wipe the user's drawings.
  let USER_EVENTS = [];

  let MODE = 'scripted';

  let MERGE_CHANCE = 0.4;
  let SPLIT_CHANCE = 0.9;
  let SPAWN_CHANCE = 0.2;   // branching-mode rail spawn (edge entry)
  let END_CHANCE   = 0.05;
  let MAX_TRACKS   = 7;
  let SEED         = 1;

  let LOOP_SEGS  = 30;
  let SEG_W      = 400;
  let CENTER_Y   = 0;
  let LANE_SPACE = 180;
  let LANE_COUNT = 7;
  const CENTER_IDX = () => (LANE_COUNT - 1) / 2;

  // ── Seeded RNG (mulberry32) ──────────────────────────────────────────────
  let rngState = 1;
  function rngReset(s) { rngState = ((s >>> 0) || 1); }
  function rng() {
    rngState = (rngState + 0x6D2B79F5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const laneToY = (l) => CENTER_Y + (l - CENTER_IDX()) * LANE_SPACE;
  const mod = (n, m) => ((n % m) + m) % m;
  const smoothstep = (t) => {
    const s = Math.max(0, Math.min(1, t));
    return s * s * (3 - 2 * s);
  };

  // ── Rail helpers ─────────────────────────────────────────────────────────
  function copyRails(rails) {
    return rails.map(r => ({ id: r.id, lane: r.lane }));
  }

  function nextAvailableId(usedIds) {
    for (let i = 0; i < MAX_RAILS; i++) {
      if (!usedIds.has(i)) return i;
    }
    return -1;
  }

  // Initial rail set — from INIT event's `from` lanes (space/comma list),
  // else default to lane 3 (or last lane if LANE_COUNT < 4).
  function initialRails() {
    const lanes = [];
    const list = (MODE === 'convergence') ? CONV_SCRIPT
               : (MODE === 'draw')        ? USER_EVENTS
               : ACTIVE;
    const init = list.find(e => String(e.type).toUpperCase() === 'INIT');
    if (init) {
      for (const tok of String(init.from).replace(/,/g, ' ').split(/\s+/)) {
        const i = parseFloat(tok);
        if (Number.isFinite(i) && i >= 0 && i < LANE_COUNT) lanes.push(i);
      }
    }
    if (lanes.length === 0) lanes.push(Math.min(3, LANE_COUNT - 1));
    return lanes.map((lane, idx) => ({ id: idx, lane }));
  }

  // Bucket events by loop-seg (INIT filtered).
  function bucketEventsFromList(list, loopSize) {
    const b = {};
    for (const e of list) {
      if (String(e.type).toUpperCase() === 'INIT') continue;
      const s = mod(e.seg, loopSize);
      (b[s] = b[s] || []).push(e);
    }
    return b;
  }
  function bucketEvents() {
    return bucketEventsFromList(ACTIVE.concat(USER_EVENTS), LOOP_SEGS);
  }

  // ── Step segment for scripted mode ───────────────────────────────────────
  // Apply this segment's events to the rail list. Multiple SPLITs from the
  // same source lane share one trunk-continuation conn and spawn N new rails
  // (matches v1 / v5 which emit two SPLITs per Y-junction). MERGE relocates
  // an existing rail to a target lane — rails persist.
  function stepSegmentRails(rails, events) {
    const conns = [];
    const endRails = copyRails(rails);
    const handled = new Set();          // rail IDs whose conn is already added

    // Group SPLITs by source lane.
    const splitsBySrc = new Map();
    for (const ev of events) {
      if (String(ev.type).toUpperCase() !== 'SPLIT') continue;
      const la = parseFloat(ev.from);
      if (!Number.isFinite(la)) continue;
      if (!splitsBySrc.has(la)) splitsBySrc.set(la, []);
      splitsBySrc.get(la).push(ev);
    }

    for (const [srcLane, evs] of splitsBySrc) {
      const trunk = rails.find(r => r.lane === srcLane && !handled.has(r.id));
      if (!trunk) continue;
      conns.push({ id: trunk.id, y1: srcLane, y2: srcLane });
      handled.add(trunk.id);

      const usedIds = new Set([
        ...rails.map(r => r.id),
        ...endRails.map(r => r.id),
      ]);
      for (const ev of evs) {
        const lb = ev.to !== undefined ? parseFloat(ev.to) : NaN;
        if (!Number.isFinite(lb) || lb < 0 || lb >= LANE_COUNT) continue;
        const newId = nextAvailableId(usedIds);
        if (newId === -1) continue;     // rail-cap hit
        usedIds.add(newId);
        conns.push({ id: newId, y1: srcLane, y2: lb });
        endRails.push({ id: newId, lane: lb });
      }
    }

    // MERGEs: relocate a rail at `from` to `to`. The rail keeps its ID and
    // ends up overlapping whatever rail was already at `to`.
    for (const ev of events) {
      if (String(ev.type).toUpperCase() !== 'MERGE') continue;
      const la = parseFloat(ev.from);
      const lb = ev.to !== undefined ? parseFloat(ev.to) : NaN;
      if (!Number.isFinite(la) || !Number.isFinite(lb) || lb < 0 || lb >= LANE_COUNT) continue;
      const rail = rails.find(r => r.lane === la && !handled.has(r.id));
      if (!rail) continue;
      conns.push({ id: rail.id, y1: la, y2: lb });
      handled.add(rail.id);
      const er = endRails.find(r => r.id === rail.id);
      if (er) er.lane = lb;
    }

    // Pass-through — every rail without a custom conn goes straight.
    for (const rail of rails) {
      if (!handled.has(rail.id)) {
        conns.push({ id: rail.id, y1: rail.lane, y2: rail.lane });
      }
    }

    return { conns, endRails };
  }

  // ── Step segment for procedural mode ─────────────────────────────────────
  // Metro-line model: each rail is an independent walker on the lane grid.
  // Per segment, every rail rolls its own shift (±1 lane or stay), with no
  // notion of merging or "outer rails first". Rails freely cross other
  // rails' paths because shifts are decided independently — if rail A is
  // at lane 2 and rolls "+1" while rail B is at lane 3 and rolls "−1",
  // their paths visually swap through each other in that segment.
  //
  // MERGE_CHANCE  — repurposed as per-rail per-segment shift probability.
  //                 Half of it goes to "shift up", half to "shift down".
  // SPLIT_CHANCE  — repurposed as per-segment chance to spawn a new rail
  //                 at a random lane (capped by MAX_TRACKS / MAX_RAILS).
  function generateLogicProceduralRails(rails) {
    const conns    = [];
    const endRails = copyRails(rails);

    // Per-rail independent shift. Lane bounds clamp to [0, LANE_COUNT-1];
    // a roll that would push past the edge becomes a stay.
    for (const rail of endRails) {
      const r = rng();
      let nextLane = rail.lane;
      if (r < MERGE_CHANCE * 0.5) {
        if (rail.lane > 0) nextLane = rail.lane - 1;
      } else if (r < MERGE_CHANCE) {
        if (rail.lane < LANE_COUNT - 1) nextLane = rail.lane + 1;
      }
      conns.push({ id: rail.id, y1: rail.lane, y2: nextLane });
      rail.lane = nextLane;
    }

    // Per-segment spawn roll — adds a new line at a random lane.
    if (rng() < SPLIT_CHANCE
        && rails.length < MAX_TRACKS
        && rails.length < MAX_RAILS) {
      const usedIds = new Set(endRails.map(r => r.id));
      const newId = nextAvailableId(usedIds);
      if (newId !== -1) {
        const startLane = Math.floor(rng() * LANE_COUNT);
        conns.push({ id: newId, y1: startLane, y2: startLane });
        endRails.push({ id: newId, lane: startLane });
      }
    }

    return { conns, endRails };
  }

  // ── Step segment for branching mode ──────────────────────────────────────
  // Like procedural, but rails can also END (dead-end stub) and new spawns
  // enter from an edge lane (top or bottom). Visually models the shapes in
  // svg/dead-end.svg and svg/new-spawns.svg — rails fade in/out of the
  // lane grid through diagonal stubs at the edges.
  //
  // END_CHANCE — per-rail per-segment chance the rail terminates.
  function generateLogicBranchingRails(rails) {
    const conns    = [];
    const endRails = [];
    const edge     = () => (rng() < 0.5) ? 0 : (LANE_COUNT - 1);

    // Per-rail walk + end roll. A rail that ends emits a stub-exit conn
    // (current lane → edge lane) and is dropped from endRails.
    for (const rail of rails) {
      if (rng() < END_CHANCE) {
        conns.push({ id: rail.id, y1: rail.lane, y2: edge() });
        continue;
      }
      const r = rng();
      let nextLane = rail.lane;
      if (r < MERGE_CHANCE * 0.5) {
        if (rail.lane > 0) nextLane = rail.lane - 1;
      } else if (r < MERGE_CHANCE) {
        if (rail.lane < LANE_COUNT - 1) nextLane = rail.lane + 1;
      }
      conns.push({ id: rail.id, y1: rail.lane, y2: nextLane });
      endRails.push({ id: rail.id, lane: nextLane });
    }

    // Per-segment spawn roll — new rail enters from an edge lane and
    // bends in to a random target lane.
    if (rng() < SPAWN_CHANCE
        && endRails.length < MAX_TRACKS
        && endRails.length < MAX_RAILS) {
      const usedIds = new Set(endRails.map(r => r.id));
      const newId = nextAvailableId(usedIds);
      if (newId !== -1) {
        const fromLane = edge();
        const toLane   = Math.floor(rng() * LANE_COUNT);
        conns.push({ id: newId, y1: fromLane, y2: toLane });
        endRails.push({ id: newId, lane: toLane });
      }
    }

    return { conns, endRails };
  }

  // ── Unified rolling cache ────────────────────────────────────────────────
  // Both modes use a single forward-growing cache. STATE.rails[n] holds the
  // rail list at the *start* of segment n; STATE.conns[n] holds the conns
  // emitted *during* segment n.
  const STATE = {
    rails: [],
    conns: [],
    length: 0,
    keyParams: '',
    _lastEnd: null,
    _eventBuckets: null,
  };

  function stateKey() {
    if (MODE === 'scripted') {
      const evs = ACTIVE.concat(USER_EVENTS);
      return `s|${LOOP_SEGS}|${LANE_COUNT}|${evs.map(e =>
        `${e.seg},${String(e.type).toUpperCase()},${e.from},${e.to ?? ''}`).join(';')}`;
    }
    if (MODE === 'phasing') {
      return `h|${LANE_COUNT}`;
    }
    if (MODE === 'convergence') {
      return `c|${LANE_COUNT}|${CONV_LOOP}|${CONV_SCRIPT.map(e =>
        `${e.seg},${String(e.type).toUpperCase()},${e.from},${e.to ?? ''}`).join(';')}`;
    }
    if (MODE === 'draw') {
      return `d|${LOOP_SEGS}|${LANE_COUNT}|${USER_EVENTS.map(e =>
        `${e.seg},${String(e.type).toUpperCase()},${e.from},${e.to ?? ''}`).join(';')}`;
    }
    if (MODE === 'branching') {
      return `b|${LANE_COUNT}|${SEED}|${MERGE_CHANCE}|${SPAWN_CHANCE}|${END_CHANCE}|${MAX_TRACKS}`;
    }
    return `p|${LANE_COUNT}|${SEED}|${MERGE_CHANCE}|${SPLIT_CHANCE}|${MAX_TRACKS}`;
  }

  function stateReset() {
    STATE.rails.length = 0;
    STATE.conns.length = 0;
    STATE.length = 0;
    STATE.keyParams = stateKey();
    STATE._lastEnd = null;
    STATE._eventBuckets = (MODE === 'scripted')    ? bucketEvents()
                        : (MODE === 'convergence') ? bucketEventsFromList(CONV_SCRIPT, CONV_LOOP)
                        : (MODE === 'draw')        ? bucketEventsFromList(USER_EVENTS, LOOP_SEGS)
                        : null;
    rngReset(SEED);
  }

  function ensureUpTo(n) {
    if (STATE.keyParams !== stateKey()) stateReset();
    while (STATE.length <= n) {
      const startRails = STATE.length === 0
        ? initialRails()
        : copyRails(STATE._lastEnd);
      let result;
      if (MODE === 'scripted') {
        const events = STATE._eventBuckets[mod(STATE.length, LOOP_SEGS)] || [];
        result = stepSegmentRails(startRails, events);
      } else if (MODE === 'phasing') {
        // Single straight rail forever. Pill phasing is a render-side effect.
        const lane = Math.round(CENTER_IDX());
        const rails = [{ id: 0, lane }];
        result = {
          conns:    [{ id: 0, y1: lane, y2: lane }],
          endRails: rails,
        };
      } else if (MODE === 'convergence') {
        // Built-in convergence loop (3 rails: spread → merge to centre →
        // spread back). Renderer scales width by per-conn end-lane density.
        const events = STATE._eventBuckets[mod(STATE.length, CONV_LOOP)] || [];
        result = stepSegmentRails(startRails, events);
      } else if (MODE === 'branching') {
        result = generateLogicBranchingRails(startRails);
      } else if (MODE === 'draw') {
        // User-drawn topology. Same engine as scripted, but the script is
        // entirely USER_EVENTS — INIT, SPLITs, MERGEs all from the user.
        const inLoopSeg = mod(STATE.length, LOOP_SEGS);
        const events = STATE._eventBuckets[inLoopSeg] || [];
        result = stepSegmentRails(startRails, events);
        // On the last segment of the loop, bend each INIT-spawned rail
        // back to its starting lane so the next iteration begins from
        // the same state. Without this the loop visibly stalls — MERGE
        // events on iteration 2 find no rail at the original `from`
        // lanes and become no-ops. SPLIT-spawned rails are left alone.
        if (inLoopSeg === LOOP_SEGS - 1) {
          const init = initialRails();
          const homeById = new Map(init.map(r => [r.id, r.lane]));
          const newConns = result.conns.map(c => {
            if (homeById.has(c.id)) {
              return { id: c.id, y1: c.y1, y2: homeById.get(c.id) };
            }
            return c;
          });
          const newEnd = result.endRails.map(r => {
            if (homeById.has(r.id)) return { id: r.id, lane: homeById.get(r.id) };
            return r;
          });
          result = { conns: newConns, endRails: newEnd };
        }
      } else {
        result = generateLogicProceduralRails(startRails);
      }
      STATE.rails.push(startRails);
      STATE.conns.push(result.conns);
      STATE._lastEnd = result.endRails;
      STATE.length++;
    }
  }

  // ── Public queries ───────────────────────────────────────────────────────
  function activeLanesAt(n) {
    const idx = n | 0;
    if (idx < 0) return [];
    ensureUpTo(idx);
    const rails = STATE.rails[idx];
    const lanes = new Set(rails.map(r => r.lane));
    return [...lanes];
  }

  function connectionsAt(n) {
    const idx = n | 0;
    if (idx < 0) return [];
    ensureUpTo(idx);
    return STATE.conns[idx];
  }

  function stationWeight(n, windowN = 3) {
    let wsum = 0, acc = 0;
    const sigma = Math.max(1, windowN) / 2;
    for (let d = -windowN; d <= windowN; d++) {
      const w = Math.exp(-(d * d) / (2 * sigma * sigma));
      wsum += w;
      if (activeLanesAt(n + d).length === 1) acc += w;
    }
    return acc / wsum;
  }

  function ownerLane(y1, y2) {
    if (y1 === y2) return y1;
    const c = CENTER_IDX();
    return Math.abs(y1 - c) > Math.abs(y2 - c) ? y1 : y2;
  }

  // ── Setters ──────────────────────────────────────────────────────────────
  function setScript(n)        { if (SCRIPTS[n]) { ACTIVE = SCRIPTS[n]; stateReset(); } }
  function setConvergencePattern(n) {
    if (CONV_PATTERNS[n] && CONV_SCRIPT !== CONV_PATTERNS[n]) {
      CONV_SCRIPT = CONV_PATTERNS[n];
      CONV_LOOP   = CONV_LOOPS[n] || DEFAULT_CONV_LOOP;
      stateReset();
    }
  }
  function setLoopSegs(n)      { LOOP_SEGS = n;  stateReset(); }
  function setSegW(w)          { SEG_W = w; }
  function setCenterY(y)       { CENTER_Y = y; }
  function setLaneSpace(s)     { LANE_SPACE = s; }
  function setLaneCount(n)     { LANE_COUNT = n; stateReset(); }
  function setMode(m) {
    const mm = (m === 'procedural')  ? 'procedural'
             : (m === 'phasing')     ? 'phasing'
             : (m === 'convergence') ? 'convergence'
             : (m === 'branching')   ? 'branching'
             : (m === 'draw')        ? 'draw'
             : 'scripted';
    if (MODE !== mm) { MODE = mm; stateReset(); }
  }
  function setSeed(s)          { SEED = (s >>> 0) || 1; stateReset(); }
  function setMergeChance(c)   { MERGE_CHANCE = Math.max(0, Math.min(1, +c)); stateReset(); }
  function setSplitChance(c)   { SPLIT_CHANCE = Math.max(0, Math.min(1, +c)); stateReset(); }
  function setSpawnChance(c)   { SPAWN_CHANCE = Math.max(0, Math.min(1, +c)); stateReset(); }
  function setEndChance(c)     { END_CHANCE   = Math.max(0, Math.min(1, +c)); stateReset(); }
  function setMaxTracks(n)     { MAX_TRACKS = Math.max(1, n | 0); stateReset(); }
  function reroll()            { stateReset(); }

  function addUserEvent(ev) {
    if (!ev || !ev.type) return;
    USER_EVENTS.push({
      seg:  ev.seg | 0,
      type: String(ev.type).toUpperCase(),
      from: ev.from,
      to:   ev.to,
    });
    stateReset();
  }
  function setUserEvents(evs) {
    USER_EVENTS = Array.isArray(evs) ? evs.slice() : [];
    stateReset();
  }
  function clearUserEvents() {
    if (USER_EVENTS.length === 0) return;
    USER_EVENTS = [];
    stateReset();
  }
  function getUserEvents() {
    return USER_EVENTS.slice();
  }

  return {
    SCRIPTS,
    MAX_RAILS,
    get LOOP_SEGS() { return LOOP_SEGS; },
    get CONV_LOOP() { return CONV_LOOP; },
    get SEG_W()     { return SEG_W; },
    get CENTER_Y()  { return CENTER_Y; },
    get LANE_SPACE(){ return LANE_SPACE; },
    get LANE_COUNT(){ return LANE_COUNT; },
    // Rails are persistent in this model — camera should never wrap, since
    // wrapping would re-show the initial (1-rail) state instead of the
    // accumulated topology.
    get WORLD_LOOP(){ return Infinity; },
    get MODE()      { return MODE; },
    get SEED()      { return SEED; },
    get MERGE_CHANCE() { return MERGE_CHANCE; },
    get SPLIT_CHANCE() { return SPLIT_CHANCE; },
    get SPAWN_CHANCE() { return SPAWN_CHANCE; },
    get END_CHANCE()   { return END_CHANCE; },
    get MAX_TRACKS()   { return MAX_TRACKS; },
    laneToY,
    activeLanesAt, connectionsAt, stationWeight, ownerLane,
    smoothstep,
    setScript, setLoopSegs, setSegW, setCenterY, setLaneSpace, setLaneCount,
    setMode, setSeed, setMergeChance, setSplitChance, setSpawnChance, setEndChance, setMaxTracks, reroll,
    setConvergencePattern,
    CONV_PATTERN_KEYS: Object.keys(CONV_PATTERNS),
    addUserEvent, setUserEvents, clearUserEvents, getUserEvents,
  };
})();
