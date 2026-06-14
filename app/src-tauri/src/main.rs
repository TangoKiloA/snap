// Prevents a console window from appearing in release builds on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

struct SingleInstanceGuard {
    path: PathBuf,
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn is_process_running(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(handle) => {
                    let mut exit_code = 0u32;
                    let alive = GetExitCodeProcess(handle, &mut exit_code).is_ok()
                        && exit_code == 259; // STILL_ACTIVE
                    let _ = CloseHandle(handle);
                    alive
                }
                Err(_) => false,
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    false
}

fn try_acquire_single_instance() -> Result<SingleInstanceGuard, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let snap_dir = home.join(".snap");
    fs::create_dir_all(&snap_dir).map_err(|e| format!("Failed to create ~/.snap: {}", e))?;

    let lock_path = snap_dir.join("snap-tray.lock");

    loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                let _ = writeln!(file, "{}", std::process::id());
                return Ok(SingleInstanceGuard { path: lock_path });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::read_to_string(&lock_path)
                    .ok()
                    .and_then(|s| s.trim().parse::<u32>().ok())
                    .map(|pid| !is_process_running(pid))
                    .unwrap_or(true); // unreadable or unparseable → treat as stale

                if !stale {
                    return Err("another instance is already running".to_string());
                }

                snap_lib::log_event("removing stale lock file");
                let _ = fs::remove_file(&lock_path);
                // loop to retry
            }
            Err(e) => return Err(format!("failed to create lock file: {}", e)),
        }
    }
}

fn main() {
    run_tray_mode();
}

fn run_tray_mode() {
    use std::sync::atomic::Ordering;
    use tauri::{
        image::Image,
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
        Manager,
    };
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let _instance_guard = match try_acquire_single_instance() {
        Ok(guard) => guard,
        Err(e) => {
            snap_lib::log_event(&format!("tray start skipped: {}", e));
            return;
        }
    };

    snap_lib::log_event("snap starting (tray mode)");

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(snap_lib::invoke_handler())
        .setup(|app| {
            // ---- System tray ----
            let open_logs =
                MenuItem::with_id(app, "open_logs", "Open Logs", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Snap", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_logs, &quit])?;

            let icon = {
                let png_bytes = include_bytes!("../icons/icon.png");
                let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
                match decoder.read_info() {
                    Ok(mut reader) => {
                        let mut buf = vec![0u8; reader.output_buffer_size()];
                        if let Ok(info) = reader.next_frame(&mut buf) {
                            buf.truncate(info.buffer_size());
                            Image::new_owned(buf, info.width, info.height)
                        } else {
                            Image::new_owned(vec![255u8, 255, 255, 200], 1, 1)
                        }
                    }
                    Err(_) => Image::new_owned(vec![255u8, 255, 255, 200], 1, 1),
                }
            };

            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Snap \u{2014} Ctrl+Shift+S to annotate")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id() == "open_logs" {
                        // Open the .snap folder in Windows Explorer
                        let snap_dir = dirs::home_dir()
                            .map(|h| h.join(".snap"))
                            .unwrap_or_else(|| std::env::temp_dir());
                        let _ = std::process::Command::new("explorer")
                            .arg(&snap_dir)
                            .spawn();
                        return;
                    }

                    if event.id() == "quit" {
                        snap_lib::log_event("quit from tray");
                        app.exit(0);
                    }
                })
                .build(app)?;

            // ---- Global shortcut (Ctrl+Shift+S) ----
            let shortcut =
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyS);

            let app_handle = app.handle().clone();

            app.global_shortcut().on_shortcut(
                shortcut,
                move |_app, _shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }

                    if snap_lib::OVERLAY_ACTIVE.load(Ordering::SeqCst) {
                        return;
                    }
                    snap_lib::OVERLAY_ACTIVE.store(true, Ordering::SeqCst);

                    snap_lib::log_event("hotkey triggered");

                    let handle = app_handle.clone();
                    std::thread::spawn(move || {
                        // Brief delay so the overlay doesn't capture itself
                        std::thread::sleep(std::time::Duration::from_millis(50));

                        // Snapshot the foreground window before we take over the screen
                        snap_lib::capture_and_store_window_context();

                        let handle_inner = handle.clone();
                        let dispatch_result = handle.run_on_main_thread(move || {
                            // Destroy any stale overlay window before creating a fresh one
                            if let Some(window) = handle_inner.get_webview_window("overlay") {
                                let _ = window.destroy();
                            }

                            let builder = tauri::WebviewWindowBuilder::new(
                                &handle_inner,
                                "overlay",
                                tauri::WebviewUrl::App("index.html".into()),
                            )
                            .title("Snap")
                            .decorations(false)
                            .always_on_top(true)
                            .skip_taskbar(true)
                            .resizable(false)
                            .visible(false)
                            .transparent(true)
                            .fullscreen(true);

                            match builder.build() {
                                Ok(_) => snap_lib::log_event("overlay window created"),
                                Err(e) => {
                                    snap_lib::log_event(&format!(
                                        "failed to create overlay: {}",
                                        e
                                    ));
                                    snap_lib::OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
                                }
                            }
                        });

                        if let Err(e) = dispatch_result {
                            snap_lib::log_event(&format!(
                                "failed to schedule overlay creation on main thread: {}",
                                e
                            ));
                            snap_lib::OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
                        }
                    });
                },
            )?;

            snap_lib::log_event("global shortcut registered: Ctrl+Shift+S");
            snap_lib::log_event("snap ready — waiting for hotkey");

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build app")
        .run(|_app, event| {
            // Keep the process alive when no windows are open (tray-only mode)
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}
