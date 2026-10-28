/**
 * ============================================================================
 *  LuminaPDF — INTERNAL RENDERING ROADMAP (developer notes, not imported anywhere)
 *  Authors: hydese + assistant. Written at v1.0.5. Comments only: stripped from builds.
 * ============================================================================
 *
 * CURRENT PIPELINE (see renderSinglePageSlot in main.ts, darkModeEngine.ts)
 *   pdf.js renders the WHOLE page to an offscreen canvas at 2x (1x if width > 2000px)
 *   -> downsample2xWithCoolTypeFir (separable [o,i,i,o]/16 kernel; o=0 when low-zoom boost >= 0.3)
 *   -> classifyImageRegion (paper / ink / tinted ratios)
 *   -> transformBufferToDarkFast (LUT: dark mode, light-mode stem darkening, colorful pages kept)
 *   -> putImageData into a canvas mapped 1:1 to device pixels.
 *   Zoom: CSS-resize old canvas, re-render after 110ms. Cache: 8 pages, cleared on every zoom.
 *   Tuning knobs: SHARPNESS_BIAS in main.ts (Settings > PDF Text Sharpness),
 *   computeLowZoomBoost / COLORFUL_PAGE_TINTED_RATIO in darkModeEngine.ts.
 *
 * ----------------------------------------------------------------------------
 *  DONE IN v1.0.5 ("Option A")
 *   - #2 Bundled pdf.js cmaps + standard_fonts in /public/pdfjs, wired in getDocument().
 *        If pdf.js is upgraded, re-copy node_modules/pdfjs-dist/{cmaps,standard_fonts}.
 *   - #5 Soft / Balanced / Crisp text sharpness preset (localStorage "lumina_text_sharpness").
 *   - #8 NOT done: cache is still cleared on zoom (needed because canvas size changes).
 *        Idea: keep pages in a size-keyed Map (page, widthPx) so zooming back is instant.
 * ----------------------------------------------------------------------------
 *
 *  TODO / IDEAS NOT YET DONE (ask the owner before starting any of these)
 *
 *  [#3 + #4 + #6] "Option B": real tile renderer in a worker  (target: v1.1.0)
 *    Problem: whole-page raster on the main thread; at 300-500% zoom we rasterize the entire
 *      page although only a slice is visible; zoom is blurry until the re-render lands;
 *      agmTileCache in agmPipeline.ts stores one whole-page ImageData under the first tile key
 *      and is NEVER read, so it is effectively decorative.
 *    Plan:
 *      1. Per visible page, split the viewport intersection into 512px tiles
 *         (computeVisibleTilesPriorityQueue already yields keys + priority; reuse it).
 *      2. Render each tile with pdfPage.render({ canvasContext, viewport, transform }) where the
 *         viewport/transform translates by -tile.worldX/-tile.worldY (see computeTileRenderMatrix).
 *         Remember the 2x supersample: render tile at 2x and downsample per tile, with a 1-2px
 *         overlap border so the 4-tap kernel does not seam at tile edges.
 *      3. Move getImageData + downsample + transformBufferToDarkFast into a Web Worker using
 *         OffscreenCanvas / transferable ArrayBuffers (pdf.js itself already uses its own worker).
 *         Dark-mode slider drags must keep using the cached pristine buffers per tile.
 *      4. Phase 1 on zoom: scale the existing tiles via CSS transform (GPU bilinear). Phase 2:
 *         enqueue tiles center-first, cancel jobs for tiles that left the viewport, then swap.
 *      5. Make AgmTileCacheManager a real LRU keyed by (page, lod, col, row, darkModeHash) with a
 *         memory budget (e.g. 256MB of RGBA), and READ from it before rendering.
 *    Risks: seams, memory growth, regressions in the glyph quality we tuned on LMRoman10.
 *      Re-test with the Automatica textbook + the PowerPoint PDF before shipping.
 *
 *  [#1 / #7] Closing the gap with Acrobat / Preview text quality
 *    - pdf.js canvas gives grayscale AA, no font hinting, no LCD subpixel. We emulate it with
 *      supersampling + ink LUT. A true fix = a different engine:
 *      Option C: PDFium (pdfium-render crate in src-tauri). Gives hinted text and speed.
 *        Needs: new Rust dependency + pdfium binary (+ several MB installer), a Tauri command
 *        returning RGBA tiles, and re-hooking dark mode, links, search text layer, annotations,
 *        outline. Keep pdf.js only for text extraction/search if that is easier.
 *    - LCD subpixel text (optional, risky): render at 3x horizontally and apply the FIR filter
 *      [1,2,3,2,1]/9 per channel (see agmPipeline.ts). Only for light mode on RGB-stripe
 *      displays; OFF in dark mode and when DPR != 1 or the page is rotated.
 *    - Dark mode today is a per-pixel LUT. Better: use the pdf.js operator list to recolor at
 *      draw time (text/vector fill colors), leaving embedded images untouched instead of
 *      guessing with photoBoxes heuristics. Hook pdfPage.render via a custom canvasFactory or
 *      patch fillStyle/strokeStyle setters on the 2D context.
 *
 *  [Quality guardrails to keep]
 *    - Never CSS-scale the final canvas at rest: canvas px must equal device px (1:1).
 *    - Keep slot widths parity-snapped to the viewport (snapSlotWidthToViewportParity).
 *    - Colorful pages (tinted_pixel_ratio >= 0.2) must keep original colors in dark mode.
 *    - Release hygiene: delete src-tauri/target after packaging; keep only the current version's
 *      installer + luminapdf.exe + latest.json in /release. Never git push without owner OK.
 */

export {};
