# Technical Architecture, Intelligent Dark Mode & Operations Guide

## 1. Modular System Architecture

LuminaPDF separates concerns across portable Rust backend modules (`src-tauri/src/`) and lightweight TypeScript frontend modules (`src/`):

```
LuminaPDF/
├── src-tauri/src/
│   ├── lib.rs           # Tauri command handlers, state management & integration tests
│   ├── main.rs          # Windows subsystem entry point
│   ├── platform.rs      # Cross-platform PlatformAdapter trait (Windows + macOS stub)
│   ├── dark_mode.rs     # Semantic color transforms, image classifier & Rayon pixel pipeline
│   ├── annotations.rs   # PDF point coordinate math, stroke hit-testing & data structures
│   ├── storage.rs       # SHA-256 identity, atomic sidecar writes (.tmp/.bak) & migration
│   ├── session.rs       # Settings validation, recent documents & session restoration
│   ├── search.rs        # Local in-memory full-text search & snippet extraction
│   ├── pdf_engine.rs    # lopdf validation, encryption detection & annotated PDF export
│   ├── updater.rs       # SemVer comparator, manifest validator & SHA-256 verification
│   └── test_pdf_gen.rs  # Synthetic 10-document test suite generator
└── src/
    ├── main.ts          # Multi-tab manager, virtualized viewport, UI & shortcuts
    ├── darkModeEngine.ts# Canvas2D semantic proxy interceptor & image region processor
    ├── annotationLayer.ts# Overlay rendering, stylus pressure & coordinate transforms
    └── styles.css       # Minimalist dark/light desktop styling
```

---

## 2. Intelligent Dark Mode Implementation & Known Limitations

### Hybrid Rendering Pipeline
1. **Born-Digital Text, Equations & Vector Graphics (`SemanticTextVector`):**
   - `createSemanticDarkCanvasContext` wraps the `CanvasRenderingContext2D` passed to `pdfPage.render()`.
   - Large light neutral fills (`luma >= 0.82`, `saturation < 0.20`) are recognized as page backgrounds and mapped to the chosen dark surface (`#121214`, `#000000`, `#181715`, or `#0F141C`).
   - Achromatic text, mathematical symbols, fraction bars, and line art (`saturation < 0.22`) have their luminance smoothly inverted and scaled by `text_brightness` and `contrast_boost` at full native vector resolution.
   - Saturated vector strokes and fills (`saturation >= 0.22`) retain their exact HSL hue while having lightness adjusted into `[0.52, 0.86]` so dark blue or dark red graph series remain vibrant and readable against dark backgrounds.
2. **Embedded Images & Scanned Pages (`classifyImageRegion` + `processImageBufferDarkMode`):**
   - Every `drawImage` call is sampled (up to 8,192 points) to compute `light_paper_ratio`, `dark_ink_ratio`, `colored_pixel_ratio`, the 90th-percentile paper white luma, and the 5th-percentile ink black luma.
   - **Photographs (`light_paper_ratio < 0.42`):** Preserved untouched in their original colors.
   - **Scanned B&W Pages (`light_paper_ratio >= 0.42`, `colored_pixel_ratio < 0.06`):** Normalized against estimated paper white and ink black points with soft gamma contrast shaping—eliminating gray paper background noise while keeping anti-aliased glyph edges smooth.
   - **Scanned Color Pages (`light_paper_ratio >= 0.42`, `colored_pixel_ratio >= 0.06`):** Applies chroma-preserving lightness inversion.

### Known Rendering Limitations
- **Complex Shading Meshes / Type 4–7 PDF Gradients:** PDFs that render smooth vector gradients via thousands of tiny `fill` sub-polygons may have individual bands classified by local luminance. Switching the strategy dropdown to **Original PDF Colors** or **Scanned Color Preserve** provides an immediate 1-click fallback.
- **Photographs with Large White Studio Backdrops:** A product photo on a pure white studio background (`light_paper_ratio >= 0.42`) may be classified as a colored diagram on paper. Users can toggle modes at any time via `Ctrl+Shift+D`.
- **Scanned PDFs Without Embedded Text:** Full-text search detects the absence of a text layer and displays an informative notice explaining that OCR is required for text search on image-only scans.

---

## 3. Sidecar Storage, Atomic Recovery & External Change Detection

- **Location:** `%APPDATA%\LuminaPDF\sidecars\<content_sha256>.json` (and optionally `<pdf_path>.luminapdf.json`).
- **Atomic Write Protocol (`atomic_write_with_backup`):**
  1. Serializes JSON to `<sha256>.json.tmp` and calls OS `sync_all()`.
  2. Copies the previous valid `<sha256>.json` to `<sha256>.json.bak`.
  3. Atomically renames `.tmp` to `.json`.
- **Automatic Corruption Recovery:** On load, if the primary `.json` fails parsing or validation, `SidecarStorageManager` automatically restores from `.json.bak`.
- **Moved/Renamed Files vs. Same-Filename Collisions:** Because lookup is keyed by full-file SHA-256, moving or renaming a PDF preserves all annotations, while opening a different PDF with the same filename never mixes annotations.

---

## 4. Application Updates & Release Configuration

### Implemented Update Architecture (`src-tauri/src/updater.rs`)
- **Semantic Versioning:** Strict `MAJOR.MINOR.PATCH[-prerelease]` parsing and ordering (`SemVer`).
- **Manifest Verification:** Validates HTTPS asset URLs, 64-char hex SHA-256 digests, optional cryptographic signatures, and blocks any downgrade (`candidate < current`).
- **Data Preservation:** User settings, recent history, and sidecar annotations reside in `%APPDATA%\LuminaPDF`, completely outside the installation directory, guaranteeing zero data loss during upgrades.

### External Configuration Required for Public Auto-Updates
To activate live over-the-air updates from a public release channel, the repository owner must provide:
1. **Release Hosting URL:** Update `update_manifest_url` in `session.rs` (default: `https://github.com/luminapdf/luminapdf/releases/latest/download/latest.json`) to point to the live GitHub repository.
2. **Windows Code Signing Certificate (Optional but Recommended for SmartScreen):**
   - Provide an Authenticode `.pfx` / hardware token certificate in CI (`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) so `latest.json` includes a verified signature.
   - Note: Local builds produced in this environment are **unsigned development/release packages**.
