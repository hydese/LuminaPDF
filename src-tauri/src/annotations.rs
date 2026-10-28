//! Annotation Engine & Document-Coordinate Transformations.
//!
//! Stores all annotation geometry in PDF page coordinates (points, 1/72 inch, relative to the
//! unrotated page box `[0..width_pt, 0..height_pt]`) so annotations remain accurately aligned
//! across any zoom level, scroll position, layout change, page rotation, or dark-mode toggle.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct StrokePoint {
    /// X coordinate in PDF page points `[0.0 .. page_width_pt]`.
    pub x: f32,
    /// Y coordinate in PDF page points `[0.0 .. page_height_pt]` (top-down page space).
    pub y: f32,
    /// Stylus/tablet pressure in `[0.0 .. 1.0]` (`0.5` default for mouse).
    pub pressure: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct PdfRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MarkupKind {
    Highlight,
    Underline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AnnotationItem {
    PenStroke {
        id: String,
        page_number: u32,
        color: String,
        stroke_width: f32,
        points: Vec<StrokePoint>,
        created_at: String,
    },
    HighlighterStroke {
        id: String,
        page_number: u32,
        color: String,
        stroke_width: f32,
        opacity: f32,
        points: Vec<StrokePoint>,
        created_at: String,
    },
    TextNote {
        id: String,
        page_number: u32,
        x: f32,
        y: f32,
        color: String,
        title: String,
        content: String,
        created_at: String,
        updated_at: String,
    },
    TextMarkup {
        id: String,
        page_number: u32,
        kind: MarkupKind,
        color: String,
        rects: Vec<PdfRect>,
        text_snippet: String,
        created_at: String,
    },
}

impl AnnotationItem {
    pub fn id(&self) -> &str {
        match self {
            AnnotationItem::PenStroke { id, .. }
            | AnnotationItem::HighlighterStroke { id, .. }
            | AnnotationItem::TextNote { id, .. }
            | AnnotationItem::TextMarkup { id, .. } => id,
        }
    }

    pub fn page_number(&self) -> u32 {
        match self {
            AnnotationItem::PenStroke { page_number, .. }
            | AnnotationItem::HighlighterStroke { page_number, .. }
            | AnnotationItem::TextNote { page_number, .. }
            | AnnotationItem::TextMarkup { page_number, .. } => *page_number,
        }
    }
}

/// Converts viewport screen coordinates `(screen_x, screen_y)` (in CSS pixels relative to the
/// rendered page canvas top-left) into canonical unrotated PDF page points `(x_pt, y_pt)`.
pub fn screen_to_page_coords(
    screen_x: f32,
    screen_y: f32,
    page_width_pt: f32,
    page_height_pt: f32,
    zoom_scale: f32,
    rotation_deg: i32,
) -> (f32, f32) {
    let scale = zoom_scale.max(0.05);
    let rx = screen_x / scale;
    let ry = screen_y / scale;
    let rot = rotation_deg.rem_euclid(360);

    match rot {
        90 => (ry.clamp(0.0, page_width_pt), (page_height_pt - rx).clamp(0.0, page_height_pt)),
        180 => (
            (page_width_pt - rx).clamp(0.0, page_width_pt),
            (page_height_pt - ry).clamp(0.0, page_height_pt),
        ),
        270 => ((page_width_pt - ry).clamp(0.0, page_width_pt), rx.clamp(0.0, page_height_pt)),
        _ => (rx.clamp(0.0, page_width_pt), ry.clamp(0.0, page_height_pt)),
    }
}

/// Converts canonical unrotated PDF page coordinates `(x_pt, y_pt)` into screen canvas pixels
/// `(screen_x, screen_y)` for a given `zoom_scale` and `rotation_deg`.
pub fn page_to_screen_coords(
    x_pt: f32,
    y_pt: f32,
    page_width_pt: f32,
    page_height_pt: f32,
    zoom_scale: f32,
    rotation_deg: i32,
) -> (f32, f32) {
    let scale = zoom_scale.max(0.05);
    let rot = rotation_deg.rem_euclid(360);

    let (rx, ry) = match rot {
        90 => (page_height_pt - y_pt, x_pt),
        180 => (page_width_pt - x_pt, page_height_pt - y_pt),
        270 => (y_pt, page_width_pt - x_pt),
        _ => (x_pt, y_pt),
    };

    (rx * scale, ry * scale)
}

/// Computes the minimum Euclidean distance from point `(px, py)` to line segment `(ax, ay)-(bx, by)`.
pub fn point_to_segment_distance(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let dx = bx - ax;
    let dy = by - ay;
    let len_sq = dx * dx + dy * dy;
    if len_sq <= 1e-6 {
        return ((px - ax).powi(2) + (py - ay).powi(2)).sqrt();
    }
    let t = (((px - ax) * dx + (py - ay) * dy) / len_sq).clamp(0.0, 1.0);
    let proj_x = ax + t * dx;
    let proj_y = ay + t * dy;
    ((px - proj_x).powi(2) + (py - proj_y).powi(2)).sqrt()
}

/// Checks whether an eraser at `(x_pt, y_pt)` with radius `radius_pt` hits `item`.
pub fn hit_test_annotation(item: &AnnotationItem, x_pt: f32, y_pt: f32, radius_pt: f32) -> bool {
    match item {
        AnnotationItem::PenStroke {
            points,
            stroke_width,
            ..
        }
        | AnnotationItem::HighlighterStroke {
            points,
            stroke_width,
            ..
        } => {
            let threshold = radius_pt + (*stroke_width * 0.5);
            if points.len() == 1 {
                let p = points[0];
                return ((x_pt - p.x).powi(2) + (y_pt - p.y).powi(2)).sqrt() <= threshold;
            }
            for win in points.windows(2) {
                let d = point_to_segment_distance(x_pt, y_pt, win[0].x, win[0].y, win[1].x, win[1].y);
                if d <= threshold {
                    return true;
                }
            }
            false
        }
        AnnotationItem::TextNote { x, y, .. } => {
            let note_box = PdfRect {
                x: *x - 4.0,
                y: *y - 4.0,
                width: 28.0,
                height: 28.0,
            };
            x_pt >= note_box.x - radius_pt
                && x_pt <= note_box.x + note_box.width + radius_pt
                && y_pt >= note_box.y - radius_pt
                && y_pt <= note_box.y + note_box.height + radius_pt
        }
        AnnotationItem::TextMarkup { rects, .. } => rects.iter().any(|r| {
            x_pt >= r.x - radius_pt
                && x_pt <= r.x + r.width + radius_pt
                && y_pt >= r.y - radius_pt
                && y_pt <= r.y + r.height + radius_pt
        }),
    }
}

/// Collection of annotations for a document indexed by 1-based page number.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct DocumentAnnotations {
    pub pages: BTreeMap<u32, Vec<AnnotationItem>>,
}

