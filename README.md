# LuminaPDF — Minimalist Windows PDF Reader with Intelligent Dark Mode

**LuminaPDF** (`v1.0.5`) is a lightweight, high-contrast desktop PDF reader for **Windows 10 and Windows 11**, created by **hydese** and engineered with **Rust**, **Tauri v2**, **TypeScript**, and **PDF.js (`pdfjs-dist`) + `lopdf`**.

Its primary mission is making long academic textbooks, lecture notes, mathematical papers, technical manuals, and scanned books comfortable to read and study—especially at night—through a content-aware **Intelligent Dark Mode** and non-destructive **atomic sidecar annotations**.

---

## 1. Key Features

### Intelligent Dark Mode (Primary Feature)
- **One-Click Toolbar Toggle (`Ctrl+Shift+D`):** Instantly switches between Original PDF Colors and Intelligent Dark Mode without modifying the underlying PDF file.
- **Semantic Vector & Text Rendering:** Intercepts `CanvasRenderingContext2D` drawing operations during PDF page rasterization:
  - White and light page backgrounds are mapped directly to configurable dark surfaces (**Near-Black `#121214`**, **OLED True Black `#000000`**, **Warm Charcoal `#181715`**, or **Deep Academic Slate `#0F141C`**).
  - Black/dark text, LaTeX mathematical formulas, integrals, matrices, and vector lines are rendered at full native vector resolution in crisp, adjustable light tones (`60%–100%` brightness, `80%–150%` contrast boost).
  - Colored vector diagrams, charts, graphs, and links have their hue preserved in HSL space while adapting lightness for high legibility against dark backgrounds.
- **Content-Aware Image & Scanned Page Processing:**
  - **Embedded Photographs:** Automatically classified via luminance/saturation histogram analysis and preserved in their authentic, un-inverted colors.
  - **Scanned Black-and-White Books (`ScannedAdaptive`):** Estimates the scanned paper white point and ink black point, suppresses paper grain/bleed-through, and smoothly inverts grayscale ink without harsh binary thresholding.
  - **Scanned Color Pages (`ScannedColorPreserve`):** Applies chroma-preserving lightness inversion so white paper turns dark while colored diagrams retain their original hue.

### PDF Reading & Navigation
- Open PDFs via native Windows file dialog (`Ctrl+O`), drag-and-drop from File Explorer, command-line arguments, or recent/sample libraries.
- **Multiple Tabs:** Independent reading position, zoom, page layout (`Continuous` vs. `Single Page`), dark-mode preferences, undo/redo stacks, bookmarks, search state, and back/forward navigation history per tab.
- **Virtualized Viewport Rendering:** Only renders visible and adjacent pages at device-pixel-ratio resolution with bounded canvas caching (max 10 pages cached in RAM) and automatic cancellation of obsolete render jobs during rapid scrolling.
- **Interactive Links & Outlines:** Supports internal PDF page jump links (recording history in Back/Forward stacks), external `https://` links (opened safely in the default system browser), embedded Table of Contents (`Outlines`), and user-created Bookmarks (`Ctrl+D`).

### Study & Annotation Tools (Non-Destructive Sidecar Persistence)
- **Tools:** Reading/Selection mode (`V`/`Esc`), Freehand Pen (`P`, supports mouse and stylus pressure), Freehand Highlighter (`H`, screen/multiply blend that never obscures text), Box Highlight (`M`), Text/Formula Underline (`U`), Sticky Text Notes (`N`, draggable, editable, deletable), and Geometric Stroke Eraser (`E`).
- **Document-Coordinate Alignment:** All annotations are stored in canonical unrotated PDF page points (`1/72 inch`), staying locked to PDF content across any zoom level, rotation (`0°, 90°, 180°, 270°`), layout switch, or dark-mode toggle.
- **Original PDF Protection & Atomic Sidecars:**
  - Original PDFs are **never** modified during reading or annotation.
  - Sidecars are keyed by **SHA-256 content hash** in `%APPDATA%\LuminaPDF\sidecars\<sha256>.json` (with optional adjacent `<filename>.pdf.luminapdf.json`).
  - Moving or renaming a PDF preserves all annotations automatically via SHA-256 content matching.
  - External modifications to a PDF are detected and flagged with a one-click option to migrate previous annotations.
  - Uses atomic `.tmp` writes + `sync_all()` + `.bak` backup recovery to prevent data loss on unexpected shutdowns.
