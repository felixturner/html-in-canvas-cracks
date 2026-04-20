## TODO

- rename repo html-in-canvas-cracks
- make the gihub page longer - switch page content to actual repo
- try different fovs
- test on mobile
- make edges brighter
- fix sometimes edge pieces disapear
- add back edges have refections geen light glow?
- fix refelctions on tilt
- check slow down /perf
- add fallback?
- resize without rebuilding the whole pipeline. options:
  - **(a)** debounce: keep `stage.style.width` in `vw` during drag (stale buffer stretches mildly), rebuild texture+material+mesh 150ms after resize settles. cheapest.
  - **(b)** fixed max-size source canvas (e.g. 3840×2160), shader samples only `(vw/maxW, vh/maxH)`. zero reallocations. needs testing — unclear if `layoutsubtree` lays out to window or canvas dims.
  - **(c)** drop `CanvasTexture`, manage a raw `GPUTexture` + `copyExternalImageToTexture`, wrap as three.js texture. most code, reaches into internals.
  - rec: try (a) first, then (b) if rebuild cost still shows.

## REFS

- falling up anim https://x.com/RavenKwok/status/2044827756865998990
- matrix code anim: https://x.com/andreasgysin/status/2044813366267367607
- html glass effect https://bsky.app/profile/amagi.dev/post/3miuzmoa6hc2v
- nice shard colors: https://x.com/TatsuyaBot/status/2044624427162468380
