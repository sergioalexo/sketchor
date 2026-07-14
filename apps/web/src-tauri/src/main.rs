#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

/// Payload sent to the UI when a .dxf is opened from the OS
/// (double-click, "Open with", or a file argument on launch).
#[derive(serde::Serialize, Clone)]
struct OpenDxf {
    name: String,
    text: String,
}

/// Reads a .dxf file and forwards its content to the web UI, which loads
/// it onto the canvas and into the library. Reading in Rust avoids needing
/// filesystem permissions in the frontend.
fn emit_dxf(app: &AppHandle, path: &str) {
    if !path.to_lowercase().ends_with(".dxf") {
        return;
    }
    if let Ok(text) = std::fs::read_to_string(path) {
        let name = Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "drawing.dxf".to_string());
        let _ = app.emit("open-dxf", OpenDxf { name, text });
    }
}

fn first_dxf_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| a.to_lowercase().ends_with(".dxf"))
        .cloned()
}

fn main() {
    let builder = tauri::Builder::default();

    // In-app updates from GitHub releases (desktop only). `plugin-process`
    // supplies the relaunch the frontend calls after installing.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        // A second launch (e.g. double-clicking another .dxf) forwards its
        // argv to the already-running window instead of opening a new one.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = first_dxf_arg(&argv) {
                emit_dxf(app, &path);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .setup(|app| {
            // Handle a file passed on the initial launch.
            if let Some(path) = first_dxf_arg(&std::env::args().collect::<Vec<_>>()) {
                let handle = app.handle().clone();
                // Give the webview a moment to register its event listener.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    emit_dxf(&handle, &path);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Sketchor");
}
