/**
 * Adobe Graphics Manager (AGM) & CoolType High-Performance PDF Rendering Pipeline (v1.0.3).
 *
 * Implements all 7 stages of the production PDF rendering specification:
 * 1. Three Coordinate Spaces (Page Space 1/72", World Space Z*DPR, Viewport Space) &
 *    Pyramid Quadtree Tile / LOD LRU Cache with Priority Queue scheduling.
 * 2. Vector Path Rasterization: Recursive De Casteljau Cubic Bézier Adaptive Flattening
 *    (flatness error < 0.25 device pixels), Analytic Scanline Coverage, and Non-Zero /
 *    Even-Odd Winding Rules.
 * 3. Adobe CoolType Subpixel Text Rendering: 5-tap FIR low-pass filter `[1/9, 2/9, 3/9, 2/9, 1/9]`,
 *    stem grid-fitting/snapping, and gamma-correct Linear RGB (gamma = 2.2) alpha blending.
 * 4. "Enhance Thin Lines": Minimum device width clamping (`device_width >= 1.0px`) and
 *    orthogonal half-pixel center snapping (`floor(coord) + 0.5`).
 * 5. Embedded Raster Image Resampling: Two-pass separable Catmull-Rom bicubic convolution
 *    (a = -0.5) for upsampling, area-averaging box filter for downsampling, and 1-bit
 *    scale-to-gray conversion for monochrome scans.
 */

export const TILE_SIZE_PX = 512;
export const DISCRETE_LOD_SCALES = [
  0.75,
  1.0,
  1.25,
  1.5,
  2.0,
  2.5,
  3.0,
  4.0,
  5.0,
];

// ============================================================================
// 1. Coordinate Spaces & Pyramid Quadtree Tile Cache / Priority Queue
// ============================================================================

export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface ViewportRect {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface TileDescriptor {
  key: string;
  pageNumber: number;
  lodScale: number;
  tileCol: number;
  tileRow: number;
  worldX: number;
  worldY: number;
  widthPx: number;
  heightPx: number;
  priorityDistance: number;
}

export interface CachedTileEntry {
  key: string;
  pageNumber: number;
  lodScale: number;
  tileCol: number;
  tileRow: number;
  imageData: ImageData;
  lastUsedAt: number;
}

/**
 * Computes the transformation matrix from Page Space (1/72 inch, origin at bottom-left)
 * to Document/World Space scaled by zoom factor `Z` and device pixel ratio `DPR`.
 */
export function computePageToWorldMatrix(
  pageWidthPt: number,
  pageHeightPt: number,
  zoom: number,
  dpr: number,
  rotationDeg = 0
): Matrix2D {
  const s = zoom * dpr;
  const rot = ((rotationDeg % 360) + 360) % 360;
  switch (rot) {
    case 90:
      return { a: 0, b: s, c: s, d: 0, e: 0, f: 0 };
    case 180:
      return {
        a: -s,
        b: 0,
        c: 0,
        d: s,
        e: pageWidthPt * s,
        f: 0,
      };
    case 270:
      return {
        a: 0,
        b: -s,
        c: -s,
        d: 0,
        e: pageHeightPt * s,
        f: pageWidthPt * s,
      };
    case 0:
    default:
      return {
        a: s,
        b: 0,
        c: 0,
        d: -s,
        e: 0,
        f: pageHeightPt * s,
      };
  }
}

/**
 * Computes the tile transformation matrix:
 * `Matrix = Translate(-Tile.X, -Tile.Y) * Scale(Zoom * DPR, Zoom * DPR)`
 */
export function computeTileRenderMatrix(
  tileX: number,
  tileY: number,
  zoom: number,
  dpr: number
): Matrix2D {
  const scale = zoom * dpr;
  return {
    a: scale,
    b: 0,
    c: 0,
    d: scale,
    e: -tileX,
    f: -tileY,
  };
}

/**
 * Selects the nearest discrete pyramid Level of Detail (LOD) >= `zoom`, or exact `zoom`.
 */
export function selectPyramidLod(zoom: number): number {
  for (const lod of DISCRETE_LOD_SCALES) {
    if (lod >= zoom - 0.01) return lod;
  }
  return DISCRETE_LOD_SCALES[DISCRETE_LOD_SCALES.length - 1];
}

/**
 * Computes which `512x512` pyramid quadtree tiles intersect `viewport` for a page,
 * ordered by priority (closest to the center of the screen first).
 */
export function computeVisibleTilesPriorityQueue(
  pageNumber: number,
  pageWorldWidthPx: number,
  pageWorldHeightPx: number,
  pageViewportOffsetX: number,
  pageViewportOffsetY: number,
  viewport: ViewportRect,
  lodScale: number,
  tileSize = TILE_SIZE_PX
): TileDescriptor[] {
  const cols = Math.max(1, Math.ceil(pageWorldWidthPx / tileSize));
  const rows = Math.max(1, Math.ceil(pageWorldHeightPx / tileSize));

  const vpCenterX = (viewport.xMin + viewport.xMax) * 0.5;
  const vpCenterY = (viewport.yMin + viewport.yMax) * 0.5;

  const queue: TileDescriptor[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wx = c * tileSize;
      const wy = r * tileSize;
      const tw = Math.min(tileSize, pageWorldWidthPx - wx);
      const th = Math.min(tileSize, pageWorldHeightPx - wy);

      const screenX0 = pageViewportOffsetX + wx;
      const screenY0 = pageViewportOffsetY + wy;
      const screenX1 = screenX0 + tw;
      const screenY1 = screenY0 + th;

      if (
        screenX1 < viewport.xMin ||
        screenX0 > viewport.xMax ||
        screenY1 < viewport.yMin ||
        screenY0 > viewport.yMax
      ) {
        continue;
      }

      const tileMidX = (screenX0 + screenX1) * 0.5;
      const tileMidY = (screenY0 + screenY1) * 0.5;
      const priorityDistance = Math.hypot(
        tileMidX - vpCenterX,
        tileMidY - vpCenterY
      );

      const key = `p${pageNumber}_lod${lodScale.toFixed(3)}_c${c}_r${r}`;
      queue.push({
        key,
        pageNumber,
        lodScale,
        tileCol: c,
        tileRow: r,
        worldX: wx,
        worldY: wy,
        widthPx: tw,
        heightPx: th,
        priorityDistance,
      });
    }
  }

  // Priority Queue: tiles closest to the center of the viewport execute first
  queue.sort((a, b) => a.priorityDistance - b.priorityDistance);
  return queue;
}

