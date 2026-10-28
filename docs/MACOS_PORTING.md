# Future macOS Porting Guide (Architecture & Remaining Work)

> **Scope Note:** Per project requirements, **macOS is not implemented, packaged, or tested in this phase**. Only Windows 10/11 is delivered and verified today. However, the codebase has been explicitly architected to make a future macOS port straightforward without rewriting core modules.

## 1. Cross-Platform Architectural Decisions Already In Place

1. **Zero Windows-Only Crates in Shared Core:**
   - All core Rust modules (`dark_mode.rs`, `annotations.rs`, `storage.rs`, `session.rs`, `search.rs`, `pdf_engine.rs`, `updater.rs`, `test_pdf_gen.rs`) use portable standard Rust and cross-platform crates (`lopdf`, `image`, `rayon`, `sha2`, `serde`).
2. **Platform Abstraction Trait (`src-tauri/src/platform.rs`):**
   - OS-specific paths, path normalization, and shortcut modifier symbols (`Ctrl` vs `⌘ Cmd`) are isolated behind the `PlatformAdapter` trait.
   - `MacOsPlatformAdapter` is already implemented in `platform.rs` and tested in unit tests (`test_macos_platform_adapter_readiness`), resolving application data to `~/Library/Application Support/LuminaPDF`.
3. **Cross-Platform PDF Engine:**
   - `pdfjs-dist` (Canvas2D) + `lopdf` require zero native C/C++ dynamic libraries (`pdfium.dylib` is not needed), compiling and running identically on macOS `WKWebView` (Apple Silicon `aarch64-apple-darwin` and Intel `x86_64-apple-darwin`).
4. **Modifier-Aware Frontend Shortcuts (`src/main.ts`):**
   - Keyboard handlers check `const mod = e.ctrlKey || e.metaKey;`, supporting both `Ctrl` on Windows and `Cmd (⌘)` on macOS.

## 2. Remaining Steps for a Future macOS Release Phase

1. **Build Environment Prerequisites:**
   - macOS 13+ machine or CI runner with Xcode Command Line Tools (`xcode-select --install`).
   - Rust targets: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
2. **Application Icon (`icon.icns`):**
   - Generate `src-tauri/icons/icon.icns` from `src-tauri/icons/128x128@2x.png` using `npx tauri icon` or macOS `iconutil` and add `"icons/icon.icns"` to `bundle.icon` in `src-tauri/tauri.conf.json`.
3. **macOS File Associations & Native Menu Bar:**
   - Verify `.pdf` `CFBundleDocumentTypes` registration in the generated `.app` bundle `Info.plist` and wire `tauri::RunEvent::Opened { urls }` in `src-tauri/src/lib.rs` to forward Finder "Open With" file URLs to the frontend alongside `std::env::args()`.
4. **Update Manifest Target (`darwin_universal` / `darwin_aarch64`):**
   - Add `macos_aarch64` and `macos_x86_64` asset fields (`.app.tar.gz` + SHA-256) to `UpdateManifest` in `src-tauri/src/updater.rs`.
5. **Apple Developer Signing & Notarization:**
   - Configure `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` environment variables before running `npx tauri build --target universal-apple-darwin`.