impl DocumentAnnotations {
    pub fn add(&mut self, item: AnnotationItem) {
        let page = item.page_number();
        self.pages.entry(page).or_default().push(item);
    }

    pub fn remove_by_id(&mut self, id: &str) -> Option<AnnotationItem> {
        for list in self.pages.values_mut() {
            if let Some(pos) = list.iter().position(|item| item.id() == id) {
                return Some(list.remove(pos));
            }
        }
        None
    }

    pub fn update_note(
        &mut self,
        id: &str,
        new_x: Option<f32>,
        new_y: Option<f32>,
        new_title: Option<String>,
        new_content: Option<String>,
        new_color: Option<String>,
        updated_at: String,
    ) -> bool {
        for list in self.pages.values_mut() {
            for item in list.iter_mut() {
                if let AnnotationItem::TextNote {
                    id: note_id,
                    x,
                    y,
                    title,
                    content,
                    color,
                    updated_at: ts,
                    ..
                } = item
                {
                    if note_id == id {
                        if let Some(nx) = new_x {
                            *x = nx;
                        }
                        if let Some(ny) = new_y {
                            *y = ny;
                        }
                        if let Some(nt) = new_title {
                            *title = nt;
                        }
                        if let Some(nc) = new_content {
                            *content = nc;
                        }
                        if let Some(ncol) = new_color {
                            *color = ncol;
                        }
                        *ts = updated_at;
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Erases all annotations on `page_number` hit by an eraser at `(x_pt, y_pt)` with `radius_pt`.
    /// Returns the IDs of removed annotations.
    pub fn erase_at(&mut self, page_number: u32, x_pt: f32, y_pt: f32, radius_pt: f32) -> Vec<String> {
        let mut removed = Vec::new();
        if let Some(list) = self.pages.get_mut(&page_number) {
            list.retain(|item| {
                if hit_test_annotation(item, x_pt, y_pt, radius_pt) {
                    removed.push(item.id().to_string());
                    false
                } else {
                    true
                }
            });
        }
        removed
    }

    pub fn total_count(&self) -> usize {
        self.pages.values().map(|v| v.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_coordinate_roundtrip_all_rotations_and_zooms() {
        let w = 612.0;
        let h = 792.0;
        let orig_x = 145.5;
        let orig_y = 320.25;

        for &rot in &[0, 90, 180, 270] {
            for &zoom in &[0.75, 1.0, 1.5, 2.25] {
                let (sx, sy) = page_to_screen_coords(orig_x, orig_y, w, h, zoom, rot);
                let (px, py) = screen_to_page_coords(sx, sy, w, h, zoom, rot);
                assert!(
                    (px - orig_x).abs() < 1e-3 && (py - orig_y).abs() < 1e-3,
                    "Failed roundtrip at rot={} zoom={}: got ({}, {}) expected ({}, {})",
                    rot,
                    zoom,
                    px,
                    py,
                    orig_x,
                    orig_y
                );
            }
        }
    }

    #[test]
    fn test_eraser_hit_test_and_serialization() {
        let mut doc_annots = DocumentAnnotations::default();
        let stroke = AnnotationItem::PenStroke {
            id: "stroke-1".to_string(),
            page_number: 1,
            color: "#38bdf8".to_string(),
            stroke_width: 3.0,
            points: vec![
                StrokePoint {
                    x: 100.0,
                    y: 100.0,
                    pressure: 0.6,
                },
                StrokePoint {
                    x: 200.0,
                    y: 100.0,
                    pressure: 0.8,
                },
            ],
            created_at: "2026-10-27T17:00:00Z".to_string(),
        };
        doc_annots.add(stroke);

        let json = serde_json::to_string(&doc_annots).expect("serialize");
        let restored: DocumentAnnotations = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored, doc_annots);

        // Erase far away -> should not remove
        let miss = doc_annots.erase_at(1, 300.0, 300.0, 8.0);
        assert!(miss.is_empty());
        assert_eq!(doc_annots.total_count(), 1);

        // Erase near midpoint (150, 103) -> should hit and remove
        let hit = doc_annots.erase_at(1, 150.0, 103.0, 6.0);
        assert_eq!(hit, vec!["stroke-1".to_string()]);
        assert_eq!(doc_annots.total_count(), 0);
    }
}