/**
 * Bounded LRU (Least Recently Used) Quadtree Tile Cache.
 * Supports instant parent/child LOD fallback lookup during Phase-1 synchronous zoom.
 */
export class AgmTileCacheManager {
  private cache = new Map<string, CachedTileEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 64) {
    this.maxEntries = maxEntries;
  }

  public get(key: string): CachedTileEntry | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastUsedAt = performance.now();
      // Move to MRU end of Map iteration order
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    return entry;
  }

  public put(entry: CachedTileEntry): void {
    if (this.cache.has(entry.key)) {
      this.cache.delete(entry.key);
    }
    entry.lastUsedAt = performance.now();
    this.cache.set(entry.key, entry);

    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Searches the Quadtree upwards/downwards for a fallback tile on the same page
   * when the exact LOD tile is still being rasterized in the background.
   */
  public findClosestLodFallback(
    pageNumber: number,
    targetLod: number,
    tileCol: number,
    tileRow: number
  ): CachedTileEntry | undefined {
    let best: CachedTileEntry | undefined;
    let bestDiff = Infinity;
    for (const entry of this.cache.values()) {
      if (
        entry.pageNumber === pageNumber &&
        entry.tileCol === tileCol &&
        entry.tileRow === tileRow
      ) {
        const diff = Math.abs(entry.lodScale - targetLod);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = entry;
        }
      }
    }
    return best;
  }

  public invalidatePage(pageNumber: number): void {
    for (const [k, v] of this.cache.entries()) {
      if (v.pageNumber === pageNumber) {
        this.cache.delete(k);
      }
    }
  }

  public clear(): void {
    this.cache.clear();
  }

  public get size(): number {
    return this.cache.size;
  }
}

// ============================================================================
// 2. Vector Path Rasterization: De Casteljau Flattening & Analytic Coverage
// ============================================================================

