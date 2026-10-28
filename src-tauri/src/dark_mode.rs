//! Intelligent Dark Mode Rendering & Classification Engine.
//!
//! Provides semantic color transformations for text and vector PDF operations as well as
//! content-aware classification and pixel processing for embedded images and scanned pages.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DarkRenderingStrategy {
    /// Automatically detects text/vector vs. scanned B&W vs. scanned color vs. photographs.
    Auto,
    /// Optimized for born-digital academic/technical PDFs with text, equations, and vectors.
    SemanticTextVector,
    /// Forces adaptive paper-background removal & grayscale-preserving inversion for B&W scans.
    ScannedAdaptive,
    /// Forces chroma-preserving lightness inversion for color scans & raster diagrams.
    ScannedColorPreserve,
    /// Original un-transformed PDF colors.
    Original,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundPreset {
    /// Default comfortable near-black (#121214)
    NearBlack,
    /// OLED true black (#000000)
    TrueBlack,
    /// Warm low-blue-light charcoal (#181715)
    WarmCharcoal,
    /// Deep academic slate (#0F141C)
    DeepSlate,
}

impl BackgroundPreset {
    pub fn rgb(&self) -> [u8; 3] {
        match self {
            BackgroundPreset::NearBlack => [18, 18, 20],
            BackgroundPreset::TrueBlack => [0, 0, 0],
            BackgroundPreset::WarmCharcoal => [24, 23, 21],
            BackgroundPreset::DeepSlate => [15, 20, 28],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DarkModeConfig {
    pub enabled: bool,
    pub strategy: DarkRenderingStrategy,
    pub background_preset: BackgroundPreset,
    pub custom_background_rgb: Option<[u8; 3]>,
    /// Target foreground text brightness in [0.60, 1.00], default 0.92.
    pub text_brightness: f32,
    /// Contrast boost factor in [0.80, 1.50], default 1.10.
    pub contrast_boost: f32,
    /// Preserve natural photographs without inverting them.
    pub preserve_photographs: bool,
    /// Preserve original hue of colored diagrams, charts, and links.
    pub preserve_diagram_colors: bool,
}

impl Default for DarkModeConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            strategy: DarkRenderingStrategy::Auto,
            background_preset: BackgroundPreset::NearBlack,
            custom_background_rgb: None,
            text_brightness: 0.92,
            contrast_boost: 1.00,
            preserve_photographs: true,
            preserve_diagram_colors: true,
        }
    }
}

impl DarkModeConfig {
    pub fn target_bg_rgb(&self) -> [u8; 3] {
        self.custom_background_rgb
            .unwrap_or_else(|| self.background_preset.rgb())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImageContentType {
    /// Natural photograph or full-bleed artwork (should not be inverted).
    Photograph,
    /// Scanned black-and-white page or monochrome equation/diagram bitmap on light paper.
    ScannedMonochrome,
    /// Scanned color page or colored chart/diagram on light paper background.
    ScannedColor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageClassificationReport {
    pub content_type: ImageContentType,
    pub light_paper_ratio: f32,
    pub dark_ink_ratio: f32,
    pub colored_pixel_ratio: f32,
    pub estimated_paper_luma: u8,
    pub estimated_ink_luma: u8,
}

/// Converts sRGB `[u8; 3]` to `(h, s, l)` where `h` is in `[0.0, 360.0)`, `s, l` in `[0.0, 1.0]`.
#[inline]
pub fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let rf = r as f32 / 255.0;
    let gf = g as f32 / 255.0;
    let bf = b as f32 / 255.0;

    let max = rf.max(gf).max(bf);
    let min = rf.min(gf).min(bf);
    let l = (max + min) * 0.5;

    if (max - min).abs() < 1e-6 {
        return (0.0, 0.0, l);
    }

    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };

    let h = if (max - rf).abs() < 1e-6 {
        let mut h = (gf - bf) / d;
        if gf < bf {
            h += 6.0;
        }
        h * 60.0
    } else if (max - gf).abs() < 1e-6 {
        ((bf - rf) / d + 2.0) * 60.0
    } else {
        ((rf - gf) / d + 4.0) * 60.0
    };

    (h, s, l)
}

/// Converts `(h, s, l)` back to sRGB `[u8; 3]`.
#[inline]
pub fn hsl_to_rgb(h: f32, s: f32, l: f32) -> [u8; 3] {
    let s = s.clamp(0.0, 1.0);
    let l = l.clamp(0.0, 1.0);
    if s <= 1e-6 {
        let v = (l * 255.0).round() as u8;
        return [v, v, v];
    }

    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (h.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - (hp.rem_euclid(2.0) - 1.0).abs());
    let m = l - c * 0.5;

    let (r1, g1, b1) = if hp < 1.0 {
        (c, x, 0.0)
    } else if hp < 2.0 {
        (x, c, 0.0)
    } else if hp < 3.0 {
        (0.0, c, x)
    } else if hp < 4.0 {
        (0.0, x, c)
    } else if hp < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };

    [
        ((r1 + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((g1 + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((b1 + m) * 255.0).round().clamp(0.0, 255.0) as u8,
    ]
}

/// Perceptual Rec.709 luminance in `[0.0, 1.0]`.
#[inline]
pub fn perceptual_luma(r: u8, g: u8, b: u8) -> f32 {
    (0.2126 * (r as f32) + 0.7152 * (g as f32) + 0.0722 * (b as f32)) / 255.0
}

/// Normalized RGB chroma `(max - min) / 255.0` in `[0.0, 1.0]`.
/// Unlike HSL saturation, chroma does not amplify 1-2 bit rounding noise near white (L -> 1.0).
#[inline]
pub fn rgb_chroma(r: u8, g: u8, b: u8) -> f32 {
    let max = r.max(g).max(b) as f32;
    let min = r.min(g).min(b) as f32;
    (max - min) / 255.0
}

/// Transforms a PDF background fill color (such as page background or callout rectangle).
pub fn transform_background_color(rgb: [u8; 3], config: &DarkModeConfig) -> [u8; 3] {
    if !config.enabled || config.strategy == DarkRenderingStrategy::Original {
        return rgb;
    }

    let bg = config.target_bg_rgb();
    let (h, s, l) = rgb_to_hsl(rgb[0], rgb[1], rgb[2]);
    let luma = perceptual_luma(rgb[0], rgb[1], rgb[2]);
    let chroma = rgb_chroma(rgb[0], rgb[1], rgb[2]);

    // Near-white or light neutral page background -> map directly to target dark background
    if luma >= 0.80 && (s < 0.20 || chroma < 0.10) {
        return bg;
    }

    // Lightly tinted callout boxes / table headers -> keep subtle hue, map to dark surface
    if luma > 0.50 {
        let dark_base_l = perceptual_luma(bg[0], bg[1], bg[2]);
        let mapped_l = (dark_base_l + (1.0 - l) * 0.22).clamp(0.06, 0.28);
        return hsl_to_rgb(h, (s * 0.65).clamp(0.0, 0.55), mapped_l);
    }

    rgb
}

/// Transforms a PDF text, math formula, or vector stroke/fill color.
pub fn transform_text_or_vector_color(rgb: [u8; 3], config: &DarkModeConfig) -> [u8; 3] {
    if !config.enabled || config.strategy == DarkRenderingStrategy::Original {
        return rgb;
    }

    let bg = config.target_bg_rgb();
    let bg_luma = perceptual_luma(bg[0], bg[1], bg[2]);
    let max_fg = config.text_brightness.clamp(0.60, 1.0);
    let contrast = config.contrast_boost.clamp(0.80, 1.50);

    let (h, s, l) = rgb_to_hsl(rgb[0], rgb[1], rgb[2]);
    let luma = perceptual_luma(rgb[0], rgb[1], rgb[2]);
    let chroma = rgb_chroma(rgb[0], rgb[1], rgb[2]);

    // Saturated vector elements (colored diagrams, links, equations highlights)
    if config.preserve_diagram_colors && s >= 0.22 && chroma >= 0.10 {
        // Keep exact hue, boost lightness if too dark for dark background
        let adjusted_l = if l < 0.58 {
            0.58 + (0.58 - l) * 0.45
        } else if l > 0.88 {
            0.78
        } else {
            l
        };
        let adjusted_s = (s * 1.05).clamp(0.22, 0.95);
        return hsl_to_rgb(h, adjusted_s, adjusted_l.clamp(0.52, 0.86));
    }

    // Achromatic or near-achromatic text, math symbols, and vector lines:
    // Invert luma relative to background and scale by text_brightness & contrast_boost.
    let inverted = 1.0 - luma;
    let contrasted = ((inverted - 0.5) * contrast + 0.5).clamp(0.0, 1.0);
    let out_luma = bg_luma + contrasted * (max_fg - bg_luma);

    // Subtle warm/cool tint from background if text is nearly neutral
    let r_out = (bg[0] as f32 + (out_luma - bg_luma) * 255.0)
        .round()
        .clamp(0.0, 255.0) as u8;
    let g_out = (bg[1] as f32 + (out_luma - bg_luma) * 255.0)
        .round()
        .clamp(0.0, 255.0) as u8;
    let b_out = (bg[2] as f32 + (out_luma - bg_luma) * 255.0)
        .round()
        .clamp(0.0, 255.0) as u8;

    [r_out, g_out, b_out]
}

/// Classifies an RGBA image buffer to determine whether it is a natural photograph,
/// a scanned B&W page / monochrome diagram, or a scanned color page / colored diagram.
pub fn classify_image_region(
    rgba: &[u8],
    width: u32,
    height: u32,
) -> ImageClassificationReport {
    let total_pixels = (width as usize) * (height as usize);
    if total_pixels == 0 || rgba.len() < total_pixels * 4 {
        return ImageClassificationReport {
            content_type: ImageContentType::Photograph,
            light_paper_ratio: 0.0,
            dark_ink_ratio: 0.0,
            colored_pixel_ratio: 0.0,
            estimated_paper_luma: 255,
            estimated_ink_luma: 0,
        };
    }

    // Sample up to ~8192 pixels uniformly for sub-millisecond classification
    let step = (total_pixels / 8192).max(1);
    let mut sampled = 0usize;
    let mut light_paper = 0usize;
    let mut dark_ink = 0usize;
    let mut colored = 0usize;
    let mut midtone_neutral = 0usize;
    let mut luma_hist = [0u32; 256];

    let mut idx = 0usize;
    while idx < total_pixels {
        let base = idx * 4;
        let a = rgba[base + 3];
        if a >= 32 {
            let r = rgba[base];
            let g = rgba[base + 1];
            let b = rgba[base + 2];
            let (_, s, _) = rgb_to_hsl(r, g, b);
            let luma = perceptual_luma(r, g, b);
            let luma_u8 = (luma * 255.0).round().clamp(0.0, 255.0) as usize;
            luma_hist[luma_u8] += 1;
            sampled += 1;

            if s >= 0.24 && luma > 0.12 && luma < 0.92 {
                colored += 1;
            }
            if luma >= 0.74 && s < 0.20 {
                light_paper += 1;
            } else if luma <= 0.32 && s < 0.25 {
                dark_ink += 1;
            } else if s < 0.18 {
                midtone_neutral += 1;
            }
        } else {
            // Transparent pixel acts like paper background in embedded diagrams
            light_paper += 1;
            sampled += 1;
            luma_hist[255] += 1;
        }
        idx += step;
    }

    if sampled == 0 {
        return ImageClassificationReport {
            content_type: ImageContentType::Photograph,
            light_paper_ratio: 0.0,
            dark_ink_ratio: 0.0,
            colored_pixel_ratio: 0.0,
            estimated_paper_luma: 255,
            estimated_ink_luma: 0,
        };
    }

    let light_paper_ratio = light_paper as f32 / sampled as f32;
    let dark_ink_ratio = dark_ink as f32 / sampled as f32;
    let colored_pixel_ratio = colored as f32 / sampled as f32;
    let midtone_ratio = midtone_neutral as f32 / sampled as f32;

    // Estimate 90th percentile luma (paper white point) and 5th percentile luma (ink black point)
    let p90_target = ((sampled as f32) * 0.90) as u32;
    let p05_target = ((sampled as f32) * 0.05) as u32;
    let mut cumulative = 0u32;
    let mut p05_luma = 15u8;
    let mut p90_luma = 240u8;
    let mut found_p05 = false;

    for (val, &count) in luma_hist.iter().enumerate() {
        cumulative += count;
        if !found_p05 && cumulative >= p05_target {
            p05_luma = val as u8;
            found_p05 = true;
        }
        if cumulative >= p90_target {
            p90_luma = val as u8;
            break;
        }
    }

    // Decision logic:
    // A scanned page or diagram has a dominant light paper background (light_paper_ratio >= 0.42)
    // and isn't dominated by continuous photographic midtones without ink contrast.
    let is_paper_backed = light_paper_ratio >= 0.42 && midtone_ratio < 0.52;

    let content_type = if !is_paper_backed {
        ImageContentType::Photograph
    } else if colored_pixel_ratio >= 0.06 {
        ImageContentType::ScannedColor
    } else {
        ImageContentType::ScannedMonochrome
    };

    ImageClassificationReport {
        content_type,
        light_paper_ratio,
        dark_ink_ratio,
        colored_pixel_ratio,
        estimated_paper_luma: p90_luma.max(190),
        estimated_ink_luma: p05_luma.min(90),
    }
}

/// Processes an RGBA image buffer in-place according to the active `DarkModeConfig` and
/// content classification. Uses parallel row processing via `rayon`.
pub fn process_image_buffer_dark_mode(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    config: &DarkModeConfig,
) -> ImageClassificationReport {
    let report = classify_image_region(rgba, width, height);
    if !config.enabled || config.strategy == DarkRenderingStrategy::Original {
        return report;
    }

    let effective_type = match config.strategy {
        DarkRenderingStrategy::Auto | DarkRenderingStrategy::SemanticTextVector => {
            report.content_type
        }
        DarkRenderingStrategy::ScannedAdaptive => ImageContentType::ScannedMonochrome,
        DarkRenderingStrategy::ScannedColorPreserve => ImageContentType::ScannedColor,
        DarkRenderingStrategy::Original => return report,
    };

    if effective_type == ImageContentType::Photograph && config.preserve_photographs {
        // Preserve photographs in their authentic colors
        return report;
    }

    let bg = config.target_bg_rgb();
    let max_fg = config.text_brightness.clamp(0.60, 1.0);
    let contrast = config.contrast_boost.clamp(0.80, 1.50);
    let paper_white = (report.estimated_paper_luma as f32 / 255.0).max(0.75);
    let ink_black = (report.estimated_ink_luma as f32 / 255.0).min(0.35);
    let dynamic_range = (paper_white - ink_black).max(0.25);

    rgba.par_chunks_exact_mut(4).for_each(|px| {
        let a = px[3];
        if a < 8 {
            return;
        }
        let r = px[0];
        let g = px[1];
        let b = px[2];

        match effective_type {
            ImageContentType::ScannedMonochrome => {
                // Adaptive paper-background suppression + smooth grayscale ink inversion
                let luma = perceptual_luma(r, g, b);
                // Normalize relative to estimated paper white & ink black points:
                // 0.0 = paper background, 1.0 = darkest ink
                let mut ink_strength = ((paper_white - luma) / dynamic_range).clamp(0.0, 1.0);
                // Suppress faint paper grain/bleed-through below 0.08
                if ink_strength < 0.08 {
                    ink_strength = 0.0;
                } else {
                    ink_strength = ((ink_strength - 0.08) / 0.92).powf(1.0 / contrast);
                }

                let fg_scale = ink_strength * max_fg;
                px[0] = (bg[0] as f32 + fg_scale * (255.0 - bg[0] as f32))
                    .round()
                    .clamp(0.0, 255.0) as u8;
                px[1] = (bg[1] as f32 + fg_scale * (255.0 - bg[1] as f32))
                    .round()
                    .clamp(0.0, 255.0) as u8;
                px[2] = (bg[2] as f32 + fg_scale * (255.0 - bg[2] as f32))
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
            ImageContentType::ScannedColor | ImageContentType::Photograph => {
                let (h, s, l) = rgb_to_hsl(r, g, b);
                if s >= 0.22 && config.preserve_diagram_colors {
                    // Chroma-preserving lightness inversion for colored charts/diagrams on scanned pages
                    let new_l = if l > 0.80 {
                        0.15 + (1.0 - l) * 0.5
                    } else if l < 0.45 {
                        (0.58 + (0.45 - l) * 0.45).clamp(0.55, 0.85)
                    } else {
                        l.clamp(0.48, 0.78)
                    };
                    let [nr, ng, nb] = hsl_to_rgb(h, (s * 1.05).clamp(0.22, 0.95), new_l);
                    px[0] = nr;
                    px[1] = ng;
                    px[2] = nb;
                } else {
                    let luma = perceptual_luma(r, g, b);
                    let mut ink_strength = ((paper_white - luma) / dynamic_range).clamp(0.0, 1.0);
                    if ink_strength < 0.07 {
                        ink_strength = 0.0;
                    } else {
                        ink_strength = ((ink_strength - 0.07) / 0.93).powf(1.0 / contrast);
                    }
                    let fg_scale = ink_strength * max_fg;
                    px[0] = (bg[0] as f32 + fg_scale * (255.0 - bg[0] as f32))
                        .round()
                        .clamp(0.0, 255.0) as u8;
                    px[1] = (bg[1] as f32 + fg_scale * (255.0 - bg[1] as f32))
                        .round()
                        .clamp(0.0, 255.0) as u8;
                    px[2] = (bg[2] as f32 + fg_scale * (255.0 - bg[2] as f32))
                        .round()
                        .clamp(0.0, 255.0) as u8;
                }
            }
        }
    });

    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_white_background_becomes_dark() {
        let cfg = DarkModeConfig::default();
        let out = transform_background_color([255, 255, 255], &cfg);
        assert_eq!(out, [18, 18, 20]);

        let mut true_black_cfg = DarkModeConfig::default();
        true_black_cfg.background_preset = BackgroundPreset::TrueBlack;
        assert_eq!(
            transform_background_color([252, 252, 250], &true_black_cfg),
            [0, 0, 0]
        );
    }

    #[test]
    fn test_black_text_becomes_high_contrast_light() {
        let cfg = DarkModeConfig::default();
        let out = transform_text_or_vector_color([0, 0, 0], &cfg);
        // Should be bright light gray (> 215 in all channels)
        assert!(out[0] > 215 && out[1] > 215 && out[2] > 215);
    }

    #[test]
    fn test_colored_diagram_preserves_hue_in_dark_mode() {
        let cfg = DarkModeConfig::default();
        // Pure dark blue vector curve in a diagram: RGB(0, 50, 200) -> Hue ~225 deg
        let (orig_h, _, _) = rgb_to_hsl(0, 50, 200);
        let out = transform_text_or_vector_color([0, 50, 200], &cfg);
        let (new_h, new_s, new_l) = rgb_to_hsl(out[0], out[1], out[2]);
        assert!(
            (orig_h - new_h).abs() < 4.0,
            "Hue should be preserved: orig={} new={}",
            orig_h,
            new_h
        );
        assert!(new_s > 0.5, "Saturation should remain vibrant");
        assert!(
            new_l > 0.55,
            "Lightness should be boosted for dark background readability"
        );
    }

    #[test]
    fn test_classify_and_process_scanned_monochrome_vs_photo() {
        // 1. Construct a synthetic 32x32 scanned B&W page (85% off-white paper, 15% dark ink)
        let mut scan_rgba = vec![0u8; 32 * 32 * 4];
        for i in 0..(32 * 32) {
            let base = i * 4;
            if i % 7 == 0 {
                // Dark gray/black ink
                scan_rgba[base] = 25;
                scan_rgba[base + 1] = 25;
                scan_rgba[base + 2] = 25;
                scan_rgba[base + 3] = 255;
            } else {
                // Slightly off-white scanned paper (242, 240, 236)
                scan_rgba[base] = 242;
                scan_rgba[base + 1] = 240;
                scan_rgba[base + 2] = 236;
                scan_rgba[base + 3] = 255;
            }
        }
        let cfg = DarkModeConfig::default();
        let report = process_image_buffer_dark_mode(&mut scan_rgba, 32, 32, &cfg);
        assert_eq!(report.content_type, ImageContentType::ScannedMonochrome);
        // First pixel (i=0) was dark ink -> should now be bright light text (> 200)
        assert!(scan_rgba[0] > 200);
        // Second pixel (i=1) was off-white paper -> should now match dark background (18, 18, 20)
        assert_eq!(&scan_rgba[4..7], &[18, 18, 20]);

        // 2. Construct a synthetic natural photograph (sky/foliage/skin tones, low white-paper ratio)
        let mut photo_rgba = vec![0u8; 32 * 32 * 4];
        for i in 0..(32 * 32) {
            let base = i * 4;
            photo_rgba[base] = ((i * 37) % 180 + 20) as u8;
            photo_rgba[base + 1] = ((i * 59) % 170 + 30) as u8;
            photo_rgba[base + 2] = ((i * 83) % 160 + 25) as u8;
            photo_rgba[base + 3] = 255;
        }
        let orig_photo = photo_rgba.clone();
        let photo_report = process_image_buffer_dark_mode(&mut photo_rgba, 32, 32, &cfg);
        assert_eq!(photo_report.content_type, ImageContentType::Photograph);
        // Photograph pixels must remain untouched!
        assert_eq!(photo_rgba, orig_photo);
    }
}
