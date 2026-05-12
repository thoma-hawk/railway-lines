// ─────────────────────────────────────────────────────────────────────────────
// Deploy comp — sequenced timeline (with per-stage speed knobs)
//
// Sequence (per the user's spec):
//   1. Mid label fades in + types
//   2. Mid dotted line draws all the way through
//   3. Mid thick rail enters as SOLID GREY (right → left)
//   4. Top + bot labels fade in + type (small offset between them)
//   5. Top + bot dotted lines draw across
//   6. Top thick rail enters as solid grey, then bot (offset between them)
//   7. ── Mid dotted line fades OUT (covered by the rails). ──
//   8. Gradients sweep in from RIGHT to LEFT — middle first, then top, then
//      bot. Each rail goes from solid grey → solid brand color (gray → brand
//      front sweeps leftward, then stop-a catches up to "solidify").
//   9. Top + bot dotted lines fade OUT as the gradients sweep over them.
//  10. Text variants swap Deploying → Configuring → Deployed (per-rail
//      stagger). On reaching Deployed, the marker becomes a CIRCLE-IN-A-
//      CIRCLE (ring + filled dot — NOT a triangle).
//  11. Connector line draws from the mid outward (up + down simultaneously),
//      with a small gap between line and each marker.
//  12. Blue gradient sweeps in right → left, taking up the whole rail.
//  13. Merge — top + bot rails curve toward the merge y from the RIGHT side
//      first, sweeping leftward. Rails have opacity < 1 so the merge zone
//      shows a clear overlay/blend.
//  14. Pale wash + summary block + bullet list types in.
//
// Continuous flow (column pattern + dash motion) runs independently.
// ─────────────────────────────────────────────────────────────────────────────

const COLOR = {
  gray:  '#9D9D9D',
  green: '#4F8669',
  gold:  '#D8AB56',
  pink:  '#E9C6C5',
  blue:  '#1923A8',
  pale:  '#CCCDDD',
};
const BRAND = { top: COLOR.green, mid: COLOR.gold, bot: COLOR.pink };


// ── SPEED knobs ─────────────────────────────────────────────────────────
// Edit any one to retime that kind of motion across the whole comp.
const SPEED = {
  textType:     0.7,   // typewriter time per text element
  fadeIn:       0.4,   // group / label fade-in
  textSwap:     0.35,  // crossfade between text variants
  dashReveal:   1.0,   // dotted line clipPath reveal (right → left)
  dashFadeOut:  0.6,   // dotted line fade out as rail/gradient covers it
  railEnter:    1.1,   // rail stroke-dashoffset reveal
  gradient:     1.2,   // brand color sweep (stop-b color + offset)
  gradSolidify: 0.5,   // stop-a catches up so rail is solid brand
  markerSwap:   0.4,   // ring → ring+dot (concentric circles)
  connector:    0.6,   // connector line stroke-dashoffset draw
  blueWave:     1.0,   // blue color sweep (same right-to-left logic)
  merge:        1.6,   // merge curve sweeps in from right
  paleWash:     0.7,
  summary:      0.5,
};

// Stage start times — derived from a base anchor + cumulative offsets
// keyed off SPEED knobs above so retiming a SPEED value also slides
// downstream stages.
const T = {
  midText:     0.4,
  midDash:     1.6,
  midRail:     2.8,
  edgeText:    4.2,
  edgeDashTop: 5.0,
  edgeDashBot: 5.5,
  railTop:     6.2,
  railBot:     6.7,
  midDashOut:  6.2,    // mid dotted slides out concurrent with top rail entry
  gradMid:     8.2,
  gradTop:     8.7,
  gradBot:     9.2,
  edgeDashOut: 7.9,    // top + bot dotted slide out as the gradient arrives
  toConfig:   11.5,
  toDeployed: 13.5,
  connector:  13.0,
  blueWave:   15.0,
  merge:      16.5,
  paleWash:   17.5,
  summary:    18.0,
  loopEnd:    21.0,
};

// Per-rail opacities — top is most opaque, bot the least, so when the
// blue gradient + merge overlap each other the depth ordering reads
// correctly (matches the figma reference at frames 8-9).
const RAIL_OP = { top: 0.89, mid: 0.79, bot: 0.69 };


// ── Continuous flow ─────────────────────────────────────────────────────
const FLOW_SPEED = 60;

const colPattern = document.getElementById('col-pattern');
const colFlow = { off: 0 };
gsap.to(colFlow, {
  off: -300,
  duration: 300 / FLOW_SPEED,
  ease: 'none', repeat: -1,
  onUpdate() {
    colPattern.setAttribute('patternTransform', `translate(${colFlow.off} 0)`);
  },
});

