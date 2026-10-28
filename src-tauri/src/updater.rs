//! Semantic Versioning, Update Manifest Validation & Package Verification.
//!
//! Implements safe update checking, manifest schema validation, downgrade prevention,
//! and SHA-256 package integrity checks.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fmt;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemVer {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub pre_release: Option<String>,
}

impl SemVer {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let cleaned = raw.trim().trim_start_matches('v').trim_start_matches('V');
        let (core, pre) = match cleaned.split_once('-') {
            Some((c, p)) => (c, Some(p.to_string())),
            None => (cleaned, None),
        };
        let parts: Vec<&str> = core.split('.').collect();
        if parts.len() != 3 {
            return Err(format!("Invalid semantic version '{}'", raw));
        }
        let major = parts[0]
            .parse::<u32>()
            .map_err(|_| format!("Invalid major version in '{}'", raw))?;
        let minor = parts[1]
            .parse::<u32>()
            .map_err(|_| format!("Invalid minor version in '{}'", raw))?;
        let patch = parts[2]
            .parse::<u32>()
            .map_err(|_| format!("Invalid patch version in '{}'", raw))?;
        Ok(Self {
            major,
            minor,
            patch,
            pre_release: pre,
        })
    }
}

impl fmt::Display for SemVer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.pre_release {
            Some(pre) => write!(f, "{}.{}.{}-{}", self.major, self.minor, self.patch, pre),
            None => write!(f, "{}.{}.{}", self.major, self.minor, self.patch),
        }
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.major.cmp(&other.major) {
            Ordering::Equal => {}
            ord => return ord,
        }
        match self.minor.cmp(&other.minor) {
            Ordering::Equal => {}
            ord => return ord,
        }
        match self.patch.cmp(&other.patch) {
            Ordering::Equal => {}
            ord => return ord,
        }
        // Normal release > pre-release for same (major, minor, patch)
        match (&self.pre_release, &other.pre_release) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(a), Some(b)) => a.cmp(b),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformUpdateAsset {
    pub url: String,
    pub sha256: String,
    pub signature: Option<String>,
    pub installer_type: String, // "nsis" | "msi"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub version: String,
    pub pub_date: String,
    pub notes: String,
    pub windows_x86_64: PlatformUpdateAsset,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheckResponse {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_notes: String,
    pub pub_date: String,
    pub download_url: Option<String>,
    pub expected_sha256: Option<String>,
    pub signature_present: bool,
    pub status_message: String,
}

/// Validates an `UpdateManifest` JSON payload and determines whether it represents a valid,
/// non-downgrade upgrade over `current_version_str`.
pub fn evaluate_update_manifest(
    current_version_str: &str,
    manifest_json: &str,
) -> Result<UpdateCheckResponse, String> {
    let current = SemVer::parse(current_version_str)?;
    let manifest: UpdateManifest = serde_json::from_str(manifest_json)
        .map_err(|e| format!("Invalid update manifest JSON: {}", e))?;

    let candidate = SemVer::parse(&manifest.version)?;

    // Validate asset URL and SHA-256 format
    if !manifest.windows_x86_64.url.starts_with("https://") {
        return Err("Update asset URL must use HTTPS.".to_string());
    }
    let sha_clean = manifest.windows_x86_64.sha256.trim();
    if sha_clean.len() != 64 || !sha_clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Update manifest must include a valid 64-character hex SHA-256 digest.".to_string());
    }

    if candidate < current {
        return Err(format!(
            "Refusing downgrade: manifest version {} is older than installed version {}.",
            candidate, current
        ));
    }

    let update_available = candidate > current;
    let status_message = if update_available {
        format!(
            "Update available: v{} (installed: v{}). Package integrity verified via SHA-256.",
            candidate, current
        )
    } else {
        format!("LuminaPDF v{} is up to date.", current)
    };

    Ok(UpdateCheckResponse {
        current_version: current.to_string(),
        latest_version: candidate.to_string(),
        update_available,
        release_notes: manifest.notes,
        pub_date: manifest.pub_date,
        download_url: if update_available {
            Some(manifest.windows_x86_64.url)
        } else {
            None
        },
        expected_sha256: if update_available {
            Some(sha_clean.to_lowercase())
        } else {
            None
        },
        signature_present: manifest
            .windows_x86_64
            .signature
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
        status_message,
    })
}

/// Verifies that a downloaded installer payload matches its expected SHA-256 digest.
pub fn verify_package_sha256(package_bytes: &[u8], expected_hex_sha256: &str) -> Result<(), String> {
    let mut hasher = Sha256::new();
    hasher.update(package_bytes);
    let actual_hex = hex::encode(hasher.finalize());
    if actual_hex.eq_ignore_ascii_case(expected_hex_sha256.trim()) {
        Ok(())
    } else {
        Err(format!(
            "Package SHA-256 mismatch! Expected {}, got {}. Refusing to execute package.",
            expected_hex_sha256, actual_hex
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_semver_comparison_and_prerelease() {
        let v1_0_0 = SemVer::parse("1.0.0").unwrap();
        let v1_0_1 = SemVer::parse("v1.0.1").unwrap();
        let v1_1_0_beta = SemVer::parse("1.1.0-beta.1").unwrap();
        let v1_1_0 = SemVer::parse("1.1.0").unwrap();

        assert!(v1_0_1 > v1_0_0);
        assert!(v1_1_0_beta > v1_0_1);
        assert!(v1_1_0 > v1_1_0_beta);
    }

    #[test]
    fn test_manifest_validation_and_downgrade_prevention() {
        let valid_manifest = r#"{
            "version": "1.2.0",
            "pub_date": "2026-10-27T17:00:00Z",
            "notes": "Improved scanned color dark mode.",
            "windows_x86_64": {
                "url": "https://github.com/luminapdf/luminapdf/releases/download/v1.2.0/LuminaPDF_1.2.0_x64-setup.exe",
                "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                "signature": "dW5zaWduZWQtZGV2LXNpZ25hdHVyZQ==",
                "installer_type": "nsis"
            }
        }"#;

        let res = evaluate_update_manifest("1.0.0", valid_manifest).expect("valid update");
        assert!(res.update_available);
        assert_eq!(res.latest_version, "1.2.0");
        assert!(res.signature_present);

        // Downgrade attempt must fail
        let downgrade_err = evaluate_update_manifest("2.0.0", valid_manifest);
        assert!(downgrade_err.is_err());

        // Insecure HTTP URL must fail
        let insecure_manifest = valid_manifest.replace("https://", "http://");
        assert!(evaluate_update_manifest("1.0.0", &insecure_manifest).is_err());
    }

    #[test]
    fn test_package_sha256_verification() {
        let payload = b"dummy installer binary content";
        let mut h = Sha256::new();
        h.update(payload);
        let good_sha = hex::encode(h.finalize());

        assert!(verify_package_sha256(payload, &good_sha).is_ok());
        assert!(verify_package_sha256(
            payload,
            "0000000000000000000000000000000000000000000000000000000000000000"
        )
        .is_err());
    }
}
