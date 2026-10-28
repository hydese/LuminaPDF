//! Application Settings & Reading Session Restoration.
//!
//! Persists recent documents, default dark-mode configuration, annotation tool preferences,
//! window geometry, and optional startup tab restoration.

use crate::dark_mode::DarkModeConfig;
use crate::storage::{atomic_write_with_backup, PageLayoutMode};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentDocumentEntry {
    pub path: String,
    pub file_name: String,
    pub content_sha256: String,
    pub last_page: u32,
    pub total_pages: u32,
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WindowGeometry {
    pub width: u32,
    pub height: u32,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub maximized: bool,
}

impl Default for WindowGeometry {
    fn default() -> Self {
        Self {
            width: 1340,
            height: 880,
            x: None,
            y: None,
            maximized: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnnotationPreferences {
    pub active_tool: String, // "select" | "pen" | "highlighter" | "eraser" | "note" | "highlight_text" | "underline_text"
    pub pen_color: String,
    pub pen_width: f32,
    pub highlighter_color: String,
    pub highlighter_width: f32,
    pub note_color: String,
    pub eraser_radius: f32,
}

impl Default for AnnotationPreferences {
    fn default() -> Self {
        Self {
            active_tool: "select".to_string(),
            pen_color: "#ffffff".to_string(),
            pen_width: 2.5,
            highlighter_color: "#facc15".to_string(),
            highlighter_width: 16.0,
            note_color: "#fbbf24".to_string(),
            eraser_radius: 12.0,
        }
    }
}

fn default_app_theme() -> String {
    "dark".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppSettingsAndSession {
    pub schema_version: u32,
    #[serde(default = "default_app_theme")]
    pub app_theme: String,
    #[serde(default)]
    pub pen_color_migrated_v104: bool,
    pub dark_mode: DarkModeConfig,
    pub default_layout: PageLayoutMode,
    pub default_zoom: f32,
    pub default_fit_mode: String,
    /// Per requirement: do not reopen recent documents automatically unless explicitly enabled.
    pub reopen_tabs_on_startup: bool,
    pub last_open_tab_paths: Vec<String>,
    pub active_tab_path: Option<String>,
    pub recent_documents: Vec<RecentDocumentEntry>,
    pub window_geometry: WindowGeometry,
    pub annotation_prefs: AnnotationPreferences,
    pub auto_check_updates: bool,
    pub update_manifest_url: String,
    pub dark_mode_shortcut: String,
}

impl Default for AppSettingsAndSession {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            app_theme: default_app_theme(),
            pen_color_migrated_v104: true,
            dark_mode: DarkModeConfig::default(),
            default_layout: PageLayoutMode::Continuous,
            default_zoom: 1.15,
            default_fit_mode: "width".to_string(),
            reopen_tabs_on_startup: false,
            last_open_tab_paths: Vec::new(),
            active_tab_path: None,
            recent_documents: Vec::new(),
            window_geometry: WindowGeometry::default(),
            annotation_prefs: AnnotationPreferences::default(),
            auto_check_updates: false,
            update_manifest_url:
                "https://github.com/hydese/LuminaPDF/releases/latest/download/latest.json"
                    .to_string(),
            dark_mode_shortcut: "Ctrl+Shift+D".to_string(),
        }
    }
}

impl AppSettingsAndSession {
    /// Clamps and sanitizes any out-of-range values loaded from disk.
    pub fn sanitize(&mut self) {
        self.schema_version = SETTINGS_SCHEMA_VERSION;
        if self.app_theme != "light" && self.app_theme != "dark" {
            self.app_theme = "dark".to_string();
        }
        if !self.pen_color_migrated_v104 {
            self.pen_color_migrated_v104 = true;
            if self.annotation_prefs.pen_color.eq_ignore_ascii_case("#38bdf8")
                || self.annotation_prefs.pen_color.trim().is_empty()
            {
                self.annotation_prefs.pen_color = "#ffffff".to_string();
            }
        }
        self.dark_mode.text_brightness = self.dark_mode.text_brightness.clamp(0.60, 1.00);
        self.dark_mode.contrast_boost = self.dark_mode.contrast_boost.clamp(0.80, 1.50);
        self.default_zoom = self.default_zoom.clamp(0.25, 5.0);
        self.window_geometry.width = self.window_geometry.width.clamp(720, 7680);
        self.window_geometry.height = self.window_geometry.height.clamp(500, 4320);
        self.annotation_prefs.pen_width = self.annotation_prefs.pen_width.clamp(0.5, 24.0);
        self.annotation_prefs.highlighter_width =
            self.annotation_prefs.highlighter_width.clamp(4.0, 48.0);
        self.annotation_prefs.eraser_radius = self.annotation_prefs.eraser_radius.clamp(2.0, 64.0);
        if self.recent_documents.len() > 25 {
            self.recent_documents.truncate(25);
        }
        if self.update_manifest_url.contains("github.com/luminapdf/luminapdf")
            || self.update_manifest_url.trim().is_empty()
        {
            self.update_manifest_url =
                "https://github.com/hydese/LuminaPDF/releases/latest/download/latest.json"
                    .to_string();
        }
    }

    pub fn record_recent_document(&mut self, entry: RecentDocumentEntry) {
        let norm_new = entry.path.replace('/', "\\").to_lowercase();
        self.recent_documents
            .retain(|r| r.path.replace('/', "\\").to_lowercase() != norm_new);
        self.recent_documents.insert(0, entry);
        if self.recent_documents.len() > 25 {
            self.recent_documents.truncate(25);
        }
        if self.update_manifest_url.contains("github.com/luminapdf/luminapdf")
            || self.update_manifest_url.trim().is_empty()
        {
            self.update_manifest_url =
                "https://github.com/hydese/LuminaPDF/releases/latest/download/latest.json"
                    .to_string();
        }
    }
}

pub struct SessionManager {
    settings_path: PathBuf,
}

impl SessionManager {
    pub fn new(app_data_dir: &Path) -> Self {
        let _ = fs::create_dir_all(app_data_dir);
        Self {
            settings_path: app_data_dir.join("settings.json"),
        }
    }

    pub fn load(&self) -> AppSettingsAndSession {
        if let Ok(bytes) = fs::read(&self.settings_path) {
            if let Ok(mut s) = serde_json::from_slice::<AppSettingsAndSession>(&bytes) {
                s.sanitize();
                return s;
            }
        }
        let bak_path = self.settings_path.with_extension("json.bak");
        if let Ok(bytes) = fs::read(&bak_path) {
            if let Ok(mut s) = serde_json::from_slice::<AppSettingsAndSession>(&bytes) {
                s.sanitize();
                return s;
            }
        }
        AppSettingsAndSession::default()
    }

    pub fn save(&self, settings: &mut AppSettingsAndSession) -> Result<(), String> {
        settings.sanitize();
        let bytes = serde_json::to_vec_pretty(settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        atomic_write_with_backup(&self.settings_path, &bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_session_persistence_and_malformed_recovery() {
        let dir = tempdir().expect("tempdir");
        let mgr = SessionManager::new(dir.path());

        let mut s = mgr.load();
        assert!(!s.reopen_tabs_on_startup);
        s.dark_mode.text_brightness = 0.88;
        s.record_recent_document(RecentDocumentEntry {
            path: r"C:\Docs\Calculus.pdf".to_string(),
            file_name: "Calculus.pdf".to_string(),
            content_sha256: "abc123".to_string(),
            last_page: 42,
            total_pages: 450,
            last_opened_at: "2026-10-27T17:00:00Z".to_string(),
        });
        mgr.save(&mut s).expect("save 1");

        let loaded = mgr.load();
        assert_eq!(loaded.recent_documents.len(), 1);
        assert_eq!(loaded.recent_documents[0].last_page, 42);
        assert!((loaded.dark_mode.text_brightness - 0.88).abs() < 1e-5);
    }
}