const DASH_PERIOD = 30.58;
const dashFlow = { off: 0 };
gsap.to(dashFlow, {
  off: DASH_PERIOD,
  duration: DASH_PERIOD / FLOW_SPEED,
  ease: 'none', repeat: -1,
  onUpdate() {
    document.getElementById('dash-mid').setAttribute('stroke-dashoffset', dashFlow.off);
    document.getElementById('dash-top').setAttribute('stroke-dashoffset', dashFlow.off);
    document.getElementById('dash-bot').setAttribute('stroke-dashoffset', dashFlow.off);
  },
});

// Sleeper-tick flow inside the rails — gives the procedural-mode
// "rails moving along the x axis" feel. Same FLOW_SPEED as column +
// dashes. Sleeper paths are M2400→L0 (right-to-left), so we use a
// NEGATIVE offset to make the ticks flow LEFTWARD visually (matching
// the dotted-line direction; offset moves dashes toward the path's L
// endpoint, which is at the left edge).
const SLEEPER_PERIOD = 100;
const sleeperFlow = { off: 0 };
gsap.to(sleeperFlow, {
  off: -SLEEPER_PERIOD,
  duration: SLEEPER_PERIOD / FLOW_SPEED,
  ease: 'none', repeat: -1,
  onUpdate() {
    document.getElementById('sleepers-top').setAttribute('stroke-dashoffset', sleeperFlow.off);
    document.getElementById('sleepers-mid').setAttribute('stroke-dashoffset', sleeperFlow.off);
    document.getElementById('sleepers-bot').setAttribute('stroke-dashoffset', sleeperFlow.off);
  },
});


// ── Typewriter ─────────────────────────────────────────────────────────
const TYPE_TARGETS = [
  '#text-top-deploying-l1', '#text-top-deploying-l2',
  '#text-top-config-l1',    '#text-top-config-l2',
  '#text-top-deployed-l1',  '#text-top-deployed-l2',
  '#text-mid-deploying-l1', '#text-mid-deploying-l2',
  '#text-mid-config-l1',    '#text-mid-config-l2',
  '#text-mid-deployed-l1',  '#text-mid-deployed-l2',
  '#text-bot-deploying-l1', '#text-bot-deploying-l2',
  '#text-bot-config-l1',    '#text-bot-config-l2',
  '#text-bot-deployed-l1',  '#text-bot-deployed-l2',
  '#text-sum-1', '#text-sum-2', '#text-sum-3',
];
TYPE_TARGETS.forEach(sel => {
  const el = document.querySelector(sel);
  if (el) { el.dataset.fullText = el.textContent; el.textContent = ''; }
});

function addTypewriter(timeline, time, sel, dur) {
  const el = document.querySelector(sel);
  if (!el) return;
  const obj = { p: 0 };
  timeline.to(obj, {
    p: 1, duration: dur, ease: 'none',
    onUpdate() {
      const full = el.dataset.fullText || '';
      el.textContent = full.substring(0, Math.floor(obj.p * full.length));
    },
  }, time);
}


// ── Merge geometry — sweeps in from the RIGHT ──────────────────────────
// At p=0: rail straight at original y.
// As p grows: a curve enters from the right edge and progresses leftward.
// The curve transitions from y=540 (merged section, on the right) to the
// original y (separated section, on the left). Visually the merge "lands"
// at the right edge first, then sweeps leftward — same flow direction as
// the rest of the comp. Math: curve x-position interpolates between off-
// canvas right (2400) and the figma target (1500).
const railTopEl = document.getElementById('rail-top');
const railBotEl = document.getElementById('rail-bot');
// Per the figma reference (frames 9 + 10): the MERGED region is on the
// RIGHT (single rail at y=540 going off-canvas right) and the SEPARATE
// region is on the LEFT (3 rails at original y, going off-canvas left).
// As p grows, the curve enters from the right edge (the merge "lands"
// at the right side of the canvas first) and progressively sweeps
// leftward. Merged y deepens from 360→540 (top) / 720→540 (bot).
// p ∈ [0, 2]:
//   p=0    : straight rail at original y
//   p=1    : figma frame 9 — merged on right (y=540), separate on left
//   p=2    : merged everywhere — figma frame 10 (single line at y=540)
// my   = "merge y" — the y on the RIGHT side; descends from original to 540 as p goes 0→1
// leftY = y on the LEFT side; stays at original until p>1, then ascends to 540 by p=2
function topPathAt(p) {
  const curveStart = 2400 - p * 900;
  const curveEnd   = curveStart - 500;
  const my         = 360 + Math.min(p, 1) * 180;            // 360 → 540 by p=1
  const leftY      = 360 + Math.min(Math.max(p - 1, 0), 1) * 180; // 360 → 540 by p=2
  return `M2400 ${my} L${curveStart} ${my} C${curveStart - 167} ${my} ${curveEnd + 167} ${leftY} ${curveEnd} ${leftY} L0 ${leftY}`;
}
function botPathAt(p) {
  const curveStart = 2400 - p * 900;
  const curveEnd   = curveStart - 500;
  const my         = 720 - Math.min(p, 1) * 180;            // 720 → 540 by p=1
  const leftY      = 720 - Math.min(Math.max(p - 1, 0), 1) * 180; // 720 → 540 by p=2
  return `M2400 ${my} L${curveStart} ${my} C${curveStart - 167} ${my} ${curveEnd + 167} ${leftY} ${curveEnd} ${leftY} L0 ${leftY}`;
}
railTopEl.setAttribute('d', topPathAt(0));
railBotEl.setAttribute('d', botPathAt(0));


