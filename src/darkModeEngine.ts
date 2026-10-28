/**
 * Intelligent Dark Mode & Adobe CoolType Subpixel Linear-RGB Rendering Engine (v1.0.3).
 *
 * Implements:
 * 1. Exact IEC 61966-2-1 sRGB <-> Linear RGB (gamma = 2.2 / 2.4) lookup tables.
 * 2. CoolType 5-Tap Finite Impulse Response (FIR) subpixel filter (`[1/9, 2/9, 3/9, 2/9, 1/9]`)
 *    downsampling from 2x supersampled vector rasterization to exact 1:1 physical monitor pixels.
 * 3. Stem Grid-Fitting & Per-Channel Linear RGB Alpha Blending:
 *      Out_Linear.R = Text_Linear.R * SubpixelAlpha.R + Bg_Linear.R * (1.0 - SubpixelAlpha.R)
 *      Out_Linear.G = Text_Linear.G * SubpixelAlpha.G + Bg_Linear.G * (1.0 - SubpixelAlpha.G)
 *      Out_Linear.B = Text_Linear.B * SubpixelAlpha.B + Bg_Linear.B * (1.0 - SubpixelAlpha.B)
 * 4. Chrominance-preserving diagram/formula rendering and embedded photograph preservation.
 */

export type DarkRenderingStrategy =
  | "auto"
  | "semantic_text_vector"
  | "scanned_adaptive"
  | "scanned_color_preserve"
  | "original";

export type BackgroundPreset =
  | "near_black"
  | "true_black"
  | "warm_charcoal"
  | "deep_slate";

export interface DarkModeConfig {
  enabled: boolean;
  strategy: DarkRenderingStrategy;
  background_preset: BackgroundPreset;
  custom_background_rgb: [number, number, number] | null;
  text_brightness: number; // 0.60 .. 1.00
  contrast_boost: number; // 0.80 .. 1.50
  preserve_photographs: boolean;
  preserve_diagram_colors: boolean;
}

export const AUTO_HYBRID_DEFAULT_CONFIG: DarkModeConfig = {
  enabled: true,
  strategy: "auto",
  background_preset: "near_black",
  custom_background_rgb: null,
  text_brightness: 0.95,
  contrast_boost: 1.0,
  preserve_photographs: true,
  preserve_diagram_colors: true,
};

// ============================================================================
// Precomputed sRGB <-> Linear RGB Transfer Function Lookup Tables (Section 3)
// ============================================================================

export const SRGB_TO_LINEAR_LUT = new Float32Array(256);
export const LINEAR_TO_SRGB_LUT = new Uint8Array(4096);

