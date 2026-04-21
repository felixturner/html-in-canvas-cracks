# html-in-canvas-cracks

Real HTML, real layout, real scrolling — rendered through a WebGPU pipeline
with TSL shaders, feedback trails, and a live 3D code tunnel in the
background. Click the page to crack it; click again to shatter chunks off
into the tunnel. A small experiment in treating the DOM as a texture source
rather than the final display surface.

> [!WARNING]
> Requires desktop Chrome 141+ with
> [`chrome://flags/#canvas-draw-element`](chrome://flags/#canvas-draw-element)
> enabled.

### [Live Demo →](https://felixturner.github.io/html-in-canvas-cracks/)

## How It Works

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
4. Clicks fracture the page into 3D shards that sample the same live
   texture — cracks propagate, chunks tilt and fall off into the tunnel
   behind.
5. The page you see is the 3D composite — the DOM underneath is hidden, but
   still receives clicks, keyboard input, and text selection.

[draw-element]: https://developer.chrome.com/blog/canvas-draw-element

## Rendering Pipeline

Each frame goes through a few render targets before hitting the screen:

- **Foreground RT.** The HTML-textured base plane (pre-crack) or the shard
  meshes (post-crack) render alone into a transparent render target with
  depth. That isolation matters for compositing: the tunnel shows through
  wherever foreground alpha = 0 (e.g. through holes left by fallen shards).
- **Tunnel + feedback RT.** A separate 3D scene filled with drifting,
  fog-faded text quads (the "code tunnel") renders into a half-float render
  target. Before the tunnel draws, a full-screen quad with a slightly dim
  decay multiplier overwrites the previous frame in place — this is a manual
  temporal feedback pass, giving every glowing element a long, exponential
  trail without any post-pass.
- **Composite.** `PostProcessing` with a TSL `outputNode` layers the
  feedback RT and the foreground RT together through a `BloomNode`. Bloom is
  scoped to the background scene so the HTML stays crisp at its native
  resolution.

Everything uses half-float RTs in linear sRGB — the color math works in the
right space and bloom doesn't get blown out by the tone-mapper.

## TSL Node Materials

Shaders are written as node graphs with three.js TSL
(`three-shader-language`) rather than strings of WGSL. The pre-crack page is
a `MeshBasicNodeMaterial` with a UV-sampled `CanvasTexture`. The tunnel's
code planes are distance-faded against the scene fog. Shards use a TSL
distance fog of their own that fades *alpha* (not color) toward the far
plane, so a receding shard reveals the tunnel behind it instead of painting
an opaque black quad over it.

## The Shard System

When you click the page, it cracks.

- A polygonal "root shard" covering the viewport is built lazily on the
  first click. Subsequent clicks propagate a randomized crack graph (a main
  split plus recursive branches) through whatever shard the cursor is on.
- `src/shatter.js` runs the crack lines through a DCEL face-walker to split
  the hit polygon into sub-polygons, then earcut-triangulates each one.
- Every resulting shard becomes an *extruded* 3D polygon: CSS-pixel-space
  top and bottom caps joined by flat-shaded side walls. The sides show a
  flat "edge" material; the caps sample the live HTML texture through a
  per-vertex shader-computed UV so text and images stay aligned with the
  underlying document even as shards tumble.
- Small interior shards (and some small edge ones) get a falling-tumbling
  GSAP tween into the tunnel's fog. As they pass `SHARD_FOG_FAR` their TSL
  fog alpha hits zero and they unblock the tunnel behind them.
- Crack outlines are drawn by a child mesh per shard — thin quads along
  each polygon edge, grown outward from the click point via a per-vertex
  `growDelay` attribute and a single progress uniform.

### Coordinate System

Shards live in viewport-CSS-pixel space. `shardRoot` applies a uniform scale
of `2/vh` with a negative Y (so VP-y-down maps cleanly to world-y-down) and
is anchored at the top-left of the frustum. A crack clicked at `(300, 200)`
stays at `(300, 200)` after any resize — the HTML texture re-flows through
the fixed shard outline as the document relays out.

UVs are computed live in the vertex shader:

```
vpPx  = positionLocal.xy + centroid
docY  = vpPx.y + scrollY
uv    = vec2(vpPx.x / sourceCssW, 1 - docY / sourceCssH)
```

So each shard is effectively a "fixed window onto the live DOM" — scrolling
the page reflows content *behind* the cracks without the cracks themselves
moving.

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

Roughly 200 planes live at any moment. They drift forward toward the camera,
get recycled behind it, and smoothly fog out via
`THREE.Fog(0x000000, near, far)`. Because the tunnel renders into the
feedback RT, each glyph leaves a fading contrail that reinforces the depth
illusion.

A mouse-parallax tilt is wired to the tunnel group: normalized cursor
coordinates drive a lerped rotation with a small `TUNNEL_TILT_MAX` cap, so
the background responds to the cursor without drifting into full 3D-camera
territory.

## Interaction Layer

The clickable layer is the real DOM (`#source`), not the 3D mesh. That keeps
text selection, link hovering, and accessibility behavior working without
any custom raycasting. The 3D composite (`#stage`) sits on top with
`pointer-events: none`, so input passes through to the canvas beneath.

## Scroll, Resize, and Layout

Treating the DOM as a texture while keeping it scrollable turns out to have
a few subtleties.

- **Fixed stage.** `#stage` is `position: fixed`, so the browser pins the
  canvas to the viewport on the compositor thread. An earlier design used
  `position: absolute` with a per-frame `transform: translateY(scrollY)`
  compensation — that made VP-locked shards appear to shift vertically
  during scroll before snapping back once the main thread caught up. Fixed
  positioning makes that problem vanish.
- **Texture reflow, not geometry rescale.** Shards store their geometry in
  CSS pixels and never resize. On a horizontal viewport resize, the HTML
  document reflows and the source canvas is resized; the shards' shader
  UVs then sample the new layout automatically. Cracks stay pinned to the
  pixel they were clicked at.
- **GPU texture reallocation on resize.** `CanvasTexture` in WebGPU doesn't
  re-allocate its GPU texture when the backing canvas's `width`/`height`
  change — it silently scales the new content into the old-sized
  allocation. `paint()` detects a buffer-dimension change and calls
  `htmlTexture.dispose()` (preserving the JS object so shard materials'
  TSL `texture()` refs keep pointing at the right node), forcing the
  renderer to allocate a fresh `GPUTexture` at the new size on the next
  render.
- **Boot hand-off.** The screen mesh outputs opaque black until the HTML
  texture has been painted at least once (`screenReadyU` uniform), so the
  foreground RT has `alpha = 1` from frame zero and the tunnel can never
  bleed through while the pipeline warms up. `body` flips to `ready` on
  the first successful pipeline frame, which reveals `#source` and fades
  in the native DOM layer underneath.

## Controls

Keyboard:

- `x` — explode remaining shards outward into the tunnel.
- `r` — reset shard positions to their original slots.
- `t` — apply a small random tilt to each shard.
- `o` — toggle OrbitControls on the camera (for debugging).

Add `?dev` to the URL for the debug overlay, Stats panel, and two draggable
split dividers that slice the viewport into three panes — GPU composite,
source canvas, and raw HTML — so you can see each stage of the pipeline
side-by-side.

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

- `src/main.js` — pipeline setup, render passes, shard lifecycle, scroll/resize wiring
- `src/shatter.js` — crack-graph-to-polygons face walker built on earcut
- `src/tunnel.js` — background code tunnel (text quads, fog, recycling)
- `src/sfx.js` — small WebAudio utilities
- `src/page.css` — styling for the DOM layer that becomes the texture

## License

MIT