// ── Master timeline ─────────────────────────────────────────────────────
const tl = window.tl = gsap.timeline({
  paused: true, repeat: -1, repeatDelay: 0,
  defaults: { ease: 'power1.out' },
});

// 1. Mid label appears + typewriter ─────────────────────────────────────
tl.to('#label-mid', { opacity: 1, duration: SPEED.fadeIn }, T.midText);
addTypewriter(tl, T.midText,                       '#text-mid-deploying-l1', SPEED.textType);
addTypewriter(tl, T.midText + SPEED.textType * 0.6,'#text-mid-deploying-l2', SPEED.textType * 0.85);

// 2. Mid dotted line draws across ───────────────────────────────────────
tl.to('#dash-mid-clip', { attr: { x: 0 }, duration: SPEED.dashReveal, ease: 'none' }, T.midDash);

// 3. Mid thick rail enters as SOLID GREY (gradient stops are both gray) ──
tl.to('#rail-mid', { opacity: RAIL_OP.mid, duration: 0.3 }, T.midRail);
tl.to('#rail-mid', { attr: { 'stroke-dashoffset': 0 }, duration: SPEED.railEnter, ease: 'none' }, T.midRail);

// 4. Top + bot labels appear + typewriter ───────────────────────────────
tl.to('#label-top', { opacity: 1, duration: SPEED.fadeIn }, T.edgeText);
addTypewriter(tl, T.edgeText,                        '#text-top-deploying-l1', SPEED.textType);
addTypewriter(tl, T.edgeText + SPEED.textType * 0.5, '#text-top-deploying-l2', SPEED.textType * 0.7);
tl.to('#label-bot', { opacity: 1, duration: SPEED.fadeIn }, T.edgeText + 0.3);
addTypewriter(tl, T.edgeText + 0.3,                        '#text-bot-deploying-l1', SPEED.textType);
addTypewriter(tl, T.edgeText + 0.3 + SPEED.textType * 0.5, '#text-bot-deploying-l2', SPEED.textType * 0.7);

// 5. Top + bot dotted lines reveal ──────────────────────────────────────
tl.to('#dash-top-clip', { attr: { x: 0 }, duration: SPEED.dashReveal, ease: 'none' }, T.edgeDashTop);
tl.to('#dash-bot-clip', { attr: { x: 0 }, duration: SPEED.dashReveal, ease: 'none' }, T.edgeDashBot);

// 6. Top + bot rails enter as SOLID GREY (offset between them) ──────────
tl.to('#rail-top', { opacity: RAIL_OP.top, duration: 0.3 }, T.railTop);
tl.to('#rail-top', { attr: { 'stroke-dashoffset': 0 }, duration: SPEED.railEnter, ease: 'none' }, T.railTop);
tl.to('#rail-bot', { opacity: RAIL_OP.bot, duration: 0.3 }, T.railBot);
tl.to('#rail-bot', { attr: { 'stroke-dashoffset': 0 }, duration: SPEED.railEnter, ease: 'none' }, T.railBot);

// 7. Mid dotted line slides out leftward (matching the rail-flow direction;
//    the dotted line moves out of frame instead of fading). ─────────────
tl.to('#dash-mid', { x: -2400, duration: SPEED.dashFadeOut, ease: 'none' }, T.midDashOut);

