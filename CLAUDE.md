# snap-pc — Windows Port Context for Claude Code

## What this is

Windows port of snap-main. Same concept: Tauri 2.x desktop app for screen annotation that feeds
marked-up screenshots to Claude Code via an MCP server. Targets Windows 10/11 only.

## Architecture

- `app/` — Tauri 2.x project. Vanilla HTML/CSS/JS frontend (no framework), Rust backend.
- `mcp-server/` — Python package using `fastmcp`. Identical to snap-main; already cross-platform.

## Key differences from snap-main

| Concern | snap-main (Linux/macOS) | snap-pc (Windows) |
|---|---|---|
| Screen capture | CLI tools (grim, scrot, screencapture) | `screenshots` crate (Windows Graphics API) |
| Window context | xdotool / osascript | Win32 API via `windows` crate |
| Temp file path | `/tmp/snap-capture.png` | `std::env::temp_dir()/snap-capture.png` |
| Execution modes | Tray (X11) + single-shot overlay (Wayland) | Tray only (always) |
| System service | systemd / launchctl | Not yet — run manually or via Windows startup |
| Open logs | `open` / `xdg-open` | `explorer` |

## Windows-specific notes

- Requires **WebView2 runtime** (pre-installed on Windows 11; downloadable for Windows 10).
- Screen capture uses the `screenshots` crate which calls `Windows.Graphics.Capture` or GDI.
- No Wayland, no overlay-mode argument, no trigger script — `main()` always calls `run_tray_mode()`.
- Tray icon appears in the system notification area (bottom-right). Right-click → Open Logs / Quit.
- Global hotkey `Ctrl+Shift+S` is registered via `tauri-plugin-global-shortcut`, which works on Windows.
- Annotations stored in `%USERPROFILE%\.snap\inbox\` (same `~/.snap` path as snap-main via `dirs` crate).
- Log file: `%USERPROFILE%\.snap\snap.log`

## Windows startup (optional — not yet implemented)

To run Snap on login, add to registry:
```
HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Run
  snap = "C:\path\to\snap.exe"
```

Or create a Task Scheduler task that triggers on user login.

## Conventions

- Tauri commands use snake_case (same as snap-main)
- JS annotation objects match the sidecar JSON schema (same as snap-main)
- All file paths use `~/.snap/` as the root
- Error handling: never crash silently, always log to `~/.snap/snap.log`
- Log rotation at 1MB

## Build

```powershell
cd app
npm install
npx tauri build        # production .exe + installer
npx tauri dev          # dev server with hot reload
```

Important: Always use `npx tauri build` or `npx tauri dev`, never bare `cargo build`.
The Tauri build embeds the frontend files into the binary.

## Prerequisites

```powershell
# Rust
winget install Rustlang.Rustup
rustup default stable

# Node (LTS)
winget install OpenJS.NodeJS.LTS

# Visual Studio Build Tools (C++ workload required by Tauri on Windows)
winget install Microsoft.VisualStudio.2022.BuildTools
# During install, select: Desktop development with C++

# WebView2 (usually pre-installed on Win 10/11)
# If missing: https://developer.microsoft.com/en-us/microsoft-edge/webview2/
```