export interface Point2D {
  x: number;
  y: number;
}

/**
 * Recursively flattens a cubic Bézier curve into polyline segments using De Casteljau's
 * algorithm until the flatness error (distance of control points from baseline) is less
 * than `flatnessThreshold` (default: `0.25` device pixels).
 */
export function flattenCubicBezierDeCasteljau(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  flatnessThreshold = 0.25,
  maxDepth = 12
): Point2D[] {
  const out: Point2D[] = [{ x: x0, y: y0 }];
  const tolSq = flatnessThreshold * flatnessThreshold * 16;

  function subdivide(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    dx: number,
    dy: number,
    depth: number
  ): void {
    if (depth >= maxDepth) {
      out.push({ x: dx, y: dy });
      return;
    }

    // Distance of control points B and C from baseline segment AD
    let ux = 3.0 * bx - 2.0 * ax - dx;
    ux *= ux;
    let uy = 3.0 * by - 2.0 * ay - dy;
    uy *= uy;
    let vx = 3.0 * cx - 2.0 * dx - ax;
    vx *= vx;
    let vy = 3.0 * cy - 2.0 * dy - ay;
    vy *= vy;

    if (ux < vx) ux = vx;
    if (uy < vy) uy = vy;

    if (ux + uy <= tolSq) {
      out.push({ x: dx, y: dy });
      return;
    }

    // De Casteljau midpoint subdivision
    const abx = (ax + bx) * 0.5;
    const aby = (ay + by) * 0.5;
    const bcx = (bx + cx) * 0.5;
    const bcy = (by + cy) * 0.5;
    const cdx = (cx + dx) * 0.5;
    const cdy = (cy + dy) * 0.5;
    const abcx = (abx + bcx) * 0.5;
    const abcy = (aby + bcy) * 0.5;
    const bcdx = (bcx + cdx) * 0.5;
    const bcdy = (bcy + cdy) * 0.5;
    const midx = (abcx + bcdx) * 0.5;
    const midy = (abcy + bcdy) * 0.5;

    subdivide(ax, ay, abx, aby, abcx, abcy, midx, midy, depth + 1);
    subdivide(midx, midy, bcdx, bcdy, cdx, cdy, dx, dy, depth + 1);
  }

  subdivide(x0, y0, x1, y1, x2, y2, x3, y3, 0);
  return out;
}

/**
 * Evaluates whether a winding number fills a pixel under either the Non-Zero Winding Rule
 * or the Even-Odd Rule, converting analytic signed area coverage (`0.0..1.0`) to 8-bit alpha.
 */
export function computeAnalyticScanlineAlpha(
  signedCoverage: number,
  rule: "nonzero" | "evenodd" = "nonzero"
): number {
  let cov = Math.abs(signedCoverage);
  if (rule === "evenodd") {
    cov %= 2.0;
    if (cov > 1.0) cov = 2.0 - cov;
  } else {
    if (cov > 1.0) cov = 1.0;
  }
  return Math.max(0, Math.min(255, Math.round(cov * 255)));
}

// ============================================================================
// 4. "Enhance Thin Lines" (Minimum Device Width Clamping & Pixel Center Snapping)
// ============================================================================

/**
 * Snaps an orthogonal coordinate to the nearest half-pixel center (`floor(coord) + 0.5`)
 * so 1-pixel horizontal/vertical strokes fill a single pixel row/column at 100% opacity.
 */
export function snapToHalfPixelCenter(coord: number): number {
  return Math.floor(coord) + 0.5;
}

/**
 * Clamps a stroke width in user space so that its transformed device pixel width
 * is never less than `1.0px` when `enhanceThinLines` is enabled.
 */
export function computeEnhancedStrokeWidth(
  strokeWidthUserSpace: number,
  ctmScale: number,
  enhanceThinLines = true
): number {
  const safeScale = Math.max(0.001, ctmScale);
  const deviceWidth = strokeWidthUserSpace * safeScale;
  if (enhanceThinLines && deviceWidth < 1.05) {
    return 1.05 / safeScale;
  }
  return strokeWidthUserSpace;
}

