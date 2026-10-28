//! Persistent Sidecar Storage, Document Identity, Atomic Persistence & Recovery.
//!
//! Ensures the original PDF is never modified while providing rock-solid persistence for
//! annotations, bookmarks, reading position, and per-document display preferences.

use crate::annotations::DocumentAnnotations;
use crate::dark_mode::DarkModeConfig;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const CURRENT_SIDECAR_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BookmarkEntry {
    pub id: String,
    pub page_number: u32,
    pub title: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PageLayoutMode {
    Continuous,
    SinglePage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocumentReadingState {
    pub current_page: u32,
    pub scroll_top_ratio: f32,
    pub zoom_scale: f32,
    pub fit_mode: String, // "width" | "page" | "custom"
    pub layout_mode: PageLayoutMode,
    pub dark_mode_override: Option<DarkModeConfig>,
}

impl Default for DocumentReadingState {
    fn default() -> Self {
        Self {
            current_page: 1,
            scroll_top_ratio: 0.0,
            zoom_scale: 1.15,
            fit_mode: "width".to_string(),
            layout_mode: PageLayoutMode::Continuous,
            dark_mode_override: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocumentIdentity {
    /// Hex-encoded SHA-256 digest of the PDF file contents.
    pub content_sha256: String,
    pub file_size_bytes: u64,
    pub page_count: u32,
    pub last_known_path: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocumentSidecar {
    pub schema_version: u32,
    pub identity: DocumentIdentity,
    pub reading_state: DocumentReadingState,
    pub bookmarks: Vec<BookmarkEntry>,
    pub annotations: DocumentAnnotations,
    pub write_adjacent_sidecar: bool,
    pub updated_at: String,
}

impl DocumentSidecar {
    pub fn new(identity: DocumentIdentity) -> Self {
        Self {
            schema_version: CURRENT_SIDECAR_SCHEMA_VERSION,
            identity,
            reading_state: DocumentReadingState::default(),
            bookmarks: Vec::new(),
            annotations: DocumentAnnotations::default(),
            write_adjacent_sidecar: false,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarLoadOutcome {
    pub sidecar: DocumentSidecar,
    pub recovered_from_backup: bool,
    pub matched_moved_file_from: Option<String>,
    pub external_modification_warning: Option<String>,
    pub previous_modified_hash: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PathHashIndex {
    /// Maps normalized file path -> last recorded content SHA-256 and annotation count
    pub entries: BTreeMap<String, PathIndexRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PathIndexRecord {
    pub content_sha256: String,
    pub file_size_bytes: u64,
    pub has_user_data: bool,
    pub updated_at: String,
}

/// Computes the SHA-256 digest and file size of a PDF file without modifying it.
pub fn compute_file_sha256(path: &Path) -> Result<(String, u64), String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open PDF {:?}: {}", path, e))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Failed to read metadata for {:?}: {}", path, e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Error hashing {:?}: {}", path, e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let hash_hex = hex::encode(hasher.finalize());
    Ok((hash_hex, meta.len()))
}

/// Computes SHA-256 digest directly from in-memory bytes.
pub fn compute_bytes_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Writes `bytes` atomically to `target_path` by writing to `.tmp`, syncing to disk,
/// backing up any existing valid target to `.bak`, and renaming `.tmp` -> `target_path`.
pub fn atomic_write_with_backup(target_path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {:?}: {}", parent, e))?;
    }

    let tmp_path = target_path.with_extension("json.tmp");
    let bak_path = target_path.with_extension("json.bak");

    {
        let mut tmp_file = File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temp file {:?}: {}", tmp_path, e))?;
        tmp_file
            .write_all(bytes)
            .map_err(|e| format!("Failed to write temp file {:?}: {}", tmp_path, e))?;
        tmp_file
            .sync_all()
            .map_err(|e| format!("Failed to flush temp file {:?}: {}", tmp_path, e))?;
    }

    // If current target exists and is non-empty valid JSON, copy to .bak before replacing
    if target_path.exists() {
        if let Ok(existing) = fs::read(target_path) {
            if !existing.is_empty() && serde_json::from_slice::<serde_json::Value>(&existing).is_ok()
            {
                let _ = fs::copy(target_path, &bak_path);
            }
        }
    }

    fs::rename(&tmp_path, target_path)
        .map_err(|e| format!("Failed to replace {:?} from temp file: {}", target_path, e))?;

    Ok(())
}

pub struct SidecarStorageManager {
    base_dir: PathBuf,
}

impl SidecarStorageManager {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let base_dir = app_data_dir.join("sidecars");
        let _ = fs::create_dir_all(&base_dir);
        Self { base_dir }
    }

    pub fn sidecar_path_for_hash(&self, content_sha256: &str) -> PathBuf {
        self.base_dir.join(format!("{}.json", content_sha256))
    }

    pub fn adjacent_sidecar_path(pdf_path: &Path) -> PathBuf {
        let mut p = pdf_path.as_os_str().to_os_string();
        p.push(".luminapdf.json");
        PathBuf::from(p)
    }

    fn index_path(&self) -> PathBuf {
        self.base_dir.join("path_index.json")
    }

    fn load_path_index(&self) -> PathHashIndex {
        let path = self.index_path();
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(idx) = serde_json::from_slice::<PathHashIndex>(&bytes) {
                return idx;
            }
        }
        PathHashIndex::default()
    }

    fn save_path_index(&self, index: &PathHashIndex) {
        if let Ok(bytes) = serde_json::to_vec_pretty(index) {
            let _ = atomic_write_with_backup(&self.index_path(), &bytes);
        }
    }

    fn normalize_path_key(path: &Path) -> String {
        path.to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches(r"\\?\")
            .to_lowercase()
    }

    /// Loads an existing sidecar (with automatic `.bak` recovery if corrupted) or creates a new one.
    /// Also checks whether a moved/renamed file matched by SHA-256, or whether an existing file
    /// at the same path was externally modified.
    pub fn load_or_create_sidecar(
        &self,
        pdf_path: &Path,
        content_sha256: &str,
        file_size_bytes: u64,
        page_count: u32,
    ) -> SidecarLoadOutcome {
        let norm_key = Self::normalize_path_key(pdf_path);
        let file_name = pdf_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "document.pdf".to_string());

        let identity = DocumentIdentity {
            content_sha256: content_sha256.to_string(),
            file_size_bytes,
            page_count,
            last_known_path: pdf_path.to_string_lossy().to_string(),
            file_name,
        };

        let mut external_modification_warning = None;
        let mut previous_modified_hash = None;
        let index = self.load_path_index();

        // Check if this exact file path previously had a DIFFERENT content hash with user annotations
        if let Some(prev_record) = index.entries.get(&norm_key) {
            if prev_record.content_sha256 != content_sha256 && prev_record.has_user_data {
                external_modification_warning = Some(
                    "This PDF file was modified externally since it was last annotated. Existing annotations from the previous file version can be imported, though positions may vary if pages were added or removed."
                        .to_string(),
                );
                previous_modified_hash = Some(prev_record.content_sha256.clone());
            }
        }

        let target_path = self.sidecar_path_for_hash(content_sha256);
        let bak_path = target_path.with_extension("json.bak");
        let adj_path = Self::adjacent_sidecar_path(pdf_path);

        let mut recovered_from_backup = false;
        let mut loaded_sidecar: Option<DocumentSidecar> = None;

        // 1. Try primary app-managed sidecar
        if target_path.exists() {
            match fs::read(&target_path)
                .ok()
                .and_then(|b| serde_json::from_slice::<DocumentSidecar>(&b).ok())
            {
                Some(sc) if sc.identity.content_sha256 == content_sha256 => {
                    loaded_sidecar = Some(sc);
                }
                _ => {
                    // Primary sidecar was corrupted! Attempt recovery from .bak
                    if bak_path.exists() {
                        if let Some(sc) = fs::read(&bak_path)
                            .ok()
                            .and_then(|b| serde_json::from_slice::<DocumentSidecar>(&b).ok())
                        {
                            if sc.identity.content_sha256 == content_sha256 {
                                recovered_from_backup = true;
                                // Restore primary file from backup
                                if let Ok(bytes) = serde_json::to_vec_pretty(&sc) {
                                    let _ = atomic_write_with_backup(&target_path, &bytes);
                                }
                                loaded_sidecar = Some(sc);
                            }
                        }
                    }
                }
            }
        }

        // 2. Try adjacent sidecar if app-managed wasn't found and adjacent matches SHA-256
        if loaded_sidecar.is_none() && adj_path.exists() {
            if let Some(sc) = fs::read(&adj_path)
                .ok()
                .and_then(|b| serde_json::from_slice::<DocumentSidecar>(&b).ok())
            {
                if sc.identity.content_sha256 == content_sha256 {
                    loaded_sidecar = Some(sc);
                }
            }
        }

        let mut matched_moved_file_from = None;
        let mut sidecar = match loaded_sidecar {
            Some(mut sc) => {
                let prev_norm = Self::normalize_path_key(Path::new(&sc.identity.last_known_path));
                if !sc.identity.last_known_path.is_empty() && prev_norm != norm_key {
                    matched_moved_file_from = Some(sc.identity.last_known_path.clone());
                }
                sc.identity.last_known_path = identity.last_known_path.clone();
                sc.identity.file_name = identity.file_name.clone();
                sc.identity.page_count = page_count;
                sc.schema_version = CURRENT_SIDECAR_SCHEMA_VERSION;
                sc
            }
            None => DocumentSidecar::new(identity),
        };

        // Ensure schema migration safety
        if sidecar.schema_version < CURRENT_SIDECAR_SCHEMA_VERSION {
            sidecar.schema_version = CURRENT_SIDECAR_SCHEMA_VERSION;
        }

        SidecarLoadOutcome {
            sidecar,
            recovered_from_backup,
            matched_moved_file_from,
            external_modification_warning,
            previous_modified_hash,
        }
    }

    /// Saves a `DocumentSidecar` atomically to app-managed storage (and optionally adjacent to the PDF).
    pub fn save_sidecar(&self, sidecar: &mut DocumentSidecar) -> Result<(), String> {
        sidecar.updated_at = chrono::Utc::now().to_rfc3339();
        sidecar.schema_version = CURRENT_SIDECAR_SCHEMA_VERSION;

        let json_bytes = serde_json::to_vec_pretty(sidecar)
            .map_err(|e| format!("Failed to serialize sidecar: {}", e))?;

        let target_path = self.sidecar_path_for_hash(&sidecar.identity.content_sha256);
        atomic_write_with_backup(&target_path, &json_bytes)?;

        // Update path-to-hash index for external-change detection
        let mut index = self.load_path_index();
        let norm_key = Self::normalize_path_key(Path::new(&sidecar.identity.last_known_path));
        let has_user_data =
            sidecar.annotations.total_count() > 0 || !sidecar.bookmarks.is_empty();
        index.entries.insert(
            norm_key,
            PathIndexRecord {
                content_sha256: sidecar.identity.content_sha256.clone(),
                file_size_bytes: sidecar.identity.file_size_bytes,
                has_user_data,
                updated_at: sidecar.updated_at.clone(),
            },
        );
        self.save_path_index(&index);

        // If user explicitly enabled adjacent sidecar, try writing it without failing if read-only
        if sidecar.write_adjacent_sidecar && !sidecar.identity.last_known_path.is_empty() {
            let adj_path = Self::adjacent_sidecar_path(Path::new(&sidecar.identity.last_known_path));
            let _ = atomic_write_with_backup(&adj_path, &json_bytes);
        }

        Ok(())
    }

    /// Migrates annotations and bookmarks from a previous content hash (e.g., when a PDF was
    /// modified externally and the user confirms importing their previous annotations).
    pub fn migrate_from_previous_hash(
        &self,
        current_sidecar: &mut DocumentSidecar,
        previous_sha256: &str,
    ) -> Result<usize, String> {
        let prev_path = self.sidecar_path_for_hash(previous_sha256);
        let bytes = fs::read(&prev_path)
            .map_err(|e| format!("Could not read previous sidecar: {}", e))?;
        let prev_sc: DocumentSidecar = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid previous sidecar data: {}", e))?;

        let mut imported = 0usize;
        for (page, items) in prev_sc.annotations.pages {
            if page <= current_sidecar.identity.page_count {
                for item in items {
                    current_sidecar.annotations.add(item);
                    imported += 1;
                }
            }
        }
        for bm in prev_sc.bookmarks {
            if bm.page_number <= current_sidecar.identity.page_count
                && !current_sidecar
                    .bookmarks
                    .iter()
                    .any(|b| b.page_number == bm.page_number)
            {
                current_sidecar.bookmarks.push(bm);
            }
        }
        self.save_sidecar(current_sidecar)?;
        Ok(imported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::annotations::{AnnotationItem, StrokePoint};
    use tempfile::tempdir;

    #[test]
    fn test_moved_file_retains_annotations_and_unrelated_same_name_does_not_collide() {
        let dir = tempdir().expect("tempdir");
        let manager = SidecarStorageManager::new(dir.path().to_path_buf());

        let pdf_a_bytes = b"%PDF-1.7 Content A Lecture Notes";
        let hash_a = compute_bytes_sha256(pdf_a_bytes);
        let path_a1 = dir.path().join("lecture.pdf");

        let mut outcome1 =
            manager.load_or_create_sidecar(&path_a1, &hash_a, pdf_a_bytes.len() as u64, 10);
        outcome1.sidecar.annotations.add(AnnotationItem::PenStroke {
            id: "s1".to_string(),
            page_number: 2,
            color: "#ff0000".to_string(),
            stroke_width: 2.0,
            points: vec![StrokePoint {
                x: 10.0,
                y: 20.0,
                pressure: 0.5,
            }],
            created_at: "2026-10-27T00:00:00Z".to_string(),
        });
        manager.save_sidecar(&mut outcome1.sidecar).expect("save");

        // 1. Move/rename lecture.pdf -> renamed_lecture.pdf (same content hash)
        let path_a2 = dir.path().join("renamed_lecture.pdf");
        let outcome_moved =
            manager.load_or_create_sidecar(&path_a2, &hash_a, pdf_a_bytes.len() as u64, 10);
        assert_eq!(outcome_moved.sidecar.annotations.total_count(), 1);
        assert!(outcome_moved.matched_moved_file_from.is_some());

        // 2. Unrelated PDF with the original filename `lecture.pdf` (different content hash)
        let pdf_b_bytes = b"%PDF-1.7 Completely Different Textbook B";
        let hash_b = compute_bytes_sha256(pdf_b_bytes);
        let outcome_unrelated =
            manager.load_or_create_sidecar(&path_a1, &hash_b, pdf_b_bytes.len() as u64, 25);
        // Must NOT inherit PDF A's annotations automatically!
        assert_eq!(outcome_unrelated.sidecar.annotations.total_count(), 0);
        // Should warn that the file at `lecture.pdf` changed content relative to previous annotated version
        assert!(outcome_unrelated.external_modification_warning.is_some());
    }

    #[test]
    fn test_atomic_persistence_and_corrupted_sidecar_backup_recovery() {
        let dir = tempdir().expect("tempdir");
        let manager = SidecarStorageManager::new(dir.path().to_path_buf());
        let hash = compute_bytes_sha256(b"test-recovery-doc");
        let pdf_path = dir.path().join("recovery.pdf");

        // Save first valid state (creates .json)
        let mut outcome = manager.load_or_create_sidecar(&pdf_path, &hash, 100, 5);
        outcome.sidecar.bookmarks.push(BookmarkEntry {
            id: "bm-1".to_string(),
            page_number: 3,
            title: "Important Theorem".to_string(),
            created_at: "2026-10-27T00:00:00Z".to_string(),
        });
        manager.save_sidecar(&mut outcome.sidecar).expect("save 1");

        // Save second valid state (copies first to .bak and updates .json)
        outcome.sidecar.reading_state.current_page = 4;
        manager.save_sidecar(&mut outcome.sidecar).expect("save 2");

        // Simulate crash corruption of primary .json file
        let primary_path = manager.sidecar_path_for_hash(&hash);
        fs::write(&primary_path, b"{ corrupted json truncated...").expect("corrupt write");

        // Reload -> must automatically recover from .bak without crashing!
        let recovered = manager.load_or_create_sidecar(&pdf_path, &hash, 100, 5);
        assert!(recovered.recovered_from_backup);
        assert_eq!(recovered.sidecar.bookmarks.len(), 1);
        assert_eq!(recovered.sidecar.bookmarks[0].title, "Important Theorem");
    }
}