// 8. Gradient sweeps in — middle first, then top, then bot ──────────────
//    Each: stop-b (right edge) tweens its color from gray → brand AND
//    its offset from 1.0 → 0.05, sweeping the brand color in from the
//    right. stop-a then catches up (gray → brand) so the rail is solid
//    brand — "gradient goes to the end of the rails".
function gradientSweep(railKey, startTime) {
  const sel = `#stop-${railKey}-b`;
  const selA = `#stop-${railKey}-a`;
  tl.to(sel,  { attr: { 'stop-color': BRAND[railKey], offset: 0.05 }, duration: SPEED.gradient, ease: 'none' }, startTime);
  tl.to(selA, { attr: { 'stop-color': BRAND[railKey] }, duration: SPEED.gradSolidify }, startTime + SPEED.gradient * 0.55);
}
gradientSweep('mid', T.gradMid);
gradientSweep('top', T.gradTop);
gradientSweep('bot', T.gradBot);

// 9. Top + bot dotted lines slide out leftward as the gradients sweep
//    over them (same direction as rail flow). ─────────────────────────
tl.to('#dash-top', { x: -2400, duration: SPEED.dashFadeOut, ease: 'none' }, T.edgeDashOut);
tl.to('#dash-bot', { x: -2400, duration: SPEED.dashFadeOut, ease: 'none' }, T.edgeDashOut + 0.2);

// 10. Text swap Deploying → Configuring (per-rail stagger) ──────────────
function swapText(time, oldSel, newSel, lineSels) {
  tl.to(oldSel, { opacity: 0, duration: SPEED.textSwap }, time);
  tl.to(newSel, { opacity: 1, duration: SPEED.textSwap }, time);
  lineSels.forEach((sel, i) =>
    addTypewriter(tl, time + i * SPEED.textType * 0.5, sel, SPEED.textType));
}
swapText(T.toConfig,        '#text-mid-deploying', '#text-mid-config',
  ['#text-mid-config-l1', '#text-mid-config-l2']);
swapText(T.toConfig + 0.25, '#text-top-deploying', '#text-top-config',
  ['#text-top-config-l1', '#text-top-config-l2']);
swapText(T.toConfig + 0.5,  '#text-bot-deploying', '#text-bot-config',
  ['#text-bot-config-l1', '#text-bot-config-l2']);

// 11. Connector line draws from mid outward (up + down simultaneously) ──
tl.to('#connector-up',   { attr: { 'stroke-dashoffset': 0 }, duration: SPEED.connector, ease: 'power1.out' }, T.connector);
tl.to('#connector-down', { attr: { 'stroke-dashoffset': 0 }, duration: SPEED.connector, ease: 'power1.out' }, T.connector);

// 12. Marker swap ring → triangle for the Deployed state ────────────────
function swapMarker(time, ringSel, triSel) {
  tl.to(ringSel, { opacity: 0, duration: SPEED.markerSwap }, time);
  tl.to(triSel,  { opacity: 1, duration: SPEED.markerSwap }, time);
}
swapMarker(T.toDeployed,        '#marker-mid-ring', '#marker-mid-tri');
swapMarker(T.toDeployed + 0.15, '#marker-top-ring', '#marker-top-tri');
swapMarker(T.toDeployed + 0.3,  '#marker-bot-ring', '#marker-bot-tri');
swapText(T.toDeployed,        '#text-mid-config', '#text-mid-deployed',
  ['#text-mid-deployed-l1', '#text-mid-deployed-l2']);
swapText(T.toDeployed + 0.15, '#text-top-config', '#text-top-deployed',
  ['#text-top-deployed-l1', '#text-top-deployed-l2']);
swapText(T.toDeployed + 0.3,  '#text-bot-config', '#text-bot-deployed',
  ['#text-bot-deployed-l1', '#text-bot-deployed-l2']);

// 13. Blue gradient sweeps in from RIGHT to LEFT, fills whole rail ──────
//     Trick: at start, reset stop-b's offset back to 1.0 (no visible
//     change since stops are both at brand color = solid brand). Then
//     animate stop-b color → blue and offset → 0.05, replicating the
//     same right-to-left sweep as the brand stage. stop-a catches up
//     after to make the rail solid blue.
function blueSweep(railKey, startTime) {
  const sel  = `#stop-${railKey}-b`;
  const selA = `#stop-${railKey}-a`;
  tl.set(sel, { attr: { offset: 1.0 } }, startTime - 0.01);
  tl.to(sel,  { attr: { 'stop-color': COLOR.blue, offset: 0.05 }, duration: SPEED.blueWave, ease: 'none' }, startTime);
  tl.to(selA, { attr: { 'stop-color': COLOR.blue }, duration: SPEED.gradSolidify }, startTime + SPEED.blueWave * 0.55);
}
blueSweep('mid', T.blueWave);
blueSweep('top', T.blueWave + 0.15);
blueSweep('bot', T.blueWave + 0.3);