(function initLinearRgbTables() {
  for (let i = 0; i < 256; i++) {
    const c = i / 255.0;
    SRGB_TO_LINEAR_LUT[i] =
      c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  for (let i = 0; i < 4096; i++) {
    const lin = i / 4095.0;
    const srgb =
      lin <= 0.0031308
        ? 12.92 * lin
        : 1.055 * Math.pow(lin, 1.0 / 2.4) - 0.055;
    LINEAR_TO_SRGB_LUT[i] = Math.max(
      0,
      Math.min(255, Math.round(srgb * 255.0))
    );
  }
})();

export function srgbToLinear(u8: number): number {
  return SRGB_TO_LINEAR_LUT[u8 & 0xff];
}

export function linearToSrgb(lin: number): number {
  const idx = lin <= 0 ? 0 : lin >= 1 ? 4095 : (lin * 4095.0 + 0.5) | 0;
  return LINEAR_TO_SRGB_LUT[idx];
}

/**
 * Returns `true` if `config` matches the unmodified "Auto Hybrid" default settings.
 */
export function isAutoHybridDefaultConfig(config: DarkModeConfig): boolean {
  return (
    config.enabled &&
    config.strategy === "auto" &&
    config.background_preset === "near_black" &&
    config.custom_background_rgb === null &&
    Math.abs(config.text_brightness - 0.95) < 0.04 &&
    Math.abs(config.contrast_boost - 1.0) < 0.03 &&
    config.preserve_photographs === true &&
    config.preserve_diagram_colors === true
  );
}

/**
 * Resets `config` in-place to the default Auto Hybrid parameters.
 */
export function resetConfigToAutoHybrid(config: DarkModeConfig): void {
  config.enabled = true;
  config.strategy = "auto";
  config.background_preset = "near_black";
  config.custom_background_rgb = null;
  config.text_brightness = 0.95;
  config.contrast_boost = 1.0;
  config.preserve_photographs = true;
  config.preserve_diagram_colors = true;
}

export type ImageContentType =
  | "photograph"
  | "scanned_monochrome"
  | "scanned_color";

export interface ImageClassificationReport {
  content_type: ImageContentType;
  light_paper_ratio: number;
  dark_ink_ratio: number;
  colored_pixel_ratio: number;
  estimated_paper_luma: number;
  estimated_ink_luma: number;
  /** Fraction of sampled pixels carrying a visible color tint (slides, colored fills). */
  tinted_pixel_ratio?: number;
  /** 0..1 optical ink boost for low zoom levels (text stems thinner than 1 device pixel). */
  low_zoom_boost?: number;
}

/** Pages dominated by colored fills (PowerPoint slides etc.) keep their original colors. */
export const COLORFUL_PAGE_TINTED_RATIO = 0.2;

export function isColorfulPage(report: ImageClassificationReport): boolean {
  return (report.tinted_pixel_ratio ?? 0) >= COLORFUL_PAGE_TINTED_RATIO;
}

/** Maps effective device-pixel page scale to a 0..1 low-zoom ink boost. */
export function computeLowZoomBoost(devicePixelScale: number): number {
  return Math.max(0, Math.min(1, (1.0 - devicePixelScale) / 0.55));
}

export interface PixelBoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function getTargetBackgroundRgb(
  config: DarkModeConfig
): [number, number, number] {
  if (config.custom_background_rgb) {
    return config.custom_background_rgb;
  }
  switch (config.background_preset) {
    case "true_black":
      return [0, 0, 0];
    case "warm_charcoal":
      return [24, 23, 21];
    case "deep_slate":
      return [15, 20, 28];
    case "near_black":
    default:
      return [16, 16, 18];
  }
}

export function perceptualLuma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function rgbChroma(r: number, g: number, b: number): number {
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

export function classifyImageRegion(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): ImageClassificationReport {
  const totalPixels = width * height;
  if (totalPixels === 0 || rgba.length < totalPixels * 4) {
    return {
      content_type: "photograph",
      light_paper_ratio: 0,
      dark_ink_ratio: 0,
      colored_pixel_ratio: 0,
      estimated_paper_luma: 255,
      estimated_ink_luma: 0,
    };
  }

  const step = Math.max(1, Math.floor(totalPixels / 4096));
  let sampled = 0;
  let lightPaper = 0;
  let darkInk = 0;
  let colored = 0;
  let tinted = 0;
  let midtoneNeutral = 0;
  const lumaHist = new Uint32Array(256);

  for (let idx = 0; idx < totalPixels; idx += step) {
    const base = idx * 4;
    const a = rgba[base + 3];
    if (a >= 32) {
      const r = rgba[base];
      const g = rgba[base + 1];
      const b = rgba[base + 2];
      const maxC = r > g ? (r > b ? r : b) : g > b ? g : b;
      const minC = r < g ? (r < b ? r : b) : g < b ? g : b;
      const chroma = (maxC - minC) / 255;
      const lumaU8 = (r * 54 + g * 183 + b * 19) >> 8;
      const luma = lumaU8 / 255;
      lumaHist[lumaU8]++;
      sampled++;

      if (chroma >= 0.14 && luma > 0.1 && luma < 0.94) {
        colored++;
      }
      if (chroma >= 0.04 && luma > 0.12) {
        tinted++;
      }
      if (luma >= 0.74 && chroma < 0.12) {
        lightPaper++;
      } else if (luma <= 0.32 && chroma < 0.15) {
        darkInk++;
      } else if (chroma < 0.12) {
        midtoneNeutral++;
      }
    } else {
      lightPaper++;
      sampled++;
      lumaHist[255]++;
    }
  }

  const lightPaperRatio = sampled > 0 ? lightPaper / sampled : 0;
  const darkInkRatio = sampled > 0 ? darkInk / sampled : 0;
  const coloredRatio = sampled > 0 ? colored / sampled : 0;
  const midtoneRatio = sampled > 0 ? midtoneNeutral / sampled : 0;

  const p90Target = Math.floor(sampled * 0.9);
  const p05Target = Math.floor(sampled * 0.05);
  let cumulative = 0;
  let p05Luma = 15;
  let p90Luma = 240;
  let foundP05 = false;

  for (let val = 0; val < 256; val++) {
    cumulative += lumaHist[val];
    if (!foundP05 && cumulative >= p05Target) {
      p05Luma = val;
      foundP05 = true;
    }
    if (cumulative >= p90Target) {
      p90Luma = val;
      break;
    }
  }

  const isPaperBacked = lightPaperRatio >= 0.42 && midtoneRatio < 0.52;
  let contentType: ImageContentType = "photograph";
  if (isPaperBacked) {
    contentType = coloredRatio >= 0.06 ? "scanned_color" : "scanned_monochrome";
  }

  return {
    content_type: contentType,
    light_paper_ratio: lightPaperRatio,
    dark_ink_ratio: darkInkRatio,
    colored_pixel_ratio: coloredRatio,
    estimated_paper_luma: Math.max(190, p90Luma),
    estimated_ink_luma: Math.min(90, p05Luma),
    tinted_pixel_ratio: sampled > 0 ? tinted / sampled : 0,
  };
}

/**
 * Instruments a native `CanvasRenderingContext2D` before `pdfPage.render()` so any embedded
 * photographs drawn via `drawImage` are classified and have their canvas pixel bounding boxes
 * recorded (scaled by `coordScale` if rendering on a supersampled canvas).
 */
export function instrumentCanvasForPhotographDetection(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  config: DarkModeConfig,
  coordScale = 1.0
): {
  getPhotoBoxes: () => PixelBoundingBox[];
  restore: () => void;
} {
  const photoBoxes: PixelBoundingBox[] = [];
  if (
    !config.enabled ||
    !config.preserve_photographs ||
    config.strategy === "original" ||
    config.strategy === "scanned_adaptive" ||
    config.strategy === "scanned_color_preserve"
  ) {
    return {
      getPhotoBoxes: () => photoBoxes,
      restore: () => {},
    };
  }

  const origDrawImage = ctx.drawImage;

  const inspectImageSource = (source: CanvasImageSource): boolean => {
    try {
      let w = 0;
      let h = 0;
      if (
        source instanceof HTMLCanvasElement ||
        source instanceof OffscreenCanvas ||
        source instanceof ImageBitmap ||
        source instanceof HTMLImageElement
      ) {
        w = source.width;
        h = source.height;
      } else if ("width" in source && "height" in source) {
        w = Number((source as { width: number }).width) || 0;
        h = Number((source as { height: number }).height) || 0;
      }
      if (w < 16 || h < 16) return false;

      const sampleW = Math.min(48, w);
      const sampleH = Math.min(48, h);
      const off = document.createElement("canvas");
      off.width = sampleW;
      off.height = sampleH;
      const offCtx = off.getContext("2d", { willReadFrequently: true });
      if (!offCtx) return false;
      offCtx.drawImage(source, 0, 0, sampleW, sampleH);
      const data = offCtx.getImageData(0, 0, sampleW, sampleH).data;
      const rep = classifyImageRegion(data, sampleW, sampleH);
      return rep.content_type === "photograph";
    } catch {
      return false;
    }
  };

  ctx.drawImage = function (
    image: CanvasImageSource,
    ...rest: number[]
  ): void {
    try {
      let dx = 0,
        dy = 0,
        dw = 0,
        dh = 0;
      if (rest.length === 2) {
        dx = rest[0];
        dy = rest[1];
        dw =
          "width" in image ? Number((image as { width: number }).width) : 0;
        dh =
          "height" in image ? Number((image as { height: number }).height) : 0;
      } else if (rest.length === 4) {
        dx = rest[0];
        dy = rest[1];
        dw = rest[2];
        dh = rest[3];
      } else if (rest.length >= 8) {
        dx = rest[4];
        dy = rest[5];
        dw = rest[6];
        dh = rest[7];
      }

      if (dw !== 0 && dh !== 0) {
        const mat = ctx.getTransform();
        const p1 = mat.transformPoint({ x: dx, y: dy });
        const p2 = mat.transformPoint({ x: dx + dw, y: dy });
        const p3 = mat.transformPoint({ x: dx, y: dy + dh });
        const p4 = mat.transformPoint({ x: dx + dw, y: dy + dh });

        const x0 = Math.max(
          0,
          Math.floor(Math.min(p1.x, p2.x, p3.x, p4.x))
        );
        const y0 = Math.max(
          0,
          Math.floor(Math.min(p1.y, p2.y, p3.y, p4.y))
        );
        const x1 = Math.min(
          canvasWidth,
          Math.ceil(Math.max(p1.x, p2.x, p3.x, p4.x))
        );
        const y1 = Math.min(
          canvasHeight,
          Math.ceil(Math.max(p1.y, p2.y, p3.y, p4.y))
        );

        const boxArea = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
        const pageArea = Math.max(1, canvasWidth * canvasHeight);
        const areaFraction = boxArea / pageArea;

        if (areaFraction > 0.002 && areaFraction < 0.85) {
          if (inspectImageSource(image)) {
            photoBoxes.push({
              x0: Math.floor(x0 * coordScale),
              y0: Math.floor(y0 * coordScale),
              x1: Math.ceil(x1 * coordScale),
              y1: Math.ceil(y1 * coordScale),
            });
          }
        }
      }
    } catch {
      // Non-fatal
    }

    return (origDrawImage as (...args: unknown[]) => void).apply(ctx, [
      image,
      ...rest,
    ]);
  } as typeof ctx.drawImage;

  return {
    getPhotoBoxes: () => photoBoxes,
    restore: () => {
      ctx.drawImage = origDrawImage;
    },
  };
}

/**
 * Downsamples a 2x supersampled raster buffer (`superW = dstW * 2, superH = dstH * 2`) into
 * an exact 1:1 physical-pixel buffer (`dstW x dstH`) using a separable 4x4 symmetric subpixel
 * tent kernel (`[1, 7, 7, 1] / 16` horizontally x `[1, 7, 7, 1] / 16` vertically, exact divisor 256).
 *
 * Concentrates 87.5% weight on the destination pixel's own 2x2 sub-block with a 6.25% symmetric
 * 0.5px feather on immediate subpixel neighbors, eliminating diagonal/curved staircase edges while
 * keeping 1px vertical & horizontal stems crisp with `#000000` / `#F2F2F2` solid cores.
 */
export function downsample2xWithCoolTypeFir(
  superRgba: Uint8ClampedArray,
  superW: number,
  superH: number,
  dstRgba: Uint8ClampedArray,
  dstW: number,
  dstH: number,
  lowZoomBoost = 0
): void {
  // Sharper (box-like) kernel at low zoom so thin stems stay focused instead of feathering into gray
  const wo = lowZoomBoost >= 0.3 ? 0 : 1;
  const wi = 8 - wo;
  const super32 = new Uint32Array(
    superRgba.buffer,
    superRgba.byteOffset,
    superW * superH
  );
  const dst32 = new Uint32Array(
    dstRgba.buffer,
    dstRgba.byteOffset,
    dstW * dstH
  );
  const stride = superW * 4;
  const maxX = superW - 1;
  const maxY = superH - 1;

  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = dy * 2 <= maxY ? dy * 2 : maxY;
    const sy1 = sy0 + 1 <= maxY ? sy0 + 1 : maxY;
    const sym1 = sy0 > 0 ? sy0 - 1 : 0;
    const sy2 = sy1 + 1 <= maxY ? sy1 + 1 : maxY;

    const r32_m1 = sym1 * superW;
    const r32_0 = sy0 * superW;
    const r32_1 = sy1 * superW;
    const r32_2 = sy2 * superW;

    const ru8_m1 = sym1 * stride;
    const ru8_0 = sy0 * stride;
    const ru8_1 = sy1 * stride;
    const ru8_2 = sy2 * stride;

    const dstRow_32 = dy * dstW;

    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = dx * 2;
      const sx1 = sx0 + 1 <= maxX ? sx0 + 1 : maxX;
      const sxm1 = sx0 > 0 ? sx0 - 1 : 0;
      const sx2 = sx1 + 1 <= maxX ? sx1 + 1 : maxX;

      // Fast path: core 2x2 + immediate border are pure white paper (~86% of textbook page)
      if (
        super32[r32_0 + sx0] === 0xffffffff &&
        super32[r32_0 + sx1] === 0xffffffff &&
        super32[r32_1 + sx0] === 0xffffffff &&
        super32[r32_1 + sx1] === 0xffffffff &&
        super32[r32_0 + sxm1] === 0xffffffff &&
        super32[r32_0 + sx2] === 0xffffffff &&
        super32[r32_m1 + sx0] === 0xffffffff &&
        super32[r32_2 + sx0] === 0xffffffff
      ) {
        dst32[dstRow_32 + dx] = 0xffffffff;
        continue;
      }

      const cm1 = sxm1 * 4;
      const c0 = sx0 * 4;
      const c1 = sx1 * 4;
      const c2 = sx2 * 4;

      // Separable [o, i, i, o] x [o, i, i, o] / 256 convolution per channel (o + i = 8)
      let rOut = 0;
      let gOut = 0;
      let bOut = 0;
      for (let ch = 0; ch < 3; ch++) {
        const rowM1 =
          wo * (superRgba[ru8_m1 + cm1 + ch] + superRgba[ru8_m1 + c2 + ch]) +
          wi * (superRgba[ru8_m1 + c0 + ch] + superRgba[ru8_m1 + c1 + ch]);
        const row0 =
          wo * (superRgba[ru8_0 + cm1 + ch] + superRgba[ru8_0 + c2 + ch]) +
          wi * (superRgba[ru8_0 + c0 + ch] + superRgba[ru8_0 + c1 + ch]);
        const row1 =
          wo * (superRgba[ru8_1 + cm1 + ch] + superRgba[ru8_1 + c2 + ch]) +
          wi * (superRgba[ru8_1 + c0 + ch] + superRgba[ru8_1 + c1 + ch]);
        const row2 =
          wo * (superRgba[ru8_2 + cm1 + ch] + superRgba[ru8_2 + c2 + ch]) +
          wi * (superRgba[ru8_2 + c0 + ch] + superRgba[ru8_2 + c1 + ch]);
        const out = (wo * (rowM1 + row2) + wi * (row0 + row1) + 128) >> 8;
        if (ch === 0) rOut = out;
        else if (ch === 1) gOut = out;
        else bOut = out;
      }
      dst32[dstRow_32 + dx] = (255 << 24) | (bOut << 16) | (gOut << 8) | rOut;
    }
  }
}