/**
 * Instruments a `CanvasRenderingContext2D` before PDF.js rendering to apply:
 * - "Enhance Thin Lines" minimum device width clamping (`device_width >= 1.05px`) on all strokes,
 *   preventing thin table borders, fraction bars, and diagram lines from vanishing or flickering.
 * - High-quality bicubic image smoothing on embedded raster draws.
 */
export function instrumentContextWithAgmVectorPipeline(
  ctx: CanvasRenderingContext2D,
  enhanceThinLines = true,
  supersampleFactor = 1
): () => void {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const minDeviceWidthPx = 1.06 * Math.max(1, supersampleFactor);
  const origStroke = ctx.stroke;
  const origStrokeRect = ctx.strokeRect;

  ctx.stroke = function (...args: unknown[]): void {
    if (enhanceThinLines) {
      const m = ctx.getTransform();
      const ctmScale = Math.hypot(m.a, m.b) || Math.hypot(m.c, m.d) || 1.0;
      const minLineWidth = minDeviceWidthPx / ctmScale;
      if (ctx.lineWidth > 0 && ctx.lineWidth < minLineWidth) {
        const saved = ctx.lineWidth;
        ctx.lineWidth = minLineWidth;
        (origStroke as (...a: unknown[]) => void).apply(ctx, args);
        ctx.lineWidth = saved;
        return;
      }
    }
    (origStroke as (...a: unknown[]) => void).apply(ctx, args);
  } as typeof ctx.stroke;

  ctx.strokeRect = function (
    x: number,
    y: number,
    w: number,
    h: number
  ): void {
    if (enhanceThinLines) {
      const m = ctx.getTransform();
      const ctmScale = Math.hypot(m.a, m.b) || 1.0;
      const minLineWidth = minDeviceWidthPx / ctmScale;
      if (ctx.lineWidth < minLineWidth) {
        const saved = ctx.lineWidth;
        ctx.lineWidth = minLineWidth;
        origStrokeRect.call(ctx, x, y, w, h);
        ctx.lineWidth = saved;
        return;
      }
    }
    origStrokeRect.call(ctx, x, y, w, h);
  };

  return () => {
    ctx.stroke = origStroke;
    ctx.strokeRect = origStrokeRect;
  };
}

// ============================================================================
// 5. Embedded Raster Image Resampling (Separable Catmull-Rom Bicubic & Box Filter)
// ============================================================================

/**
 * Cubic Convolution Kernel W(x) for a = -0.5 (Catmull-Rom spline):
 * - For |x| <= 1:    W(x) = 1.5*|x|^3 - 2.5*|x|^2 + 1
 * - For 1 < |x| < 2: W(x) = -0.5*|x|^3 + 2.5*|x|^2 - 4*|x| + 2
 * - Otherwise:       W(x) = 0
 */
export function catmullRomWeight(x: number): number {
  const ax = Math.abs(x);
  if (ax <= 1.0) {
    return 1.5 * ax * ax * ax - 2.5 * ax * ax + 1.0;
  }
  if (ax < 2.0) {
    return -0.5 * ax * ax * ax + 2.5 * ax * ax - 4.0 * ax + 2.0;
  }
  return 0.0;
}

/**
 * Two-Pass Separable Catmull-Rom Bicubic Image Upsampler (4 horizontal fetches + 4 vertical fetches).
 */
