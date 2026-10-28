# LuminaPDF Reproducible Windows Build & Packaging Script
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1

$ErrorActionPreference = "Stop"
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

Write-Host "=== [1/4] Installing / verifying frontend dependencies ===" -ForegroundColor Cyan
npm.cmd install

Write-Host "=== [2/4] Building TypeScript + Vite production frontend ===" -ForegroundColor Cyan
npm.cmd run build

Write-Host "=== [3/4] Running Rust & Frontend Automated Tests ===" -ForegroundColor Cyan
node .\tests\frontend.test.mjs
Push-Location src-tauri
cargo test
Pop-Location

Write-Host "=== [4/4] Building Windows Release Executable & Installer Package ===" -ForegroundColor Cyan
npx.cmd tauri build

Write-Host "Build complete! Artifacts located in src-tauri\target\release\" -ForegroundColor Green