/**
 * Precomputed Apple-Quartz / CoolType CFF Stem-Darkening LUT for Light Mode (`!config.enabled` or `original`),
 * giving thin Type-1 `LMRoman10` stems rich `#000000` ink cores with silky, non-stepped diagonal/curve AA.
 */
const COOLTYPE_LIGHT_LUT_CACHE = new Map<number, Uint8Array>();

function getCoolTypeLightLut(boost: number): Uint8Array {
  const key = Math.round(boost * 20);
  const cached = COOLTYPE_LIGHT_LUT_CACHE.get(key);
  if (cached) return cached;
  const b = key / 20;
  const snap = 0.86 - 0.24 * b;
  const expo = 0.88 - 0.36 * b;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const rawAlpha = (255 - v) / 255.0;
    if (rawAlpha <= 0.012) {
      lut[v] = 255;
    } else if (rawAlpha >= snap) {
      lut[v] = 0;
    } else {
      const t = (rawAlpha - 0.012) / (snap - 0.012);
      const alphaOut = Math.pow(t, expo);
      lut[v] = Math.max(
        0,
        Math.min(255, Math.round((1.0 - alphaOut) * 255.0))
      );
    }
  }
  COOLTYPE_LIGHT_LUT_CACHE.set(key, lut);
  return lut;
}
/**
 * Transforms unbiased 1:1 `srcRgba` into `dstRgba`:
 * - In **Light Mode** (`!config.enabled || config.strategy === "original"`): applies Adobe CoolType
 *   CFF optical stem darkening to neutral glyph/vector ink while keeping colored pixels untouched.
 * - In **Dark Mode**: applies single-pass CoolType Linear RGB (gamma = 2.2) alpha blending +
 *   stem grid-fitting:
 *     Out_Linear.C = (Text_Linear.C * SubpixelAlpha.C) + (Bg_Linear.C * (1.0 - SubpixelAlpha.C))
 */