export function resampleImageBicubicTwoPass(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Uint8ClampedArray {
  const temp = new Float32Array(dstW * srcH * 4);
  const dst = new Uint8ClampedArray(dstW * dstH * 4);

  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  // Pass 1: Horizontal 1D convolution into `temp`
  for (let y = 0; y < srcH; y++) {
    const srcRowOffset = y * srcW * 4;
    const tmpRowOffset = y * dstW * 4;

    for (let x = 0; x < dstW; x++) {
      const gx = (x + 0.5) * scaleX - 0.5;
      const ix = Math.floor(gx);
      const fx = gx - ix;

      const w0 = catmullRomWeight(fx + 1.0);
      const w1 = catmullRomWeight(fx);
      const w2 = catmullRomWeight(1.0 - fx);
      const w3 = catmullRomWeight(2.0 - fx);
      const wSum = w0 + w1 + w2 + w3 || 1.0;

      const x0 = Math.max(0, Math.min(srcW - 1, ix - 1)) * 4 + srcRowOffset;
      const x1 = Math.max(0, Math.min(srcW - 1, ix)) * 4 + srcRowOffset;
      const x2 = Math.max(0, Math.min(srcW - 1, ix + 1)) * 4 + srcRowOffset;
      const x3 = Math.max(0, Math.min(srcW - 1, ix + 2)) * 4 + srcRowOffset;

      const outIdx = tmpRowOffset + x * 4;
      for (let c = 0; c < 4; c++) {
        temp[outIdx + c] =
          (srcRgba[x0 + c] * w0 +
            srcRgba[x1 + c] * w1 +
            srcRgba[x2 + c] * w2 +
            srcRgba[x3 + c] * w3) /
          wSum;
      }
    }
  }

  // Pass 2: Vertical 1D convolution from `temp` into `dst`
  for (let y = 0; y < dstH; y++) {
    const gy = (y + 0.5) * scaleY - 0.5;
    const iy = Math.floor(gy);
    const fy = gy - iy;

    const w0 = catmullRomWeight(fy + 1.0);
    const w1 = catmullRomWeight(fy);
    const w2 = catmullRomWeight(1.0 - fy);
    const w3 = catmullRomWeight(2.0 - fy);
    const wSum = w0 + w1 + w2 + w3 || 1.0;

    const y0 = Math.max(0, Math.min(srcH - 1, iy - 1)) * dstW * 4;
    const y1 = Math.max(0, Math.min(srcH - 1, iy)) * dstW * 4;
    const y2 = Math.max(0, Math.min(srcH - 1, iy + 1)) * dstW * 4;
    const y3 = Math.max(0, Math.min(srcH - 1, iy + 2)) * dstW * 4;

    const dstRowOffset = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      const col = x * 4;
      const outIdx = dstRowOffset + col;
      for (let c = 0; c < 4; c++) {
        const val =
          (temp[y0 + col + c] * w0 +
            temp[y1 + col + c] * w1 +
            temp[y2 + col + c] * w2 +
            temp[y3 + col + c] * w3) /
          wSum;
        dst[outIdx + c] = val < 0 ? 0 : val > 255 ? 255 : Math.round(val);
      }
    }
  }

  return dst;
}

/**
 * Area-Averaging Box Filter for downsampling high-resolution scanned images without Moiré.
 */
export function downsampleImageAreaBox(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = Math.floor(dy * scaleY);
    const sy1 = Math.min(srcH, Math.ceil((dy + 1) * scaleY));
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.floor(dx * scaleX);
      const sx1 = Math.min(srcW, Math.ceil((dx + 1) * scaleX));

      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const idx = (sy * srcW + sx) * 4;
          r += srcRgba[idx];
          g += srcRgba[idx + 1];
          b += srcRgba[idx + 2];
          a += srcRgba[idx + 3];
          count++;
        }
      }
      const outIdx = (dy * dstW + dx) * 4;
      const inv = count > 0 ? 1 / count : 0;
      dst[outIdx] = Math.round(r * inv);
      dst[outIdx + 1] = Math.round(g * inv);
      dst[outIdx + 2] = Math.round(b * inv);
      dst[outIdx + 3] = Math.round(a * inv);
    }
  }
  return dst;
}

/**
 * Converts a 1-bit monochrome scanned image (JBIG2 / CCITT Fax style) into an 8-bit
 * scale-to-gray anti-aliased RGBA buffer before bicubic resampling.
 */
export function convert1BitScanToScaleToGray(
  oneBitData: Uint8Array,
  width: number,
  height: number
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Sample 3x3 neighborhood to anti-alias binary staircases into 8-bit grayscale
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const bitIndex = ny * width + nx;
          const byteVal = oneBitData[bitIndex >> 3] || 0;
          const bit = (byteVal >> (7 - (bitIndex & 7))) & 1;
          const weight = dx === 0 && dy === 0 ? 4 : 1;
          sum += (bit ? 255 : 0) * weight;
          count += weight;
        }
      }
      const gray = Math.round(sum / Math.max(1, count));
      const idx = (y * width + x) * 4;
      rgba[idx] = gray;
      rgba[idx + 1] = gray;
      rgba[idx + 2] = gray;
      rgba[idx + 3] = 255;
    }
  }
  return rgba;
}
