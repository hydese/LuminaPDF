pub mod annotations;
pub mod dark_mode;
pub mod pdf_engine;
pub mod platform;
pub mod search;
pub mod session;
pub mod storage;
pub mod test_pdf_gen;
pub mod updater;

use annotations::DocumentAnnotations;
use base64::Engine as _;
use dark_mode::{process_image_buffer_dark_mode, DarkModeConfig, ImageClassificationReport};
use pdf_engine::{export_annotated_pdf, inspect_pdf_file, PdfDocumentMetadata};
use platform::{current_platform, PlatformCapabilities};
use search::{DocumentTextIndex, SearchQueryResult};
use serde::{Deserialize, Serialize};
use session::{AppSettingsAndSession, RecentDocumentEntry, SessionManager};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use storage::{DocumentSidecar, SidecarLoadOutcome, SidecarStorageManager};
use updater::{evaluate_update_manifest, UpdateCheckResponse, APP_VERSION};

pub struct AppState {
    pub app_data_dir: PathBuf,
    pub storage_mgr: SidecarStorageManager,
    pub session_mgr: SessionManager,
    pub settings: Mutex<AppSettingsAndSession>,
    pub startup_pdf_args: Vec<String>,
}

impl AppState {
    pub fn new(app_data_dir: PathBuf, startup_pdf_args: Vec<String>) -> Self {
        let storage_mgr = SidecarStorageManager::new(app_data_dir.clone());
        let session_mgr = SessionManager::new(&app_data_dir);
        let settings = session_mgr.load();
        Self {
            app_data_dir,
            storage_mgr,
            session_mgr,
            settings: Mutex::new(settings),
            startup_pdf_args,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapPayload {
    pub app_version: String,
    pub platform: PlatformCapabilities,
    pub settings: AppSettingsAndSession,
    pub startup_pdf_paths: Vec<String>,
    pub sample_pdf_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenedPdfPayload {
    pub metadata: PdfDocumentMetadata,
    pub pdf_base64: String,
    pub sidecar_outcome: SidecarLoadOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessedImagePayload {
    pub rgba_base64: String,
    pub report: ImageClassificationReport,
}

#[tauri::command]
fn get_app_bootstrap_state(state: tauri::State<'_, AppState>) -> Result<BootstrapPayload, String> {
    let plat = current_platform();
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Failed to lock settings state".to_string())?
        .clone();

    // Ensure sample test PDFs exist in app_data_dir/sample-pdfs
    let sample_dir = state.app_data_dir.join("sample-pdfs");
    let sample_paths = test_pdf_gen::generate_all_test_pdfs(&sample_dir)
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    Ok(BootstrapPayload {
        app_version: APP_VERSION.to_string(),
        platform: plat.capabilities(),
        settings,
        startup_pdf_paths: state.startup_pdf_args.clone(),
        sample_pdf_paths: sample_paths,
    })
}

#[tauri::command]
fn open_pdf_document(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<OpenedPdfPayload, String> {
    let pdf_path = Path::new(&path);
    let (metadata, raw_bytes) = inspect_pdf_file(pdf_path).map_err(|e| e.message)?;

    let sidecar_outcome = state.storage_mgr.load_or_create_sidecar(
        pdf_path,
        &metadata.content_sha256,
        metadata.file_size_bytes,
        metadata.page_count,
    );

    // Record in recent documents list
    if let Ok(mut settings) = state.settings.lock() {
        settings.record_recent_document(RecentDocumentEntry {
            path: metadata.path.clone(),
            file_name: metadata.file_name.clone(),
            content_sha256: metadata.content_sha256.clone(),
            last_page: sidecar_outcome.sidecar.reading_state.current_page,
            total_pages: metadata.page_count,
            last_opened_at: chrono::Utc::now().to_rfc3339(),
        });
        let _ = state.session_mgr.save(&mut settings);
    }

    let pdf_base64 = base64::engine::general_purpose::STANDARD.encode(&raw_bytes);

    Ok(OpenedPdfPayload {
        metadata,
        pdf_base64,
        sidecar_outcome,
    })
}

#[tauri::command]
fn save_document_sidecar(
    mut sidecar: DocumentSidecar,
    state: tauri::State<'_, AppState>,
) -> Result<DocumentSidecar, String> {
    state.storage_mgr.save_sidecar(&mut sidecar)?;

    if let Ok(mut settings) = state.settings.lock() {
        let norm_target = sidecar
            .identity
            .last_known_path
            .replace('/', "\\")
            .to_lowercase();
        for rec in &mut settings.recent_documents {
            if rec.path.replace('/', "\\").to_lowercase() == norm_target {
                rec.last_page = sidecar.reading_state.current_page;
            }
        }
        let _ = state.session_mgr.save(&mut settings);
    }

    Ok(sidecar)
}

#[tauri::command]
fn migrate_previous_annotations(
    mut current_sidecar: DocumentSidecar,
    previous_sha256: String,
    state: tauri::State<'_, AppState>,
) -> Result<DocumentSidecar, String> {
    state
        .storage_mgr
        .migrate_from_previous_hash(&mut current_sidecar, &previous_sha256)?;
    Ok(current_sidecar)
}

#[tauri::command]
fn save_app_settings(
    mut settings: AppSettingsAndSession,
    state: tauri::State<'_, AppState>,
) -> Result<AppSettingsAndSession, String> {
    state.session_mgr.save(&mut settings)?;
    if let Ok(mut guard) = state.settings.lock() {
        *guard = settings.clone();
    }
    Ok(settings)
}

#[tauri::command]
fn export_annotated_pdf_cmd(
    source_path: String,
    output_path: String,
    annotations: DocumentAnnotations,
    allow_overwrite: bool,
) -> Result<String, String> {
    export_annotated_pdf(
        Path::new(&source_path),
        Path::new(&output_path),
        &annotations,
        allow_overwrite,
    )
    .map_err(|e| e.message)
}

#[tauri::command]
fn classify_and_transform_image_cmd(
    rgba_base64: String,
    width: u32,
    height: u32,
    config: DarkModeConfig,
) -> Result<ProcessedImagePayload, String> {
    let mut rgba = base64::engine::general_purpose::STANDARD
        .decode(&rgba_base64)
        .map_err(|e| format!("Invalid image base64 payload: {}", e))?;
    let report = process_image_buffer_dark_mode(&mut rgba, width, height, &config);
    let out_b64 = base64::engine::general_purpose::STANDARD.encode(&rgba);
    Ok(ProcessedImagePayload {
        rgba_base64: out_b64,
        report,
    })
}

#[tauri::command]
fn search_document_text_cmd(
    pages: BTreeMap<u32, String>,
    query: String,
    case_sensitive: bool,
) -> Result<SearchQueryResult, String> {
    let index = DocumentTextIndex::from_pages(pages);
    Ok(index.search(&query, case_sensitive))
}

#[tauri::command]
fn check_for_updates_cmd(
    manifest_json_override: Option<String>,
) -> Result<UpdateCheckResponse, String> {
    // If an explicit manifest payload is provided (e.g. from local release channel or test), evaluate it;
    // otherwise evaluate the default release channel state.
    if let Some(json_str) = manifest_json_override {
        return evaluate_update_manifest(APP_VERSION, &json_str);
    }

    let baseline_manifest = format!(
        r#"{{
            "version": "{}",
            "pub_date": "2026-10-27T18:45:00Z",
            "notes": "LuminaPDF v{} by hydese — Windows 10 & Windows 11 release on GitHub (github.com/hydese/LuminaPDF).",
            "windows_x86_64": {{
                "url": "https://github.com/hydese/LuminaPDF/releases/download/v{}/LuminaPDF_{}_x64-setup.exe",
                "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                "signature": null,
                "installer_type": "nsis"
            }}
        }}"#,
        APP_VERSION, APP_VERSION, APP_VERSION, APP_VERSION
    );

    evaluate_update_manifest(APP_VERSION, &baseline_manifest)
}

#[tauri::command]
fn generate_sample_pdfs_cmd(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let sample_dir = state.app_data_dir.join("sample-pdfs");
    let paths = test_pdf_gen::generate_all_test_pdfs(&sample_dir)?;
    Ok(paths
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
fn toggle_fullscreen_cmd(window: tauri::Window) -> Result<bool, String> {
    let cur = window
        .is_fullscreen()
        .map_err(|e| format!("Failed to query fullscreen state: {}", e))?;
    let next = !cur;
    window
        .set_fullscreen(next)
        .map_err(|e| format!("Failed to set fullscreen state: {}", e))?;
    Ok(next)
}

#[tauri::command]
fn set_fullscreen_cmd(window: tauri::Window, fullscreen: bool) -> Result<bool, String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|e| format!("Failed to set fullscreen state: {}", e))?;
    Ok(fullscreen)
}

#[tauri::command]
fn save_png_snip_cmd(output_path: String, png_base64: String) -> Result<String, String> {
    let clean_b64 = png_base64
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(&png_base64);
    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(clean_b64)
        .map_err(|e| format!("Invalid PNG payload: {}", e))?;
    let dest = Path::new(&output_path);
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(dest, &png_bytes)
        .map_err(|e| format!("Failed to write PNG to '{}': {}", output_path, e))?;
    Ok(output_path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let plat = current_platform();
    let app_data_dir = plat.resolve_app_data_dir();

    // Collect any `.pdf` file paths passed as command-line arguments (e.g. from File Explorer)
    let startup_pdf_args: Vec<String> = std::env::args()
        .skip(1)
        .filter(|arg| {
            !arg.starts_with('-') && arg.to_lowercase().ends_with(".pdf") && Path::new(arg).exists()
        })
        .collect();

    let app_state = AppState::new(app_data_dir, startup_pdf_args);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_app_bootstrap_state,
            open_pdf_document,
            save_document_sidecar,
            migrate_previous_annotations,
            save_app_settings,
            export_annotated_pdf_cmd,
            classify_and_transform_image_cmd,
            search_document_text_cmd,
            check_for_updates_cmd,
            generate_sample_pdfs_cmd,
            toggle_fullscreen_cmd,
            set_fullscreen_cmd,
            save_png_snip_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LuminaPDF Tauri application");
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::annotations::{AnnotationItem, MarkupKind, PdfRect, StrokePoint};
    use crate::storage::{compute_file_sha256, BookmarkEntry, PageLayoutMode};
    use tempfile::tempdir;

    #[test]
    fn test_full_workflow_open_annotate_persist_restart_export_without_modifying_original() {
        let dir = tempdir().expect("tempdir");
        let app_data = dir.path().join("appdata");
        let pdfs_dir = dir.path().join("pdfs");

        let generated = test_pdf_gen::generate_all_test_pdfs(&pdfs_dir).expect("generate PDFs");
        let academic_pdf = &generated[0];

        // Record original SHA-256 before any operations
        let (orig_sha256, orig_size) = compute_file_sha256(academic_pdf).expect("hash original");

        // Phase 1: Open document, switch layout, dark mode, zoom, add annotations & bookmark
        {
            let state = AppState::new(app_data.clone(), vec![]);
            let (meta, _) = inspect_pdf_file(academic_pdf).expect("inspect");
            assert_eq!(meta.content_sha256, orig_sha256);

            let mut outcome = state.storage_mgr.load_or_create_sidecar(
                academic_pdf,
                &meta.content_sha256,
                meta.file_size_bytes,
                meta.page_count,
            );

            outcome.sidecar.reading_state.current_page = 1;
            outcome.sidecar.reading_state.zoom_scale = 1.5;
            outcome.sidecar.reading_state.layout_mode = PageLayoutMode::SinglePage;

            outcome.sidecar.bookmarks.push(BookmarkEntry {
                id: "bm-1".to_string(),
                page_number: 1,
                title: "Laplacian Definition".to_string(),
                created_at: "2026-10-27T17:00:00Z".to_string(),
            });

            outcome.sidecar.annotations.add(AnnotationItem::PenStroke {
                id: "pen-1".to_string(),
                page_number: 1,
                color: "#38bdf8".to_string(),
                stroke_width: 2.5,
                points: vec![
                    StrokePoint {
                        x: 80.0,
                        y: 120.0,
                        pressure: 0.5,
                    },
                    StrokePoint {
                        x: 220.0,
                        y: 125.0,
                        pressure: 0.7,
                    },
                ],
                created_at: "2026-10-27T17:00:00Z".to_string(),
            });

            outcome.sidecar.annotations.add(AnnotationItem::TextNote {
                id: "note-1".to_string(),
                page_number: 1,
                x: 300.0,
                y: 200.0,
                color: "#fbbf24".to_string(),
                title: "Exam Question".to_string(),
                content: "Review normalized Laplacian eigenvalues.".to_string(),
                created_at: "2026-10-27T17:00:00Z".to_string(),
                updated_at: "2026-10-27T17:00:00Z".to_string(),
            });

            outcome.sidecar.annotations.add(AnnotationItem::TextMarkup {
                id: "hl-1".to_string(),
                page_number: 1,
                kind: MarkupKind::Highlight,
                color: "#facc15".to_string(),
                rects: vec![PdfRect {
                    x: 72.0,
                    y: 680.0,
                    width: 250.0,
                    height: 14.0,
                }],
                text_snippet: "normalized graph Laplacian".to_string(),
                created_at: "2026-10-27T17:00:00Z".to_string(),
            });

            state
                .storage_mgr
                .save_sidecar(&mut outcome.sidecar)
                .expect("save sidecar");
        }

        // Verify original PDF was NEVER modified!
        let (after_sha256, after_size) =
            compute_file_sha256(academic_pdf).expect("hash after annotate");
        assert_eq!(orig_sha256, after_sha256);
        assert_eq!(orig_size, after_size);

        // Phase 2: Simulate application restart & upgrade, verify state & annotations restored
        {
            let state_restarted = AppState::new(app_data.clone(), vec![]);
            let outcome = state_restarted.storage_mgr.load_or_create_sidecar(
                academic_pdf,
                &orig_sha256,
                orig_size,
                1,
            );
            assert_eq!(outcome.sidecar.reading_state.zoom_scale, 1.5);
            assert_eq!(
                outcome.sidecar.reading_state.layout_mode,
                PageLayoutMode::SinglePage
            );
            assert_eq!(outcome.sidecar.bookmarks.len(), 1);
            assert_eq!(outcome.sidecar.annotations.total_count(), 3);

            // Export annotated PDF to a new file
            let export_path = dir.path().join("exported_annotated.pdf");
            // Verify overwrite protection blocks overwriting original without confirmation
            assert!(export_annotated_pdf(
                academic_pdf,
                academic_pdf,
                &outcome.sidecar.annotations,
                false
            )
            .is_err());

            export_annotated_pdf(
                academic_pdf,
                &export_path,
                &outcome.sidecar.annotations,
                false,
            )
            .expect("export annotated PDF");

            let (exp_meta, _) = inspect_pdf_file(&export_path).expect("inspect exported PDF");
            assert_eq!(exp_meta.page_count, 1);

            // Verify original PDF is STILL untouched after export
            let (final_sha256, _) = compute_file_sha256(academic_pdf).expect("hash final");
            assert_eq!(orig_sha256, final_sha256);
        }
    }

    #[test]
    fn test_performance_benchmarks_and_workspace_sample_pdfs() {
        use std::time::Instant;

        let workspace_samples = Path::new("..").join("sample-pdfs");
        let t_gen = Instant::now();
        let files =
            test_pdf_gen::generate_all_test_pdfs(&workspace_samples).expect("generate workspace sample PDFs");
        let gen_ms = t_gen.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(files.len(), 10);

        // 1. Measure opening & structural inspection of 300-page textbook PDF
        let long_pdf = &files[8]; // 09_long_document_300_pages.pdf
        let t_open = Instant::now();
        let (meta, _) = inspect_pdf_file(long_pdf).expect("inspect 300-page PDF");
        let open_ms = t_open.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(meta.page_count, 300);

        // 2. Measure 1200x1600 scanned page classification & dark-mode transformation
        let width = 1200u32;
        let height = 1600u32;
        let mut rgba = vec![242u8; (width * height * 4) as usize];
        for i in (0..(width * height) as usize).step_by(11) {
            let base = i * 4;
            rgba[base] = 20;
            rgba[base + 1] = 20;
            rgba[base + 2] = 22;
        }
        let cfg = DarkModeConfig::default();
        let t_dm = Instant::now();
        let report = process_image_buffer_dark_mode(&mut rgba, width, height, &cfg);
        let dm_ms = t_dm.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(
            report.content_type,
            crate::dark_mode::ImageContentType::ScannedMonochrome
        );

        // 3. Measure full-text search across 300 pages
        let mut pages_text = BTreeMap::new();
        for p in 1..=300u32 {
            pages_text.insert(
                p,
                format!(
                    "Page {} spectral graph Laplacian eigenvalue theorem andvirtualized rendering.",
                    p
                ),
            );
        }
        let t_search = Instant::now();
        let idx = DocumentTextIndex::from_pages(pages_text);
        let search_res = idx.search("eigenvalue", false);
        let search_ms = t_search.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(search_res.total_matches, 300);

        println!(
            "BENCHMARK_RESULTS: gen_10_pdfs_ms={:.2}, open_300p_ms={:.2}, dark_mode_1200x1600_ms={:.2}, search_300p_ms={:.2}",
            gen_ms, open_ms, dm_ms, search_ms
        );
    }
}
