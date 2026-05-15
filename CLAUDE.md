# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A generative motion-graphics tool for Railway (the brand). Renders parallel "rails" that split, park, bend, merge — driven by a scripted lane simulator. Single-page, vanilla JS + GLSL via three.js, no build step.

## Running it

```bash
python3 -m http.server 8765
# then open http://localhost:8765
```

`.claude/launch.json` defines this as `name: railway-lines` for `preview_start`. There is no `package.json`, no build, no tests. Edit a JS file and reload.

When you change `app-three.js` or `sim.js`, you MUST bump the cache-busting query in `index.html`:
```html
<script src="sim.js?v=98"></script>
<script src="app-three.js?v=129"></script>
```
otherwise the browser serves the old file.

## Architecture (the three big pieces)

**`sim.js` (~820 LOC)** — Pure logical lane simulator. Maintains rail identities (rid 0..8) on a lane grid across a looping segment timeline. Exposes `SIM.connectionsAt(seg) → [{ id, y1, y2 }]` (lane numbers, not world Y; use `SIM.laneToY()` to convert). Scripts live in the `SCRIPTS` map at top of file — each entry is an array of `{ seg, type, from, to, railId? }` events (`INIT`/`SPLIT`/`MERGE`/`END`). The script drives the topology; the renderer reads `connectionsAt` per frame.

**`app-three.js` (~3700 LOC)** — Three.js renderer. One full-screen plane, one big `ShaderMaterial`. The fragment shader takes the sim's connections (uploaded as a data texture via `rebuildLaneData()`), figma 6-stop profile colours, per-rail halo settings, modulator state, and a camera X uniform. Everything visible — rail bodies, figma profile, Gaussian halos, ticks, ink-traps, bursts, container hull, deploy overlay — is one fragment shader.

Inside `app-three.js`:
- `CONFIG` (line ~37) — single source of truth for all visual + sim parameters. Presets are just snapshots of this object.
- `applyConfig()` → `_applyConfigCore()` → `pushPhaseRangeY()` is the update chain that pushes JS state into the GLSL uniforms. `pushPhaseRangeY()` also auto-detects per-rail fade windows from the script (when each rail spawns, parks, bends, ends).
- The shader is concatenated in the `mat = new THREE.ShaderMaterial({ fragmentShader: ... })` block (~line 590).
- Backwards compatibility for older presets: when adding a new CONFIG field, default it to a value that preserves prior behaviour so existing JSON presets still load identically.

**`index.html`** — UI panel with sliders/dropdowns/pickers bound to `CONFIG`. Drag-and-drop a `.json` file anywhere onto the page to load a preset (handler at the bottom of `app-three.js`). "Save current as preset" exports the current CONFIG to a download. There is no preset registry — presets are loose JSON files under `presets/<category>/*.json`.

**`deploy-overlay.js`** — Separate SVG overlay rendered on top of the canvas when `CONFIG.simMode === 'deploy'`. GSAP-driven gradient sweep across three brand-coloured stripes. Independent of the rail simulator.

## Coordinate system

- Lane numbers are 0..LANE_COUNT-1, `CENTER_IDX = (LANE_COUNT-1)/2`. `SIM.laneToY(l) = CENTER_Y + (l - CENTER_IDX) * LANE_SPACE`.
- World X advances unbounded via `cameraX += speed * dt`. The loop wraps every `loopSegs * segW` world units. In the shader you must `mod(wx, uLoopLen)` before comparing against loop-local positions (e.g. per-rail fade windows in `uRailHaloStartFadeStartWX` etc.) — easy to forget; the rail will render only on the first loop iteration if you don't.
- `perRailPhase = true` (mode used by current presets) computes each rail's phase from `|y - uTrunkY| / uPhaseRangeY` — distance from the trunk's Y, not canvas centre. `uTrunkY` is auto-detected as rail 0's median Y in `pushPhaseRangeY()`. Don't reintroduce hard-coded `y=0` references for phase math.

## Working on visual effects

Visual changes follow a tight iteration loop:

1. Edit `app-three.js` (often the shader inside `mat = new THREE.ShaderMaterial`) and/or a preset JSON.
2. Reload the preview. `index.html` auto-cache-busts `sim.js` and `app-three.js` via `Date.now()`, so a fresh edit is always served (no manual `?v=` bumps needed).
3. Drop a preset JSON onto the page to test it.

Useful for verification, all exposed on `window`:
- `__mat` — the ShaderMaterial. Inspect `.uniforms.uFoo.value` to see what got pushed.
- `__sample(tx, ty)` — read one pixel (normalised coords). Returns `{ x, y, r, g, b, wx, wxMod, seg }`.
- `__sampleColumn(tx)` — read a full vertical strip. Returns `{ wx, wxMod, seg, height, pixels: Uint8Array(rgb*H) }` (top-to-bottom).

URL params hydrate state on load: `?preset=<path>&camX=<n>&zoom=<n>&speed=<n>`. Use this for deterministic camera positioning during verification — no need to pulse `speed` toward a target.

### Preset schema for rail merges (Phase 1 work)

`CONFIG.simScript` accepts either a string (looked up in `SIM.SCRIPTS`) or an inline form: `{ events: [...] }` (or a bare event array). Inline lets a preset carry its own rail-life timing without touching `sim.js`.

`CONFIG.railMerge` (object keyed by rail id as string) overrides the auto-detected per-rail merge behaviour. All fields optional:
- `startFadeSegs` / `endFadeSegs` — fade window length in segments
- `preBendLead` — segs before the end-bend to start the end-fade (only used when the rail has an end-bend toward trunk)
- `startMode` / `endMode` — `"alpha"` | `"colour-blend"` | `"both"`. Auto = `"both"` if the rail spawns/terminates at trunk, else `"alpha"`.

Example:
```json
"railMerge": {
  "2": { "startFadeSegs": 6, "endFadeSegs": 10, "preBendLead": 4, "endMode": "both" }
}
```
With this and an inline `simScript`, a preset fully defines a rail's life — no source edits to art-direct.

## Things that have specifically tripped up past edits

- The `subtle` flag for per-rail fade behaviour (in `pushPhaseRangeY`) is declared inside one scope but used in another. If you split or refactor the per-rail loop, make sure all the auto-detect blocks (start fade, end fade, endBendStart, startsAtTrunk, endsAtTrunk) can see the same `subtle`, `firstActiveSeg`, `lastActiveSeg`, etc.
- `colorMergeSoftness > 0` has side effects on `uSegPhasesSoft` that bleed through even when `perRailPhase` is on. Leave it at 0 for presets that use `perRailPhase`.
- `bendSpread` was originally hard-coded to pull rails toward `y=0`. It now uses `uTrunkY`. Old presets that assumed centre-anchored bending may need their `bendSpread` retuned if you load them.
- `mergeUnion: true` removes seams between overlapping rails but also kills per-rail alpha fades. Don't enable it without checking that start/end fade-ins still work.
