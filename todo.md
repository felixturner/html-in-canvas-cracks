- handle dpr
- resize without rebuilding the whole pipeline. options:
   - **(a)** debounce: keep `stage.style.width` in `vw` during drag (stale buffer stretches mildly), rebuild texture+material+mesh 150ms after resize settles. cheapest.
   - **(b)** fixed max-size source canvas (e.g. 3840×2160), shader samples only `(vw/maxW, vh/maxH)`. zero reallocations. needs testing — unclear if `layoutsubtree` lays out to window or canvas dims.
   - **(c)** drop `CanvasTexture`, manage a raw `GPUTexture` + `copyExternalImageToTexture`, wrap as three.js texture. most code, reaches into internals.
   - rec: try (a) first, then (b) if rebuild cost still shows.
- add crack sounds
- make crack line fat lines that taper to edges
- make mesh have thickness like a sheet of glass. add pbr lighting mateiral on roate?
- animte cracks on click


- falling up anim https://x.com/RavenKwok/status/2044827756865998990
- code anim: https://x.com/andreasgysin/status/2044813366267367607
