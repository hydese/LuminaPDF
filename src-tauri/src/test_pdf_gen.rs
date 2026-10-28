//! Synthetic Test PDF Suite Generator (`lopdf`).
//!
//! Generates the 10 representative academic, mathematical, diagram, photographic,
//! scanned B&W, scanned color, linked/outlined, annotated, 300-page, and rotated test PDFs.

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};
use std::fs;
use std::path::{Path, PathBuf};

/// Helper to build a single- or multi-page PDF document with custom page content operations.
fn build_pdf_with_pages(
    pages_spec: Vec<(f32, f32, i64, Vec<Operation>, Option< (u32, u32, Vec<u8>) >)>,
    with_outlines: bool,
    with_links_and_annots: bool,
) -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();

    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let font_bold_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica-Bold",
    });
    let font_math_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Times-Italic",
    });

    let mut page_ids = Vec::with_capacity(pages_spec.len());
    for _ in 0..pages_spec.len() {
        page_ids.push(doc.new_object_id());
    }

    for (idx, (width, height, rotate, ops, maybe_img)) in pages_spec.into_iter().enumerate() {
        let page_id = page_ids[idx];
        let mut xobject_dict = lopdf::Dictionary::new();

        if let Some((img_w, img_h, rgb_bytes)) = maybe_img {
            let img_stream = Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Image",
                    "Width" => img_w as i64,
                    "Height" => img_h as i64,
                    "ColorSpace" => "DeviceRGB",
                    "BitsPerComponent" => 8,
                },
                rgb_bytes,
            );
            let img_id = doc.add_object(img_stream);
            xobject_dict.set("Im0", img_id);
        }

        let resources_id = doc.add_object(dictionary! {
            "Font" => dictionary! {
                "F1" => font_id,
                "F2" => font_bold_id,
                "F3" => font_math_id,
            },
            "XObject" => xobject_dict,
        });

        let content = Content { operations: ops };
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap_or_default()));

        let mut page_dict = dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), width.into(), height.into()],
            "Resources" => resources_id,
            "Contents" => content_id,
        };
        if rotate != 0 {
            page_dict.set("Rotate", rotate);
        }

        if with_links_and_annots && idx == 0 {
            let mut annots = Vec::new();
            // Internal link to last page
            if page_ids.len() >= 2 {
                let target_page_id = page_ids[page_ids.len() - 1];
                let internal_link_id = doc.add_object(dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Link",
                    "Rect" => vec![72.into(), 580.into(), 340.into(), 605.into()],
                    "Border" => vec![0.into(), 0.into(), 1.into()],
                    "Dest" => vec![target_page_id.into(), Object::Name(b"XYZ".to_vec()), Object::Null, Object::Null, Object::Null],
                });
                annots.push(internal_link_id.into());
            }
            // External URI link
            let ext_link_id = doc.add_object(dictionary! {
                "Type" => "Annot",
                "Subtype" => "Link",
                "Rect" => vec![72.into(), 535.into(), 380.into(), 560.into()],
                "Border" => vec![0.into(), 0.into(), 1.into()],
                "A" => dictionary! {
                    "Type" => "Action",
                    "S" => "URI",
                    "URI" => Object::string_literal("https://www.w3.org/TR/PDF20/"),
                },
            });
            annots.push(ext_link_id.into());
            page_dict.set("Annots", annots);
        }

        doc.objects.insert(page_id, Object::Dictionary(page_dict));
    }

    let kids: Vec<Object> = page_ids.iter().map(|&id| id.into()).collect();
    let pages_dict = dictionary! {
        "Type" => "Pages",
        "Kids" => kids,
        "Count" => page_ids.len() as i64,
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages_dict));

    let mut catalog = dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    };

    if with_outlines && !page_ids.is_empty() {
        let outlines_id = doc.new_object_id();
        let first_item_id = doc.new_object_id();
        let last_item_id = doc.new_object_id();
        let target_last = *page_ids.last().unwrap();

        doc.objects.insert(
            first_item_id,
            Object::Dictionary(dictionary! {
                "Title" => Object::string_literal("1. Introduction & Links"),
                "Parent" => outlines_id,
                "Next" => last_item_id,
                "Dest" => vec![page_ids[0].into(), Object::Name(b"XYZ".to_vec()), Object::Null, Object::Null, Object::Null],
            }),
        );
        doc.objects.insert(
            last_item_id,
            Object::Dictionary(dictionary! {
                "Title" => Object::string_literal("2. Deep Reference Section"),
                "Parent" => outlines_id,
                "Prev" => first_item_id,
                "Dest" => vec![target_last.into(), Object::Name(b"XYZ".to_vec()), Object::Null, Object::Null, Object::Null],
            }),
        );
        doc.objects.insert(
            outlines_id,
            Object::Dictionary(dictionary! {
                "Type" => "Outlines",
                "First" => first_item_id,
                "Last" => last_item_id,
                "Count" => 2,
            }),
        );
        catalog.set("Outlines", outlines_id);
    }

    let catalog_id = doc.add_object(catalog);
    doc.trailer.set("Root", catalog_id);

    let mut out = Vec::new();
    let _ = doc.save_to(&mut out);
    out
}