export function transformBufferToDarkFast(
  srcRgba: Uint8ClampedArray,
  dstRgba: Uint8ClampedArray,
  width: number,
  height: number,
  config: DarkModeConfig,
  report: ImageClassificationReport,
  photoBoxes: PixelBoundingBox[]
): void {
  const totalPixels = width * height;
  const src32 = new Uint32Array(
    srcRgba.buffer,
    srcRgba.byteOffset,
    totalPixels
  );
  const dst32 = new Uint32Array(
    dstRgba.buffer,
    dstRgba.byteOffset,
    totalPixels
  );

  const boost = report.low_zoom_boost ?? 0;
  const colorfulPage = isColorfulPage(report);
  const COOLTYPE_LIGHT_INK_U8 = getCoolTypeLightLut(boost);

  if (!config.enabled || config.strategy === "original" || colorfulPage) {
    if (report.content_type === "photograph" && !colorfulPage) {
      dstRgba.set(srcRgba);
      return;
    }
    for (let p = 0; p < totalPixels; p++) {
      const px = src32[p];
      if (px === 0xffffffff || px === 0xff000000) {
        dst32[p] = px;
        continue;
      }
      const r = px & 0xff;
      const g = (px >>> 8) & 0xff;
      const b = (px >>> 16) & 0xff;
      const maxC = r > g ? (r > b ? r : b) : g > b ? g : b;
      const minC = r < g ? (r < b ? r : b) : g < b ? g : b;
      if (maxC - minC > 16) {
        // Preserve exact color of hyperlinks, colored curves, and diagrams
        dst32[p] = px;
      } else {
        dst32[p] =
          (255 << 24) |
          (COOLTYPE_LIGHT_INK_U8[b] << 16) |
          (COOLTYPE_LIGHT_INK_U8[g] << 8) |
          COOLTYPE_LIGHT_INK_U8[r];
      }
    }
    return;
  }

  const bg = getTargetBackgroundRgb(config);
  const fgSrgb = Math.max(
    140,
    Math.min(255, Math.round(config.text_brightness * 255))
  );
  const contrast = Math.max(0.8, Math.min(1.5, config.contrast_boost));

  // Convert Background & Foreground to Linear RGB space (gamma = 2.2) per Section 3
  const bgLinR = SRGB_TO_LINEAR_LUT[bg[0]];
  const bgLinG = SRGB_TO_LINEAR_LUT[bg[1]];
  const bgLinB = SRGB_TO_LINEAR_LUT[bg[2]];

  const textLinR = SRGB_TO_LINEAR_LUT[fgSrgb];
  const textLinG = SRGB_TO_LINEAR_LUT[fgSrgb];
  const textLinB = SRGB_TO_LINEAR_LUT[fgSrgb];

  const isScannedStrategy =
    config.strategy === "scanned_adaptive" ||
    config.strategy === "scanned_color_preserve" ||
    report.estimated_paper_luma < 246;

  const paperWhite = isScannedStrategy
    ? Math.max(0.75, report.estimated_paper_luma / 255)
    : 1.0;
  const inkBlack =
    config.strategy === "scanned_adaptive"
      ? Math.min(0.3, report.estimated_ink_luma / 255)
      : 0.0;
  const dynamicRange = Math.max(0.25, paperWhite - inkBlack);
  const noiseFloor = config.strategy === "scanned_adaptive" ? 0.06 : 0.02;

  // Smooth non-stepped Dark Mode curve: avoids S-curve mid-tone pinching so diagonal/curved
  // strokes stay velvety smooth while stem centers (`>= 0.85`) reach 100% solid `fgSrgb`.
  const stemSnapPoint = Math.max(0.5, Math.min(0.92, (0.85 - 0.25 * boost) / contrast));
  const span = Math.max(0.15, stemSnapPoint - noiseFloor);

  const chLutR = new Uint8Array(256);
  const chLutG = new Uint8Array(256);
  const chLutB = new Uint8Array(256);
  const grayLut32 = new Uint32Array(256);
  const lutY = new Float32Array(256);

  for (let v = 0; v < 256; v++) {
    const normChannel = v / 255.0;
    const rawAlpha = Math.max(
      0.0,
      Math.min(1.0, (paperWhite - normChannel) / dynamicRange)
    );

    let subpixelAlpha = 0.0;
    if (rawAlpha <= noiseFloor) {
      subpixelAlpha = 0.0;
    } else if (rawAlpha >= stemSnapPoint) {
      subpixelAlpha = 1.0;
    } else {
      const t = (rawAlpha - noiseFloor) / span;
      // Continuous non-pinching gamma curve paired with Linear RGB (gamma = 2.2) blending
      subpixelAlpha = Math.pow(t, 1.06 - 0.46 * boost);
    }

    // Exact Section 3 Linear RGB Alpha Blending:
    // Out_Linear = Text_Linear * SubpixelAlpha + Bg_Linear * (1.0 - SubpixelAlpha)
    const outLinR = textLinR * subpixelAlpha + bgLinR * (1.0 - subpixelAlpha);
    const outLinG = textLinG * subpixelAlpha + bgLinG * (1.0 - subpixelAlpha);
    const outLinB = textLinB * subpixelAlpha + bgLinB * (1.0 - subpixelAlpha);

    const rSrgb = LINEAR_TO_SRGB_LUT[(outLinR * 4095.0 + 0.5) | 0];
    const gSrgb = LINEAR_TO_SRGB_LUT[(outLinG * 4095.0 + 0.5) | 0];
    const bSrgb = LINEAR_TO_SRGB_LUT[(outLinB * 4095.0 + 0.5) | 0];

    chLutR[v] = rSrgb;
    chLutG[v] = gSrgb;
    chLutB[v] = bSrgb;
    grayLut32[v] = (255 << 24) | (bSrgb << 16) | (gSrgb << 8) | rSrgb;
    lutY[v] = 0.2126 * rSrgb + 0.7152 * gSrgb + 0.0722 * bSrgb;
  }

  const whitePacked32 = grayLut32[255];
  const blackPacked32 = grayLut32[0];
  const preserveColors =
    config.preserve_diagram_colors && config.strategy !== "scanned_adaptive";

  const bgLuma255 = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2];
  const bgTintR = bg[0] - bgLuma255;
  const bgTintG = bg[1] - bgLuma255;
  const bgTintB = bg[2] - bgLuma255;

  for (let p = 0; p < totalPixels; p++) {
    const px = src32[p];
    if (px === 0xffffffff) {
      dst32[p] = whitePacked32;
      continue;
    }
    if (px === 0xff000000) {
      dst32[p] = blackPacked32;
      continue;
    }

    const r = px & 0xff;
    const g = (px >>> 8) & 0xff;
    const b = (px >>> 16) & 0xff;

    const maxC = r > g ? (r > b ? r : b) : g > b ? g : b;
    const minC = r < g ? (r < b ? r : b) : g < b ? g : b;
    const chromaDiff = maxC - minC;

    if (!preserveColors || chromaDiff <= 18) {
      dst32[p] =
        (255 << 24) | (chLutB[b] << 16) | (chLutG[g] << 8) | chLutR[r];
      continue;
    }

    const lumaIdx = (r * 54 + g * 183 + b * 19) >> 8;
    const yOrig = lumaIdx;
    const yDark = lutY[lumaIdx];

    const dR = r - yOrig;
    const dG = g - yOrig;
    const dB = b - yOrig;

    const normChroma = chromaDiff * 0.0039215686;
    const wOrig = 0.46 * normChroma;
    const yTarget = yDark * (1.0 - wOrig) + yOrig * wOrig;

    const rOut = Math.max(
      0,
      Math.min(255, (yTarget + bgTintR + dR * 0.92 + 0.5) | 0)
    );
    const gOut = Math.max(
      0,
      Math.min(255, (yTarget + bgTintG + dG * 0.92 + 0.5) | 0)
    );
    const bOut = Math.max(
      0,
      Math.min(255, (yTarget + bgTintB + dB * 0.92 + 0.5) | 0)
    );
    dst32[p] = (255 << 24) | (bOut << 16) | (gOut << 8) | rOut;
  }

  // Restore preserved photograph regions directly from pristine `src32`
  if (config.preserve_photographs && photoBoxes.length > 0) {
    for (const box of photoBoxes) {
      const x0 = Math.max(0, Math.min(width, box.x0));
      const x1 = Math.max(0, Math.min(width, box.x1));
      const y0 = Math.max(0, Math.min(height, box.y0));
      const y1 = Math.max(0, Math.min(height, box.y1));
      if (x1 > x0 && y1 > y0) {
        for (let row = y0; row < y1; row++) {
          const rowStart = row * width + x0;
          const rowEnd = row * width + x1;
          dst32.set(src32.subarray(rowStart, rowEnd), rowStart);
        }
      }
    }
  }
}

/**
 * Convenience wrapper that transforms a `CanvasRenderingContext2D` in-place.
 */
export function applyIntelligentDarkModeToCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  config: DarkModeConfig,
  photoBoxes: PixelBoundingBox[] = []
): ImageClassificationReport {
  const imgData = ctx.getImageData(0, 0, width, height);
  const rgba = imgData.data;
  const report = classifyImageRegion(rgba, width, height);

  if (!config.enabled || config.strategy === "original") {
    return report;
  }

  const srcCopy = new Uint8ClampedArray(rgba);
  transformBufferToDarkFast(
    srcCopy,
    rgba,
    width,
    height,
    config,
    report,
    photoBoxes
  );
  ctx.putImageData(imgData, 0, 0);
  return report;
}
