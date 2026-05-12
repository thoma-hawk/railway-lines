// ─────────────────────────────────────────────────────────────────────────────
// PNG sequence export
//
// Walks the master timeline frame-by-frame at the requested FPS, rasterizes
// the SVG to a canvas at each frame, encodes the canvas as PNG, and bundles
// all frames into a single zip via JSZip. Feed the unzipped sequence to
// ffmpeg (or import to AE / Cavalry / Figma's Lottie alternative) to
// produce a video.
//
// Example ffmpeg encode (run on the unzipped folder):
//   ffmpeg -framerate 30 -i %04d.png -c:v libx264 -pix_fmt yuv420p out.mp4
//
// Implementation notes:
// - We pause the master timeline, set repeat=0, and seek() to each frame's
//   exact time. GSAP runs each tween's onUpdate during seek, which means
//   the typewriter / merge / sleeper-offset state all settle to the right
//   values before we rasterize.
// - The SVG is serialized to a self-contained string, loaded into an
//   <img>, and drawn to an offscreen canvas. width / height attributes are
//   set on the SVG temporarily so the rasterizer renders at the requested
//   export size (independent of how the SVG is sized in the page).
// - On finish, SVG attrs are restored and the timeline resumes.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const btn        = document.getElementById('export-btn');
  const progressEl = document.getElementById('export-progress');
  const fpsInput   = document.getElementById('export-fps');
  const wInput     = document.getElementById('export-w');
  const hInput     = document.getElementById('export-h');
  if (!btn) return;

  async function exportPngSequence() {
    if (btn.disabled) return;
    if (typeof JSZip === 'undefined') {
      progressEl.textContent = 'JSZip not loaded';
      return;
    }
    if (!window.tl) {
      progressEl.textContent = 'timeline not ready';
      return;
    }

    const fps = Math.max(1, Math.min(120, parseInt(fpsInput.value, 10) || 30));
    const W   = Math.max(1, Math.min(3840, parseInt(wInput.value, 10) || 1920));
    const H   = Math.max(1, Math.min(2160, parseInt(hInput.value, 10) || 1080));
    const tl  = window.tl;
    const totalDur  = tl.duration();
    const numFrames = Math.ceil(totalDur * fps) + 1; // include t=totalDur

    btn.disabled = true;
    progressEl.textContent = `0 / ${numFrames}`;

    const svg = document.querySelector('.stage-frame > svg');
    if (!svg) {
      progressEl.textContent = 'no SVG';
      btn.disabled = false;
      return;
    }

    // Stash original SVG attrs and force the export size.
    const origW = svg.getAttribute('width');
    const origH = svg.getAttribute('height');
    svg.setAttribute('width',  String(W));
    svg.setAttribute('height', String(H));

    // Offscreen canvas — one allocation reused per frame.
    const canvas = document.createElement('canvas');
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Stash timeline state.
    const origRepeat = tl.repeat();
    const wasPaused  = tl.paused();
    tl.pause();
    tl.repeat(0);

    const zip = new JSZip();

    try {
      for (let i = 0; i < numFrames; i++) {
        const t = Math.min(i / fps, totalDur);
        tl.seek(t, false);  // false → onUpdate fires so DOM reflects this t

        // Yield two animation frames so all DOM mutations from GSAP
        // onUpdate handlers (textContent, attribute changes) have flushed.
        await new Promise(r => requestAnimationFrame(r));
        await new Promise(r => requestAnimationFrame(r));

        // Serialize → blob URL → Image → drawImage → toBlob.
        const svgStr = new XMLSerializer().serializeToString(svg);
        const svgBlob = new Blob(
          ['<?xml version="1.0" encoding="UTF-8"?>\n', svgStr],
          { type: 'image/svg+xml;charset=utf-8' }
        );
        const svgUrl = URL.createObjectURL(svgBlob);

        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload  = resolve;
          img.onerror = (e) => reject(new Error('SVG → Image load failed'));
          img.src = svgUrl;
        });

        ctx.clearRect(0, 0, W, H);
        // Match the page's beige stage background — fill BEFORE drawImage
        // so PNG isn't transparent where the SVG didn't fully cover.
        ctx.fillStyle = '#F1EFE8';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, 0, 0, W, H);
        URL.revokeObjectURL(svgUrl);

        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        const padded = String(i + 1).padStart(4, '0');
        zip.file(`${padded}.png`, blob);

        if (i % 3 === 0) progressEl.textContent = `${i + 1} / ${numFrames}`;
      }

      progressEl.textContent = 'Zipping…';
      const zipBlob = await zip.generateAsync(
        { type: 'blob' },
        (meta) => { progressEl.textContent = `Zipping ${Math.floor(meta.percent)}%`; }
      );

      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `deploy-${W}x${H}-${fps}fps.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      progressEl.textContent = `Done — ${numFrames} frames`;
    } catch (err) {
      console.error('Export failed:', err);
      progressEl.textContent = `Failed: ${err.message}`;
    } finally {
      // Restore SVG attrs.
      if (origW !== null) svg.setAttribute('width',  origW); else svg.removeAttribute('width');
      if (origH !== null) svg.setAttribute('height', origH); else svg.removeAttribute('height');

      // Restore timeline.
      tl.repeat(origRepeat);
      if (!wasPaused) tl.play();

      btn.disabled = false;
    }
  }

  btn.addEventListener('click', exportPngSequence);
})();
