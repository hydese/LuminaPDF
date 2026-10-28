//! Cross-platform abstraction layer (`PlatformAdapter`).
//!
//! Isolates OS-specific directories, shortcut modifiers, and system integration
//! so the shared application logic remains portable across Windows 10/11 and future macOS builds.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlatformCapabilities {
    pub os_name: String,
    pub arch: String,
    pub primary_modifier: String,
    pub primary_modifier_symbol: String,
    pub supports_file_associations: bool,
    pub supports_stylus_pressure: bool,
    pub app_data_dir: String,
}

/// Trait isolating OS-specific operations from the shared application core.
pub trait PlatformAdapter: Send + Sync {
    /// Returns the OS identifier ("windows", "macos", "linux").
    fn os_name(&self) -> &'static str;

    /// Returns the primary keyboard shortcut modifier ("Ctrl" on Windows, "Cmd" on macOS).
    fn primary_modifier(&self) -> &'static str;

    /// Returns the display symbol for the primary shortcut modifier.
    fn primary_modifier_symbol(&self) -> &'static str;

    /// Resolves the portable user application data directory for storing settings,
    /// session state, and sidecar annotation files.
    fn resolve_app_data_dir(&self) -> PathBuf;

    /// Normalizes a file path for consistent identity lookups across separators.
    fn normalize_path(&self, path: &Path) -> String;

    /// Returns platform capabilities metadata for the frontend UI.
    fn capabilities(&self) -> PlatformCapabilities {
        PlatformCapabilities {
            os_name: self.os_name().to_string(),
            arch: std::env::consts::ARCH.to_string(),
            primary_modifier: self.primary_modifier().to_string(),
            primary_modifier_symbol: self.primary_modifier_symbol().to_string(),
            supports_file_associations: true,
            supports_stylus_pressure: true,
            app_data_dir: self.resolve_app_data_dir().to_string_lossy().to_string(),
        }
    }
}

/// Windows 10 / Windows 11 implementation of `PlatformAdapter`.
pub struct WindowsPlatformAdapter;

impl PlatformAdapter for WindowsPlatformAdapter {
    fn os_name(&self) -> &'static str {
        "windows"
    }

    fn primary_modifier(&self) -> &'static str {
        "Ctrl"
    }

    fn primary_modifier_symbol(&self) -> &'static str {
        "Ctrl+"
    }

    fn resolve_app_data_dir(&self) -> PathBuf {
        if let Ok(appdata) = std::env::var("APPDATA") {
            PathBuf::from(appdata).join("LuminaPDF")
        } else if let Ok(userprofile) = std::env::var("USERPROFILE") {
            PathBuf::from(userprofile)
                .join("AppData")
                .join("Roaming")
                .join("LuminaPDF")
        } else {
            std::env::temp_dir().join("LuminaPDF")
        }
    }

    fn normalize_path(&self, path: &Path) -> String {
        let raw = path.to_string_lossy().replace('/', "\\");
        // Strip extended-length path prefix if present
        let trimmed = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
        trimmed.to_lowercase()
    }
}

/// Future macOS implementation stub of `PlatformAdapter`.
/// Kept portable so enabling macOS requires no changes to core modules.
pub struct MacOsPlatformAdapter;

impl PlatformAdapter for MacOsPlatformAdapter {
    fn os_name(&self) -> &'static str {
        "macos"
    }

    fn primary_modifier(&self) -> &'static str {
        "Cmd"
    }

    fn primary_modifier_symbol(&self) -> &'static str {
        "⌘"
    }

    fn resolve_app_data_dir(&self) -> PathBuf {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("LuminaPDF")
        } else {
            std::env::temp_dir().join("LuminaPDF")
        }
    }

    fn normalize_path(&self, path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }
}

/// Factory returning the active `PlatformAdapter` for the compiled target OS.
pub fn current_platform() -> Box<dyn PlatformAdapter> {
    #[cfg(target_os = "macos")]
    {
        Box::new(MacOsPlatformAdapter)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(WindowsPlatformAdapter)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_windows_platform_adapter() {
        let win = WindowsPlatformAdapter;
        assert_eq!(win.os_name(), "windows");
        assert_eq!(win.primary_modifier(), "Ctrl");
        let norm = win.normalize_path(Path::new(r"C:/Users/Test\Docs\Paper.PDF"));
        assert_eq!(norm, r"c:\users\test\docs\paper.pdf");
    }

    #[test]
    fn test_macos_platform_adapter_readiness() {
        let mac = MacOsPlatformAdapter;
        assert_eq!(mac.os_name(), "macos");
        assert_eq!(mac.primary_modifier(), "Cmd");
        let norm = mac.normalize_path(Path::new("/Users/test/Docs/Paper.pdf"));
        assert_eq!(norm, "/Users/test/Docs/Paper.pdf");
    }
}