// 13b. Sleepers fade in just before the merge so the rails read as
//      "moving along the x axis" once the merge collapses them. Mid
//      sleepers stay visible to frame 10; top + bot fade out with their
//      rails after the merge transition.
tl.to(['#sleepers-top', '#sleepers-mid', '#sleepers-bot'],
  { opacity: 1, duration: 0.7 }, T.blueWave + 0.5);

// 14. Merge — top + bot rails curve to merge y, sweeping in from right ──
//     The sleeper paths share the same `d` and are updated in lockstep
//     so the tick pattern follows the curve as the rails collapse.
const mergeState = { p: 0 };
const sleepersTopEl = document.getElementById('sleepers-top');
const sleepersBotEl = document.getElementById('sleepers-bot');
tl.to(mergeState, {
  p: 2, duration: SPEED.merge + 1.0, ease: 'power2.inOut',
  onUpdate() {
    const tD = topPathAt(mergeState.p);
    const bD = botPathAt(mergeState.p);
    railTopEl.setAttribute('d', tD);
    railBotEl.setAttribute('d', bD);
    sleepersTopEl.setAttribute('d', tD);
    sleepersBotEl.setAttribute('d', bD);
  },
}, T.merge);

// As the merge completes, top + bot labels and connector retract.
tl.to(['#label-top', '#label-bot'], { opacity: 0, duration: 0.5 }, T.merge + 0.3);
tl.to('#connector-up',   { attr: { 'stroke-dashoffset': 146 }, duration: 0.5 }, T.merge + 0.3);
tl.to('#connector-down', { attr: { 'stroke-dashoffset': 146 }, duration: 0.5 }, T.merge + 0.3);

// 15. Pale wash — to match the figma reference, the rails end with a
//     SMOOTH gradient blue → pale (NOT solid pale). Stop-b's offset is
//     reset to 1.0 (right edge), then its color tweens blue → pale, leaving
//     stop-a at blue. End state: stop-a=blue@0, stop-b=pale@1.0 = full
//     gradient blue (left) → pale (right) across the rail.
function paleSweep(railKey, startTime) {
  const sel = `#stop-${railKey}-b`;
  tl.set(sel, { attr: { offset: 1.0 } }, startTime - 0.01);
  tl.to(sel,  { attr: { 'stop-color': COLOR.pale }, duration: SPEED.paleWash, ease: 'none' }, startTime);
}
paleSweep('top', T.paleWash);
paleSweep('mid', T.paleWash + 0.1);
paleSweep('bot', T.paleWash + 0.2);

// 15b. After the merge transition completes, fade the top + bot rails
//      out so the mid rail remains as the single thick line — matches
//      figma frame 10 (one rail at y=540 spanning the canvas, gradient
//      blue → pale). The visible blend during the merge curve was the
//      "overlay effect"; once the rails are settled, the mid rail alone
//      represents the merged result.
// Top + bot rails (and their sleepers) DO NOT fade out. They stay
// visible at y=540 in the merged section, sleepers continue flowing —
// keeps the "rails moving along the x axis, on a journey" feel right
// through frame 10.

// 16. Summary block fades in + bullet list types ────────────────────────
tl.to('#summary', { opacity: 1, duration: SPEED.summary }, T.summary);
addTypewriter(tl, T.summary + 0.3, '#text-sum-1', SPEED.textType * 0.6);
addTypewriter(tl, T.summary + 0.7, '#text-sum-2', SPEED.textType * 0.7);
addTypewriter(tl, T.summary + 1.2, '#text-sum-3', SPEED.textType * 0.8);

tl.set({}, {}, T.loopEnd);


// ── FRAME_TIMES — for compare.html ─────────────────────────────────────
window.FRAME_TIMES = {
  1:  T.midText + 1.0,
  2:  T.midRail + 1.0,
  3:  T.railTop + 0.5,
  4:  T.gradMid + 0.5,
  5:  T.toConfig + 0.6,
  6:  T.connector,
  7:  T.toDeployed + 0.7,
  8:  T.blueWave + 0.9,
  9:  T.merge + 1.4,
  10: T.summary + 1.5,
};


// ── Page controls ──────────────────────────────────────────────────────
const replay = document.getElementById('replay');
const speed  = document.getElementById('speed');
const tRead  = document.getElementById('t-readout');
if (replay) replay.addEventListener('click', () => tl.restart());
if (speed)  speed.addEventListener('input', (e) => tl.timeScale(parseFloat(e.target.value)));
if (tRead)  gsap.ticker.add(() => { tRead.textContent = `t=${tl.time().toFixed(2)}s`; });