- **Annotated PDF Export (`Ctrl+Shift+E`):** Exports a separate standalone PDF with vector strokes, highlights, underlines, and notes embedded via `lopdf` (with overwrite protection).

---

## 2. Keyboard Shortcuts Reference

| Shortcut | Action |
| :--- | :--- |
| `Ctrl+O` | Open PDF file(s) |
| `Ctrl+Shift+D` | Toggle Intelligent Dark Mode |
| `Ctrl+F` | Open full-text search bar (`Enter` next, `Shift+Enter` previous) |
| `Ctrl+W` | Close current tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Switch to next / previous tab |
| `Ctrl++` / `Ctrl+-` | Zoom in / Zoom out |
| `Ctrl+0` | Reset zoom to **Fit to Width** |
| `PageDown` / `PageUp` | Next page / Previous page |
| `Home` / `End` | Jump to first / last page |
| `Alt+Left` / `Alt+Right` | Navigate back / forward in link history |
| `Ctrl+D` | Toggle bookmark on current page |
| `Ctrl+B` | Toggle left sidebar (Outline, Bookmarks, Notes, Library) |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo annotation operation |
| `V` / `Esc` | Switch to Reading & Link Selection mode |
| `P` / `H` / `M` / `U` / `N` / `E` | Select Pen / Highlighter / Box Highlight / Underline / Note / Eraser |
| `F1` / `?` | Open in-app Keyboard Shortcuts reference modal |

---

## 3. Installation & Uninstallation (Windows 10 & Windows 11)

### Installing LuminaPDF
1. **Using the NSIS Installer (`LuminaPDF_1.0.5_x64-setup.exe`):**
   - Double-click `release\LuminaPDF_1.0.5_x64-setup.exe`.
   - Follow the per-user installation wizard (no Administrator elevation required).
   - Registers `.pdf` file association (`Open with -> LuminaPDF`) and creates Start Menu / Desktop shortcuts.
2. **Using the Portable Release Executable (`luminapdf.exe`):**
   - Run `release\luminapdf.exe` directly on any Windows 10 or Windows 11 (64-bit) system with Microsoft Edge WebView2 installed.

### Uninstalling LuminaPDF
- Open **Windows Settings -> Apps -> Installed apps (or Apps & features)**, locate **LuminaPDF**, and click **Uninstall**.
- User annotations and reading history in `%APPDATA%\LuminaPDF` are preserved across upgrades and can be deleted manually if a complete reset is desired.

---

## 4. Reproducible Windows Build & Test Instructions

### Prerequisites
- **OS:** Windows 10 (1809+) or Windows 11 (x64)
- **Rust:** `rustc` & `cargo` (stable-x86_64-pc-windows-msvc)
- **C++ Build Tools:** Visual Studio Build Tools with VC++ x64 toolchain
- **Node.js:** v20+ and `npm`

### Exact Commands to Test & Rebuild
```powershell
# Ensure Cargo is on PATH
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# 1. Install frontend dependencies
npm.cmd install

# 2. Build frontend production bundle
npm.cmd run build

# 3. Run frontend & Rust automated test suites
node .\tests\frontend.test.mjs
Push-Location src-tauri
cargo test
Pop-Location

# 4. Build release executable and Windows installer
npx.cmd tauri build
```
Or run the automated build script:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
```

---

## 5. Third-Party Dependencies & Licensing

All dependencies use permissive open-source licenses suitable for personal and commercial redistribution:

| Component / Crate / Package | Version | License | Purpose |
| :--- | :--- | :--- | :--- |
| `tauri` / `@tauri-apps/*` | 2.2.x | MIT OR Apache-2.0 | Desktop application shell & IPC |
| `pdfjs-dist` (Mozilla PDF.js) | 4.10.38 | Apache-2.0 | PDF parsing, operator list execution & text/link layers |
| `lopdf` | 0.34.x | MIT | Native Rust PDF structural validation, synthetic test PDF generation & annotated PDF export |
| `image` | 0.25.x | MIT OR Apache-2.0 | Raster image decoding/encoding in Rust |
| `rayon` | 1.10.x | MIT OR Apache-2.0 | Parallel pixel transformation for scanned pages |
| `sha2` & `hex` | 0.10 / 0.4 | MIT OR Apache-2.0 | SHA-256 document identity fingerprinting & update verification |
| `serde` & `serde_json` | 1.0.x | MIT OR Apache-2.0 | Sidecar, settings, and update manifest serialization |
| `chrono` | 0.4.x | MIT OR Apache-2.0 | ISO-8601 timestamps for annotations and history |