fn text_op(font: &str, size: f32, x: f32, y: f32, text: &str, rgb: [f32; 3]) -> Vec<Operation> {
    vec![
        Operation::new("BT", vec![]),
        Operation::new("rg", vec![rgb[0].into(), rgb[1].into(), rgb[2].into()]),
        Operation::new("Tf", vec![font.into(), size.into()]),
        Operation::new("Td", vec![x.into(), y.into()]),
        Operation::new("Tj", vec![Object::string_literal(text)]),
        Operation::new("ET", vec![]),
    ]
}

/// Generates all 10 required synthetic test PDFs inside `output_dir` and returns their paths.
pub fn generate_all_test_pdfs(output_dir: &Path) -> Result<Vec<PathBuf>, String> {
    fs::create_dir_all(output_dir).map_err(|e| format!("Failed to create sample-pdfs dir: {}", e))?;
    let mut created = Vec::new();

    // 1. 01_academic_text.pdf
    {
        let mut ops = Vec::new();
        // White page background
        ops.push(Operation::new("rg", vec![1.0.into(), 1.0.into(), 1.0.into()]));
        ops.push(Operation::new("re", vec![0.into(), 0.into(), 612.into(), 792.into()]));
        ops.push(Operation::new("f", vec![]));
        ops.extend(text_op(
            "F2",
            18.0,
            72.0,
            720.0,
            "1. Spectral Graph Theory & Laplacian Operators",
            [0.05, 0.05, 0.05],
        ));
        ops.extend(text_op(
            "F1",
            11.5,
            72.0,
            685.0,
            "Abstract: Let G = (V, E) be a finite connected undirected graph with n vertices.",
            [0.10, 0.10, 0.10],
        ));
        ops.extend(text_op(
            "F1",
            11.5,
            72.0,
            665.0,
            "The normalized graph Laplacian L = I - D^(-1/2) A D^(-1/2) encodes fundamental",
            [0.10, 0.10, 0.10],
        ));
        ops.extend(text_op(
            "F1",
            11.5,
            72.0,
            645.0,
            "conductance, random-walk mixing time, and eigenvalue partitioning properties.",
            [0.10, 0.10, 0.10],
        ));
        let bytes = build_pdf_with_pages(vec![(612.0, 792.0, 0, ops, None)], false, false);
        let p = output_dir.join("01_academic_text.pdf");
        fs::write(&p, bytes).map_err(|e| e.to_string())?;
        created.push(p);
    }

    // 2. 02_equations_math.pdf
    {
        let mut ops = Vec::new();
        ops.push(Operation::new("rg", vec![1.0.into(), 1.0.into(), 1.0.into()]));
        ops.push(Operation::new("re", vec![0.into(), 0.into(), 612.into(), 792.into()]));
        ops.push(Operation::new("f", vec![]));
        ops.extend(text_op(
            "F2",
            16.0,
            72.0,
            720.0,
            "2. Mathematical Equations & Vector Notation",
            [0.0, 0.0, 0.0],
        ));
        ops.extend(text_op(
            "F3",
            14.0,
            110.0,
            665.0,
            "f(x) = Integral [ exp(-pi * x^2) * cos(2 * pi * omega * x) ] dx",
            [0.05, 0.05, 0.08],
        ));
        // Vector fraction bar and matrix brackets
        ops.push(Operation::new("RG", vec![0.05.into(), 0.05.into(), 0.05.into()]));
        ops.push(Operation::new("w", vec![1.5.into()]));
        ops.push(Operation::new("m", vec![110.into(), 655.into()]));
        ops.push(Operation::new("l", vec![470.into(), 655.into()]));
        ops.push(Operation::new("S", vec![]));
        ops.extend(text_op(
            "F3",
            13.0,
            230.0,
            638.0,
            "sqrt(2 * pi * sigma^2)",
            [0.05, 0.05, 0.08],
        ));
        let bytes = build_pdf_with_pages(vec![(612.0, 792.0, 0, ops, None)], false, false);
        let p = output_dir.join("02_equations_math.pdf");
        fs::write(&p, bytes).map_err(|e| e.to_string())?;
        created.push(p);
    }

    // 3. 03_colored_diagrams.pdf
    {
        let mut ops = Vec::new();
        ops.push(Operation::new("rg", vec![1.0.into(), 1.0.into(), 1.0.into()]));
        ops.push(Operation::new("re", vec![0.into(), 0.into(), 612.into(), 792.into()]));
        ops.push(Operation::new("f", vec![]));
        ops.extend(text_op(
            "F2",
            16.0,
            72.0,
            720.0,
            "3. Colored Vector Diagrams & Performance Graphs",
            [0.08, 0.08, 0.08],
        ));
        // Colored bars (Blue, Red, Emerald, Amber)
        let colors = [
            ([0.10f32, 0.45, 0.90], 100.0f32, 160.0f32),
            ([0.88, 0.20, 0.25], 180.0, 220.0),
            ([0.12, 0.72, 0.42], 260.0, 190.0),
            ([0.92, 0.58, 0.10], 340.0, 250.0),
        ];
        for (rgb, x, bh) in colors {
            ops.push(Operation::new("rg", vec![rgb[0].into(), rgb[1].into(), rgb[2].into()]));
            ops.push(Operation::new("re", vec![x.into(), 400.into(), 50.into(), bh.into()]));
            ops.push(Operation::new("f", vec![]));
        }
        let bytes = build_pdf_with_pages(vec![(612.0, 792.0, 0, ops, None)], false, false);
        let p = output_dir.join("03_colored_diagrams.pdf");
        fs::write(&p, bytes).map_err(|e| e.to_string())?;
        created.push(p);
    }

    // 4. 04_photographs.pdf
    {
        let img_w = 64u32;
        let img_h = 64u32;
        let mut rgb = Vec::with_capacity((img_w * img_h * 3) as usize);
        for y in 0..img_h {
            for x in 0..img_w {
                rgb.push(((x * 3 + y) % 180 + 30) as u8);
                rgb.push(((y * 4) % 170 + 40) as u8);
                rgb.push(((x * 2 + y * 2) % 160 + 50) as u8);
            }
        }
        let mut ops = Vec::new();
        ops.push(Operation::new("rg", vec![1.0.into(), 1.0.into(), 1.0.into()]));
        ops.push(Operation::new("re", vec![0.into(), 0.into(), 612.into(), 792.into()]));
        ops.push(Operation::new("f", vec![]));
        ops.extend(text_op(
            "F2",
            16.0,
            72.0,
            720.0,
            "4. Embedded Photograph Preservation Test",
            [0.05, 0.05, 0.05],
        ));
        ops.push(Operation::new("q", vec![]));
        ops.push(Operation::new(
            "cm",
            vec![240.into(), 0.into(), 0.into(), 240.into(), 72.into(), 420.into()],
        ));
        ops.push(Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]));
        ops.push(Operation::new("Q", vec![]));
        let bytes = build_pdf_with_pages(
            vec![(612.0, 792.0, 0, ops, Some((img_w, img_h, rgb)))],
            false,
            false,
        );
        let p = output_dir.join("04_photographs.pdf");
        fs::write(&p, bytes).map_err(|e| e.to_string())?;
        created.push(p);
    }

    // 5. 05_scanned_bw.pdf (Full-page simulated scanned B&W image, NO text layer)
    {
        let img_w = 96u32;
        let img_h = 120u32;
        let mut rgb = Vec::with_capacity((img_w * img_h * 3) as usize);
        for y in 0..img_h {
            for x in 0..img_w {
                let is_text_band = (y >= 20 && y <= 95) && (y % 9 <= 2) && (x >= 12 && x <= 84);
                let v = if is_text_band { 22u8 } else { 242u8 };
                rgb.extend_from_slice(&[v, v.saturating_sub(2), v.saturating_sub(4)]);
            }
        }
        let ops = vec![
            Operation::new("q", vec![]),
            Operation::new(
                "cm",
                vec![612.into(), 0.into(), 0.into(), 792.into(), 0.into(), 0.into()],
            ),
            Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]),
            Operation::new("Q", vec![]),
        ];
        let bytes = build_pdf_with_pages(
            vec![(612.0, 792.0, 0, ops, Some((img_w, img_h, rgb)))],
            false,
            false,
        );
        let p = output_dir.join("05_scanned_bw.pdf");
        fs::write(&p, bytes).map_err(|e| e.to_string())?;
        created.push(p);
    }

    // 6. 06_scanned_color.pdf (Full-page simulated scanned color document)
    {
        let img_w = 96u32;
        let img_h = 120u32;
        let mut rgb = Vec::with_capacity((img_w * img_h * 3) as usize);
        for y in 0..img_h {
            for x in 0..img_w {
                if y >= 50 && y <= 85 && x >= 20 && x <= 76 {
                    // Colored diagram region inside scan
                    rgb.extend_from_slice(&[20, 110, 225]);
                } else if (y >= 15 && y <= 40) && (y % 8 <= 2) && (x >= 12 && x <= 84) {
                    rgb.extend_from_slice(&[25, 25, 28]);
                } else {
                    rgb.extend_from_slice(&[244, 242, 238]);
                }
            }
        }
        let ops = vec![
            Operation::new("q", vec![]),
            Operation::new(
                "cm",
                vec![612.into(), 0.into(), 0.into(), 792.into(), 0.into(), 0.into()],
            ),
            Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]),
            Operation::new("Q", vec![]),
        ];
        let bytes = build_pdf_with_pages(
            vec![(612.0, 792.0, 0, ops, Some((img_w, img_h, rgb)))],
            false,
            false,
        );
        let p = output_dir.join("06_scanned_color.pdf");
        fs::write(&p, bytes).map_err(|e| e.to_string())?;
        created.push(p);
    }

    // 7. 07_links_and_outline.pdf
    {
        let mut ops1 = Vec::new();
        ops1.extend(text_op(
            "F2",
            16.0,
            72.0,
            720.0,
            "7. Interactive Links & Document Outline (TOC)",
            [0.05, 0.05, 0.05],
        ));
        ops1.extend(text_op(
            "F1",
            12.0,
            72.0,
            590.0,
            "[Internal Link] Click here to jump to Page 2: Deep Reference Section",
            [0.08, 0.38, 0.85],
        ));
        ops1.extend(text_op(
            "F1",
            12.0,
            72.0,
            545.0,
            "[External Link] https://www.w3.org/TR/PDF20/ (W3C PDF Specification)",
            [0.08, 0.38, 0.85],
        ));

        let mut ops2 = Vec::new();
        ops2.extend(text_op(
            "F2",
            16.0,
            72.0,
            720.0,
            "Page 2: Deep Reference Section (Target of Internal Link)",
            [0.05, 0.05, 0.05],
        ));
        let bytes = build_pdf_with_pages(
            vec![(612.0, 792.0, 0, ops1, None), (612.0, 792.0, 0, ops2, None)],
            true,
            true,
        );
        let p = output_dir.join("07_links_and_outline.pdf");
        fs::write(&p, bytes).map_err(|e| e.to_string())?;
        created.push(p);
    }

    // 8. 08_existing_annotations.pdf
    {
        let mut ops = Vec::new();
        ops.extend(text_op(
            "F2",
            16.0,
            72.0,
            720.0,
            "8. Document With Pre-Existing Callouts & Highlights",
            [0.05, 0.05, 0.05],
        ));
        // Yellow highlight box behind text
        ops.push(Operation::new("rg", vec![1.0.into(), 0.95.into(), 0.45.into()]));
        ops.push(Operation::new("re", vec![70.into(), 655.into(), 420.into(), 22.into()]));
        ops.push(Operation::new("f", vec![]));
        ops.extend(text_op(
            "F1",
            12.0,
            72.0,
            662.0,
            "Highlighted Theorem: Every bounded monotonic sequence converges.",
            [0.05, 0.05, 0.05],
        ));
        let bytes = build_pdf_with_pages(vec![(612.0, 792.0, 0, ops, None)], false, false);
        let p = output_dir.join("08_existing_annotations.pdf");
        fs::write(&p, bytes).map_err(|e| e.to_string())?;
        created.push(p);
    }

    // 9. 09_long_document_300_pages.pdf
    {
        let mut pages_spec = Vec::with_capacity(300);
        for page_idx in 1..=300 {
            let mut ops = Vec::new();
            ops.extend(text_op(
                "F2",
                15.0,
                72.0,
                720.0,
                &format!("Chapter {} — Comprehensive Systems Textbook (Page {} of 300)", (page_idx - 1) / 15 + 1, page_idx),
                [0.06, 0.06, 0.06],
            ));
            ops.extend(text_op(
                "F1",
                11.0,
                72.0,
                680.0,
                &format!("Section {}.1: Virtualized page rendering verification on page {}.", page_idx, page_idx),
                [0.12, 0.12, 0.12],
            ));
            pages_spec.push((612.0, 792.0, 0, ops, None));
        }
        let bytes = build_pdf_with_pages(pages_spec, true, false);
        let p = output_dir.join("09_long_document_300_pages.pdf");
        fs::write(&p, bytes).map_err(|e| e.to_string())?;
        created.push(p);
    }

    // 10. 10_mixed_dimensions_rotation.pdf
    {
        let ops1 = text_op("F2", 16.0, 72.0, 720.0, "Page 1: Standard Portrait (612 x 792 pt)", [0.05, 0.05, 0.05]);
        let ops2 = text_op("F2", 16.0, 72.0, 500.0, "Page 2: Wide Landscape Sheet (842 x 595 pt)", [0.05, 0.05, 0.05]);
        let ops3 = text_op("F2", 16.0, 72.0, 720.0, "Page 3: Rotated 90 Degrees (/Rotate 90)", [0.05, 0.05, 0.05]);
        let bytes = build_pdf_with_pages(
            vec![
                (612.0, 792.0, 0, ops1, None),
                (842.0, 595.0, 0, ops2, None),
                (612.0, 792.0, 90, ops3, None),
            ],
            false,
            false,
        );
        let p = output_dir.join("10_mixed_dimensions_rotation.pdf");
        fs::write(&p, bytes).map_err(|e| e.to_string())?;
        created.push(p);
    }

    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_engine::inspect_pdf_file;
    use tempfile::tempdir;

    #[test]
    fn test_generate_and_inspect_all_10_synthetic_pdfs() {
        let dir = tempdir().expect("tempdir");
        let files = generate_all_test_pdfs(dir.path()).expect("generate 10 PDFs");
        assert_eq!(files.len(), 10);

        for file_path in &files {
            let (meta, _) = inspect_pdf_file(file_path).expect("valid generated PDF");
            assert!(meta.page_count >= 1);
            if file_path.file_name().unwrap().to_string_lossy().contains("300_pages") {
                assert_eq!(meta.page_count, 300);
            }
        }
    }
}
