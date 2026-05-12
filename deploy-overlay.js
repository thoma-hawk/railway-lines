// ─────────────────────────────────────────────────────────────────────────────
// Deploy overlay
//
// Sits on top of the three.js canvas. Renders 3 horizontal "rails" with
// gradient stops, animated by a GSAP loop — same effect as figma frame 5's
// brand color sweep.
//
// Active when CONFIG.simMode === 'deploy'. All loop parameters live on
// CONFIG (deploySweepDur, deploySweepDepth, deployHold, deployOpacity,
// deployBlend, deployBrand{Top,Mid,Bot}) so the panel sliders drive the
// motion live. The main app calls window.refreshDeployOverlay() inside its
// applyConfig() to nudge us when anything changes.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const SVG_NS    = 'http://www.w3.org/2000/svg';
  const LANE_SPACE = 180;     // matches preset's laneSpace; figma's row gap
  const RAIL_W     = 180;     // figma stroke-width

  const RAILS = [
    { id: 'rail-top', dy: -LANE_SPACE, brand: () => CONFIG.deployBrandTop, baseOpacity: 0.89 },
    { id: 'rail-mid', dy: 0,           brand: () => CONFIG.deployBrandMid, baseOpacity: 0.79 },
    { id: 'rail-bot', dy:  LANE_SPACE, brand: () => CONFIG.deployBrandBot, baseOpacity: 0.69 },
  ];

  const overlay = document.getElementById('deploy-overlay');
  const defs    = document.getElementById('deploy-overlay-defs');
  const content = document.getElementById('deploy-overlay-content');
  const toggle  = document.getElementById('deploy-overlay-toggle');
  const canvas  = document.getElementById('scene');

  // Hide the legacy floating button — visibility is now driven by simMode.
  if (toggle) toggle.style.display = 'none';

  // ── Build the overlay SVG structure once. ─────────────────────────────────
  RAILS.forEach((r) => {
    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', `grad-${r.id}`);
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    grad.setAttribute('x1', '0');
    grad.setAttribute('x2', '1');
    const stopA = document.createElementNS(SVG_NS, 'stop');
    stopA.setAttribute('id', `stop-${r.id}-a`);
    stopA.setAttribute('offset', '0');
    stopA.setAttribute('stop-color', '#9D9D9D');
    const stopB = document.createElementNS(SVG_NS, 'stop');
    stopB.setAttribute('id', `stop-${r.id}-b`);
    stopB.setAttribute('offset', '1');
    stopB.setAttribute('stop-color', r.brand());
    grad.appendChild(stopA);
    grad.appendChild(stopB);
    defs.appendChild(grad);

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('id', r.id);
    path.setAttribute('stroke', `url(#grad-${r.id})`);
    path.setAttribute('stroke-width', RAIL_W);
    path.setAttribute('fill', 'none');
    path.setAttribute('opacity', r.baseOpacity);
    content.appendChild(path);
  });

  // ── Sync overlay geometry to canvas size + viewport center. ───────────────
  function sync() {
    const w = canvas.clientWidth  || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const cy = h / 2;
    RAILS.forEach((r) => {
      document.getElementById(r.id)
        .setAttribute('d', `M0 ${cy + r.dy} L${w} ${cy + r.dy}`);
      const grad = document.getElementById(`grad-${r.id}`);
      grad.setAttribute('x2', String(w));
    });
  }
  window.addEventListener('resize', sync);
  sync();

  // ── Sweep timeline ────────────────────────────────────────────────────────
  // Built once and rebuilt whenever sweep params change. yoyo:true makes the
  // loop run sweep-out → hold → sweep-back → hold, forever.
  let sweep = null;

  function buildSweep() {
    if (sweep) sweep.kill();
    sweep = gsap.timeline({
      repeat: -1,
      yoyo: true,
      paused: true,
      defaults: { duration: CONFIG.deploySweepDur, ease: 'power2.inOut' },
    });
    sweep.to('#stop-rail-mid-b', { attr: { offset: CONFIG.deploySweepDepth } }, 0);
    sweep.to('#stop-rail-top-b', { attr: { offset: CONFIG.deploySweepDepth } }, 0.1);
    sweep.to('#stop-rail-bot-b', { attr: { offset: CONFIG.deploySweepDepth } }, 0.2);
    sweep.to({}, { duration: CONFIG.deployHold });
  }

  // ── refreshDeployOverlay() — called by app-three.js when CONFIG changes ──
  // Cheap to call: pushes current CONFIG values into the SVG and rebuilds
  // the timeline. Show/hide based on CONFIG.simMode.
  let currentParamsSig = '';
  window.refreshDeployOverlay = function () {
    const isDeploy = CONFIG.simMode === 'deploy';
    overlay.style.display = isDeploy ? 'block' : 'none';
    overlay.style.mixBlendMode = CONFIG.deployBlend || 'multiply';
    overlay.style.opacity = String(CONFIG.deployOpacity);

    // Push brand colors onto the second stop of each gradient.
    RAILS.forEach((r) => {
      const stopB = document.getElementById(`stop-${r.id}-b`);
      if (stopB) stopB.setAttribute('stop-color', r.brand());
    });

    // Rebuild the timeline only if a param it depends on actually changed,
    // so dragging an unrelated slider doesn't hitch the animation.
    const sig = `${CONFIG.deploySweepDur}|${CONFIG.deploySweepDepth}|${CONFIG.deployHold}`;
    if (sig !== currentParamsSig) {
      currentParamsSig = sig;
      buildSweep();
    }

    if (isDeploy) sweep && sweep.play();
    else          sweep && sweep.pause(0);   // reset to start so it's clean next time
  };

  // Initial paint — run once now and once after a tick so CONFIG is populated.
  if (typeof CONFIG !== 'undefined') window.refreshDeployOverlay();
  setTimeout(() => window.refreshDeployOverlay && window.refreshDeployOverlay(), 0);
})();
