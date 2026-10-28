//! Native Rust PDF Inspection, Error Classification & Annotated PDF Exporter (`lopdf`).
//!
//! Validates PDF files, extracts structural metadata, guarantees original-file protection,
//! and exports standalone annotated PDFs with embedded vector strokes, highlights, and notes.

use crate::annotations::{AnnotationItem, DocumentAnnotations, MarkupKind};
use crate::storage::{compute_bytes_sha256, atomic_write_with_backup};
use lopdf::content::{Content, Operation};
use lopdf::{Document, Object};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PdfPageGeometry {
    pub page_number: u32,
    pub width_pt: f32,
    pub height_pt: f32,
    pub rotation_deg: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfDocumentMetadata {
    pub path: String,
    pub file_name: String,
    pub file_size_bytes: u64,
    pub content_sha256: String,
    pub pdf_version: String,
    pub page_count: u32,
    pub title: Option<String>,
    pub author: Option<String>,
    pub is_encrypted: bool,
    pub page_geometries: Vec<PdfPageGeometry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PdfLoadErrorKind {
    FileNotFound,
    PermissionDenied,
    InvalidPdfHeader,
    EncryptedDocument,
    CorruptedStructure,
    OverwriteProtected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfEngineError {
    pub kind: PdfLoadErrorKind,
    pub message: String,
}

impl PdfEngineError {
    pub fn new(kind: PdfLoadErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// Parses a `#RRGGBB` hex string into normalized `[f32; 3]` in `[0.0, 1.0]`.
fn parse_hex_color_f32(hex_str: &str) -> [f32; 3] {
    let clean = hex_str.trim().trim_start_matches('#');
    if clean.len() == 6 {
        let r = u8::from_str_radix(&clean[0..2], 16).unwrap_or(56) as f32 / 255.0;
        let g = u8::from_str_radix(&clean[2..4], 16).unwrap_or(189) as f32 / 255.0;
        let b = u8::from_str_radix(&clean[4..6], 16).unwrap_or(248) as f32 / 255.0;
        [r, g, b]
    } else {
        [0.22, 0.74, 0.97]
    }
}

fn extract_box_dimensions(obj: &Object) -> Option<(f32, f32)> {
    if let Ok(arr) = obj.as_array() {
        if arr.len() >= 4 {
            let x0 = arr[0]
                .as_f32()
                .or_else(|_| arr[0].as_i64().map(|v| v as f32))
                .unwrap_or(0.0);
            let y0 = arr[1]
                .as_f32()
                .or_else(|_| arr[1].as_i64().map(|v| v as f32))
                .unwrap_or(0.0);
            let x1 = arr[2]
                .as_f32()
                .or_else(|_| arr[2].as_i64().map(|v| v as f32))
                .unwrap_or(612.0);
            let y1 = arr[3]
                .as_f32()
                .or_else(|_| arr[3].as_i64().map(|v| v as f32))
                .unwrap_or(792.0);
            return Some(((x1 - x0).abs().max(72.0), (y1 - y0).abs().max(72.0)));
        }
    }
    None
}

/// Inspects a PDF file on disk without modifying it, returning its structural metadata and raw bytes.
pub fn inspect_pdf_file(path: &Path) -> Result<(PdfDocumentMetadata, Vec<u8>), PdfEngineError> {
    if !path.exists() {
        return Err(PdfEngineError::new(
            PdfLoadErrorKind::FileNotFound,
            format!(
                "The PDF file '{}' could not be found. It may have been moved, renamed, or deleted.",
                path.display()
            ),
        ));
    }

    let bytes = fs::read(path).map_err(|e| {
        PdfEngineError::new(
            PdfLoadErrorKind::PermissionDenied,
            format!("Unable to read '{}': {}", path.display(), e),
        )
    })?;

    inspect_pdf_bytes(path, bytes)
}

/// Inspects in-memory PDF bytes and extracts metadata, page geometries, and SHA-256 identity.
pub fn inspect_pdf_bytes(
    path: &Path,
    bytes: Vec<u8>,
) -> Result<(PdfDocumentMetadata, Vec<u8>), PdfEngineError> {
    if bytes.len() < 8 || !bytes.windows(5).take(1024).any(|w| w == b"%PDF-") {
        return Err(PdfEngineError::new(
            PdfLoadErrorKind::InvalidPdfHeader,
            "The selected file is not a valid PDF document (missing %PDF- header).",
        ));
    }

    let doc = Document::load_mem(&bytes).map_err(|e| {
        let err_str = e.to_string().to_lowercase();
        if err_str.contains("encrypt") || err_str.contains("password") {
            PdfEngineError::new(
                PdfLoadErrorKind::EncryptedDocument,
                "This PDF is encrypted or password-protected. Please unlock the document before opening.",
            )
        } else {
            PdfEngineError::new(
                PdfLoadErrorKind::CorruptedStructure,
                format!("The PDF file appears to be corrupted or uses an unsupported structure: {}", e),
            )
        }
    })?;

    if doc.is_encrypted() {
        return Err(PdfEngineError::new(
            PdfLoadErrorKind::EncryptedDocument,
            "This PDF is encrypted or password-protected and cannot be opened without decryption.",
        ));
    }

    let pages = doc.get_pages();
    if pages.is_empty() {
        return Err(PdfEngineError::new(
            PdfLoadErrorKind::CorruptedStructure,
            "The PDF document contains 0 pages.",
        ));
    }

    let mut page_geometries = Vec::with_capacity(pages.len());
    for (&page_num, &page_id) in &pages {
        let mut width_pt = 612.0f32;
        let mut height_pt = 792.0f32;
        let mut rotation_deg = 0i32;

        if let Ok(page_dict) = doc.get_dictionary(page_id) {
            if let Ok(mb) = page_dict.get(b"MediaBox") {
                if let Ok(resolved) = doc.dereference(mb) {
                    if let Some((w, h)) = extract_box_dimensions(resolved.1) {
                        width_pt = w;
                        height_pt = h;
                    }
                }
            }
            if let Ok(rot_obj) = page_dict.get(b"Rotate") {
                if let Ok(r) = rot_obj.as_i64() {
                    rotation_deg = (r as i32).rem_euclid(360);
                }
            }
        }

        page_geometries.push(PdfPageGeometry {
            page_number: page_num,
            width_pt,
            height_pt,
            rotation_deg,
        });
    }

    let content_sha256 = compute_bytes_sha256(&bytes);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "document.pdf".to_string());

    let metadata = PdfDocumentMetadata {
        path: path.to_string_lossy().to_string(),
        file_name,
        file_size_bytes: bytes.len() as u64,
        content_sha256,
        pdf_version: doc.version.clone(),
        page_count: pages.len() as u32,
        title: None,
        author: None,
        is_encrypted: false,
        page_geometries,
    };

    Ok((metadata, bytes))
}

/// Exports a separate annotated PDF file containing all pen strokes, highlighter strokes,
/// text highlights/underlines, and text notes rendered in PDF page coordinates.
/// Never overwrites `source_pdf_path` unless `allow_overwrite` is explicitly `true`.
pub fn export_annotated_pdf(
    source_pdf_path: &Path,
    output_pdf_path: &Path,
    annotations: &DocumentAnnotations,
    allow_overwrite: bool,
) -> Result<String, PdfEngineError> {
    let norm_src = source_pdf_path
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();
    let norm_out = output_pdf_path
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();

    if norm_src == norm_out && !allow_overwrite {
        return Err(PdfEngineError::new(
            PdfLoadErrorKind::OverwriteProtected,
            "Refusing to overwrite the original PDF file without explicit confirmation. Please choose a separate export filename.",
        ));
    }

    let src_bytes = fs::read(source_pdf_path).map_err(|e| {
        PdfEngineError::new(
            PdfLoadErrorKind::FileNotFound,
            format!("Failed to read source PDF for export: {}", e),
        )
    })?;

    let mut doc = Document::load_mem(&src_bytes).map_err(|e| {
        PdfEngineError::new(
            PdfLoadErrorKind::CorruptedStructure,
            format!("Failed to parse source PDF for export: {}", e),
        )
    })?;

    let pages = doc.get_pages();

    for (&page_num, &page_id) in &pages {
        let Some(items) = annotations.pages.get(&page_num) else {
            continue;
        };
        if items.is_empty() {
            continue;
        }

        // Determine page height in points for top-down -> bottom-up Y coordinate conversion
        let mut page_height = 792.0f32;
        if let Ok(page_dict) = doc.get_dictionary(page_id) {
            if let Ok(mb) = page_dict.get(b"MediaBox") {
                if let Ok(resolved) = doc.dereference(mb) {
                    if let Some((_, h)) = extract_box_dimensions(resolved.1) {
                        page_height = h;
                    }
                }
            }
        }

        let mut ops: Vec<Operation> = Vec::new();
        ops.push(Operation::new("q", vec![]));

        for item in items {
            match item {
                AnnotationItem::PenStroke {
                    color,
                    stroke_width,
                    points,
                    ..
                } => {
                    if points.is_empty() {
                        continue;
                    }
                    let [r, g, b] = parse_hex_color_f32(color);
                    ops.push(Operation::new("q", vec![]));
                    ops.push(Operation::new(
                        "RG",
                        vec![r.into(), g.into(), b.into()],
                    ));
                    ops.push(Operation::new("w", vec![(*stroke_width).max(0.5).into()]));
                    ops.push(Operation::new("J", vec![1.into()])); // round cap
                    ops.push(Operation::new("j", vec![1.into()])); // round join

                    let first = points[0];
                    ops.push(Operation::new(
                        "m",
                        vec![first.x.into(), (page_height - first.y).into()],
                    ));
                    for pt in points.iter().skip(1) {
                        ops.push(Operation::new(
                            "l",
                            vec![pt.x.into(), (page_height - pt.y).into()],
                        ));
                    }
                    if points.len() == 1 {
                        ops.push(Operation::new(
                            "l",
                            vec![(first.x + 0.5).into(), (page_height - first.y).into()],
                        ));
                    }
                    ops.push(Operation::new("S", vec![]));
                    ops.push(Operation::new("Q", vec![]));
                }
                AnnotationItem::HighlighterStroke {
                    color,
                    stroke_width,
                    points,
                    ..
                } => {
                    if points.is_empty() {
                        continue;
                    }
                    let [r, g, b] = parse_hex_color_f32(color);
                    ops.push(Operation::new("q", vec![]));
                    ops.push(Operation::new(
                        "RG",
                        vec![r.into(), g.into(), b.into()],
                    ));
                    ops.push(Operation::new("w", vec![(*stroke_width).max(4.0).into()]));
                    ops.push(Operation::new("J", vec![1.into()]));
                    ops.push(Operation::new("j", vec![1.into()]));

                    let first = points[0];
                    ops.push(Operation::new(
                        "m",
                        vec![first.x.into(), (page_height - first.y).into()],
                    ));
                    for pt in points.iter().skip(1) {
                        ops.push(Operation::new(
                            "l",
                            vec![pt.x.into(), (page_height - pt.y).into()],
                        ));
                    }
                    ops.push(Operation::new("S", vec![]));
                    ops.push(Operation::new("Q", vec![]));
                }
                AnnotationItem::TextMarkup {
                    kind, color, rects, ..
                } => {
                    let [r, g, b] = parse_hex_color_f32(color);
                    ops.push(Operation::new("q", vec![]));
                    ops.push(Operation::new(
                        "RG",
                        vec![r.into(), g.into(), b.into()],
                    ));
                    ops.push(Operation::new(
                        "rg",
                        vec![r.into(), g.into(), b.into()],
                    ));
                    for rect in rects {
                        let pdf_y = page_height - (rect.y + rect.height);
                        match kind {
                            MarkupKind::Underline => {
                                ops.push(Operation::new("w", vec![1.5.into()]));
                                ops.push(Operation::new("m", vec![rect.x.into(), pdf_y.into()]));
                                ops.push(Operation::new(
                                    "l",
                                    vec![(rect.x + rect.width).into(), pdf_y.into()],
                                ));
                                ops.push(Operation::new("S", vec![]));
                            }
                            MarkupKind::Highlight => {
                                ops.push(Operation::new("w", vec![1.0.into()]));
                                ops.push(Operation::new(
                                    "re",
                                    vec![
                                        rect.x.into(),
                                        pdf_y.into(),
                                        rect.width.into(),
                                        rect.height.into(),
                                    ],
                                ));
                                ops.push(Operation::new("S", vec![]));
                            }
                        }
                    }
                    ops.push(Operation::new("Q", vec![]));
                }
                AnnotationItem::TextNote {
                    x,
                    y,
                    color,
                    ..
                } => {
                    let [r, g, b] = parse_hex_color_f32(color);
                    let pdf_y = page_height - *y - 16.0;
                    ops.push(Operation::new("q", vec![]));
                    ops.push(Operation::new(
                        "rg",
                        vec![r.into(), g.into(), b.into()],
                    ));
                    ops.push(Operation::new(
                        "re",
                        vec![(*x).into(), pdf_y.into(), 16.0.into(), 16.0.into()],
                    ));
                    ops.push(Operation::new("f", vec![]));
                    ops.push(Operation::new("Q", vec![]));
                }
            }
        }

        ops.push(Operation::new("Q", vec![]));
        let content = Content { operations: ops };
        let _ = doc.add_to_page_content(page_id, content);
    }

    let mut out_buf = Vec::new();
    doc.save_to(&mut out_buf).map_err(|e| {
        PdfEngineError::new(
            PdfLoadErrorKind::CorruptedStructure,
            format!("Failed to serialize exported PDF: {}", e),
        )
    })?;

    atomic_write_with_backup(output_pdf_path, &out_buf).map_err(|e| {
        PdfEngineError::new(
            PdfLoadErrorKind::PermissionDenied,
            format!("Failed to write exported PDF: {}", e),
        )
    })?;

    Ok(output_pdf_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_invalid_and_missing_pdf_error_handling() {
        let dir = tempdir().expect("tempdir");
        let missing = dir.path().join("does_not_exist.pdf");
        let err = inspect_pdf_file(&missing).unwrap_err();
        assert_eq!(err.kind, PdfLoadErrorKind::FileNotFound);

        let bad_file = dir.path().join("not_a_pdf.pdf");
        fs::write(&bad_file, b"Hello world, not a PDF").unwrap();
        let err2 = inspect_pdf_file(&bad_file).unwrap_err();
        assert_eq!(err2.kind, PdfLoadErrorKind::InvalidPdfHeader);
    }
}
