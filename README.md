# html-in-canvas

Real HTML, real layout, real scrolling — rendered through a WebGPU pipeline
with TSL shaders, feedback trails, post-processing, and a live 3D code tunnel
in the background. A small experiment in treating the DOM as a texture source
rather than the final display surface.

> [!WARNING]
> Requires Chrome 141+ with
> [`chrome://flags/#canvas-draw-element`](chrome://flags/#canvas-draw-element)
> enabled.

### <ins>[Live Demo →](https://felixturner.github.io/html-in-canvas-cracks/)</ins>

## What It Is

Modern browsers can paint a live, laid-out DOM element straight onto a 2D
canvas via the new [`CanvasRenderingContext2D.drawElement()`][draw-element]
API. Once the page is a canvas, it's a texture. Once it's a texture, every
trick WebGPU knows is on the table.

This project wires that pipeline up end-to-end:

1. A full-page "GitHub" layout lives in the regular DOM so selection, hover,
   scroll, and font metrics all behave like a real webpage.
2. A hidden clone of that DOM is painted each frame into a 2D canvas that
   tracks the document's height (not just the viewport).
3. A `three.js` `WebGPURenderer` pulls that canvas as a `CanvasTexture` and
   composites it through a multi-pass node-material pipeline.
4. The page you see is the 3D composite — the DOM underneath is hidden, but
   still receives clicks, keyboard input, and text selection.

[draw-element]: https://developer.chrome.com/blog/canvas-draw-element

## Rendering Pipeline

Each frame goes through a few render targets before hitting the screen:

- **Tunnel + feedback RT.** A separate 3D scene filled with drifting,
  fog-faded text quads (the "code tunnel") renders into a half-float render
  target. Before the tunnel draws, a full-screen quad with a slightly dim
  decay multiplier overwrites the previous frame in place — this is a manual
  temporal feedback pass, giving every glowing element a long, exponential
  trail without any post-pass. The decay constant and the fog near/far are
  both live-tweakable.
- **Foreground RT.** The HTML-textured mesh renders alone into a transparent
  render target with depth. That isolation matters for the post passes: we
  want effects that react to the foreground's alpha without the tunnel
  contaminating the signal.
- **Composite.** `PostProcessing` with a TSL `outputNode` layers the
  feedback RT, the foreground RT, and a `BloomNode` together. Bloom is
  scoped to the background scene so the HTML stays crisp at its native
  resolution.

Everything uses half-float RTs in linear sRGB — the color math works in the
right space and bloom doesn't get blown out by the tone-mapper.

## TSL Node Materials

Shaders are written as node graphs with three.js TSL
(`three-shader-language`) rather than strings of WGSL. The page material is a
`MeshBasicNodeMaterial` with a UV-sampled `CanvasTexture`. The tunnel's code
planes are distance-faded against the scene fog. A Fresnel term pulled from
`normalView.dot(positionView.normalize().negate())` drives a rim light on
the page geometry — strength, color, and an edge-only emissive boost are all
exposed as uniforms and re-bound to a `lil-gui` debug panel.

The chromatic aberration effect is a simple horizontal RGB split in a
dedicated composite shader. Red is sampled at `uv + offset`, blue at
`uv - offset`, and green passes through. The per-pixel offset is scaled by a
mask texture (blurred, half-resolution, flipped in Y to match canvas
coordinates) so aberration is localized where it matters rather than
blanketing the screen.

## The Code Tunnel

The background is a tunnel of floating code snippets. The source strings are
imported verbatim from the project itself via Vite's `?raw` import, so the
background is literally the code that renders it.

- Source is split on blank lines and re-joined into groups of up to three
  blocks, so each plane shows a coherent chunk with some breathing room.
- Planes are scattered within a cylindrical volume with a dead zone around
  the camera axis so nothing clips through the near plane.
- Each plane renders to a small `CanvasTexture` and a `MeshBasicNodeMaterial`
  with custom glyph tinting.
- A per-frame `updateAspect(aspect)` call re-fits the tunnel to the current
  viewport so the background doesn't warp on resize.

There's roughly 200 planes live at any moment. They drift forward toward the
camera, get recycled behind it, and smoothly fog out via
`THREE.Fog(0x000000, near, far)`. Because the tunnel renders into the
feedback RT, each glyph leaves a fading contrail that reinforces the depth
illusion.

## Interaction Layer

The clickable layer is the real DOM (`#source`), not the 3D mesh. That keeps
text selection, link hovering, and accessibility behavior working without
any custom raycasting. The 3D composite (`#stage`) sits on top with
`pointer-events: none`, so input passes through to the canvas beneath.

There's a mouse-parallax tilt wired to the tunnel group: normalized cursor
coordinates drive a lerped rotation with a small `TUNNEL_TILT_MAX` cap, so
the background responds to the cursor without drifting into full 3D-camera
territory.

## Scroll, Resize, and Layout

Treating the DOM as a texture while keeping it scrollable turns out to have
a few subtleties.

- **Scroll tracking.** `sceneRoot.position.y` is derived every paint from
  `window.scrollY / innerHeight` plus a doc-height ratio, so the 3D plane
  tracks the underlying page scroll frame-perfectly.
- **Overscroll bounce.** macOS elastic scroll is a compositor-level
  transform that doesn't change `scrollY`. To match it, the animation loop
  compares a top-anchored element's `getBoundingClientRect().top` against
  `offsetTop - scrollY` — the delta is the bounce offset, applied back into
  `sceneRoot.position.y` so the 3D view rubber-bands alongside the DOM.
- **Resize.** Horizontal resizes can briefly desync the clone's layout from
  the native page's, so canvas pixel-buffer sizing and `sceneRoot.scale` are
  both re-synchronized inside `paint()` using the live cloned layout instead
  of a resize-time snapshot. This kills the aspect-stretch artifact that
  otherwise shows up when dragging the window narrower.
- **Boot hand-off.** The screen mesh outputs opaque black until the HTML
  texture has been painted at least once (`screenReadyU` uniform), so the
  foreground RT has `alpha = 1` from frame zero and the tunnel can never
  bleed through while the pipeline warms up. `body` flips to `ready` on the
  first successful pipeline frame, which reveals `#source` and fades in the
  native DOM layer underneath.

## Controls

Open the `FX` panel (auto-shown in dev mode) to adjust:

- **Camera** — field of view. Camera Z is re-solved each change so the page
  plane stays framed vertically.
- **Shard Edges** — rim strength, edge-only rim boost, flat edge emissive,
  rim color.
- **Chromatic Aberration** — mask distance falloff, maximum horizontal
  offset, brush thickness, and mask intensity.

## Tech Stack

- [three.js](https://threejs.org) WebGPU renderer + TSL
- [earcut](https://github.com/mapbox/earcut) for polygon triangulation
- [GSAP](https://greensock.com/gsap/) for timed animations
- [Vite](https://vitejs.dev) for the dev server and `?raw` imports
- Chrome's draw-element canvas API

## Running Locally

```bash
npm install
npm run dev
```

## Files of Note

- `src/main.js` — pipeline setup, render passes, scroll/resize wiring
- `src/tunnel.js` — background code tunnel (text quads, fog, recycling)
- `src/postfx.js` — TSL composite + chromatic aberration shader
- `src/shatter.js` — polygon geometry helpers built on earcut
- `src/sfx.js` — small WebAudio utilities
- `src/page.css` — styling for the DOM layer that becomes the texture

## License

MIT
