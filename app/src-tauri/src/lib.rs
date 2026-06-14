use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

pub static OVERLAY_ACTIVE: AtomicBool = AtomicBool::new(false);

// ----- Capture file path -----

fn capture_temp_path() -> PathBuf {
    std::env::temp_dir().join("snap-capture.png")
}

// ----- Screen Capture (Windows) -----

#[tauri::command]
fn capture_screen() -> Result<String, String> {
    let path = capture_temp_path();
    let _ = fs::remove_file(&path);

    #[cfg(target_os = "windows")]
    {
        use screenshots::Screen;

        let screens = Screen::all().map_err(|e| format!("Failed to list screens: {}", e))?;

        let screen = screens
            .iter()
            .find(|s| s.display_info.is_primary)
            .or_else(|| screens.first())
            .ok_or("No screens found")?;

        let image = screen
            .capture()
            .map_err(|e| format!("Screen capture failed: {}", e))?;

        image
            .save(&path)
            .map_err(|e| format!("Failed to save capture: {}", e))?;

        match fs::metadata(&path) {
            Ok(meta) if meta.len() > 0 => {
                log_event("screen captured via screenshots crate");
                return Ok(path.to_string_lossy().to_string());
            }
            _ => return Err("Screen capture produced empty file".to_string()),
        }
    }

    #[cfg(not(target_os = "windows"))]
    Err("snap-pc only supports Windows".to_string())
}

// ----- Window Context -----

#[derive(Serialize, Clone)]
struct WindowContext {
    window_title: Option<String>,
    url: Option<String>,
    window_class: Option<String>,
    pid: Option<u32>,
}

static PRE_CAPTURED_CONTEXT: Mutex<Option<WindowContext>> = Mutex::new(None);

pub fn capture_and_store_window_context() {
    #[cfg(target_os = "windows")]
    {
        let ctx = get_active_window_context_windows();
        if let Ok(mut lock) = PRE_CAPTURED_CONTEXT.lock() {
            *lock = Some(ctx);
        }
    }
}

#[tauri::command]
fn get_active_window_context() -> Result<WindowContext, String> {
    #[cfg(target_os = "windows")]
    {
        // Return the pre-captured context if available (snapped before overlay opened)
        if let Ok(mut lock) = PRE_CAPTURED_CONTEXT.lock() {
            if let Some(ctx) = lock.take() {
                return Ok(ctx);
            }
        }
        return Ok(get_active_window_context_windows());
    }

    #[cfg(not(target_os = "windows"))]
    Ok(WindowContext {
        window_title: None,
        url: None,
        window_class: None,
        pid: None,
    })
}

#[cfg(target_os = "windows")]
fn get_active_window_context_windows() -> WindowContext {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return WindowContext {
                window_title: None,
                url: None,
                window_class: None,
                pid: None,
            };
        }

        // Window title
        let title_len = GetWindowTextLengthW(hwnd);
        let window_title = if title_len > 0 {
            let mut buf = vec![0u16; (title_len + 1) as usize];
            GetWindowTextW(hwnd, &mut buf);
            buf.truncate(title_len as usize);
            Some(String::from_utf16_lossy(&buf))
        } else {
            None
        };

        // Window class name (identifies the application type)
        let mut class_buf = [0u16; 256];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        let window_class = if class_len > 0 {
            Some(String::from_utf16_lossy(&class_buf[..class_len as usize]))
        } else {
            None
        };

        // Process ID
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        // Browsers: Chrome, Edge, Firefox, Brave — infer URL from title bar
        let is_browser = window_class
            .as_ref()
            .map(|c| {
                let lower = c.to_lowercase();
                lower.contains("chrome")
                    || lower.contains("msedge")
                    || lower.contains("firefox")
                    || lower.contains("brave")
                    || lower.contains("opera")
            })
            .unwrap_or(false);

        let url = if is_browser {
            window_title.clone()
        } else {
            None
        };

        WindowContext {
            window_title,
            url,
            window_class,
            pid: if pid > 0 { Some(pid) } else { None },
        }
    }
}

// ----- Save Annotation -----

#[tauri::command]
fn save_annotation(metadata_json: String, image_base64: Option<String>) -> Result<String, String> {
    let inbox = inbox_dir()?;

    let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f").to_string();
    let timestamp = timestamp.replace('.', "-");
    let png_name = format!("snap-{}.png", timestamp);
    let json_name = format!("snap-{}.json", timestamp);

    let png_path = inbox.join(&png_name);
    let json_path = inbox.join(&json_name);

    if let Some(b64) = image_base64 {
        let image_bytes = base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .map_err(|e| format!("Base64 decode failed: {}", e))?;
        fs::write(&png_path, &image_bytes).map_err(|e| format!("Failed to write PNG: {}", e))?;
    } else {
        // Copy the raw screen capture — much faster, no IPC overhead
        let capture = capture_temp_path();
        if capture.exists() {
            fs::copy(&capture, &png_path)
                .map_err(|e| format!("Failed to copy capture: {}", e))?;
        } else {
            return Err("No capture file found".to_string());
        }
    }

    let mut metadata: serde_json::Value =
        serde_json::from_str(&metadata_json).map_err(|e| format!("Invalid JSON: {}", e))?;
    metadata["image_filename"] = serde_json::json!(png_name);

    let metadata_str =
        serde_json::to_string_pretty(&metadata).map_err(|e| format!("JSON serialize: {}", e))?;

    fs::write(&json_path, &metadata_str)
        .map_err(|e| format!("Failed to write metadata: {}", e))?;

    log_event(&format!("Saved annotation: {}", png_name));

    Ok(png_path.to_string_lossy().to_string())
}

// ----- Read capture as base64 (avoids tainted canvas) -----

#[tauri::command]
fn read_capture_base64() -> Result<String, String> {
    let path = capture_temp_path();
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read capture: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

// ----- Overlay lifecycle -----

#[tauri::command]
fn mark_overlay_closed() {
    OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
    log_event("overlay closed");
}

// ----- Helpers -----

fn inbox_dir() -> Result<PathBuf, String> {
    let dir = dirs::home_dir()
        .ok_or("Could not determine home directory")?
        .join(".snap")
        .join("inbox");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create inbox: {}", e))?;
    Ok(dir)
}

pub fn log_event(msg: &str) {
    let log_dir = dirs::home_dir()
        .map(|h| h.join(".snap"))
        .unwrap_or_else(|| PathBuf::from(std::env::temp_dir()));
    let _ = fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("snap.log");

    // Rotate if over 1MB
    if let Ok(meta) = fs::metadata(&log_path) {
        if meta.len() > 1_000_000 {
            let backup = log_dir.join("snap.log.old");
            let _ = fs::rename(&log_path, &backup);
        }
    }

    let timestamp = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let line = format!("[{}] {}\n", timestamp, msg);
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(line.as_bytes())
        });
}

// ----- Public: generate the invoke handler -----

pub fn invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        capture_screen,
        get_active_window_context,
        save_annotation,
        read_capture_base64,
        mark_overlay_closed,
    ]
}
