#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

/// Payload sent to the UI when a drawing is opened from the OS
/// (double-click, "Open with", or a file argument on launch). Text formats
/// (DXF, SVG) use `text`; DWG is binary, so it's base64-encoded into
/// `base64` instead — see apps/web/src/dxf/desktopBridge.ts.
#[derive(serde::Serialize, Clone)]
struct OpenFile {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base64: Option<String>,
    /// The file's containing folder, so the UI can offer the in-app file
    /// browser (R9) pre-loaded with its sibling drawings.
    dir: String,
}

/// Reads a `.dxf`, `.svg`, or `.dwg` file and forwards its content to the
/// web UI, which loads it onto the canvas. The event name selects how the UI
/// interprets it. Reading in Rust avoids needing filesystem permissions in
/// the frontend.
fn emit_file(app: &AppHandle, path: &str) {
    let lower = path.to_lowercase();
    let (event, is_binary) = if lower.ends_with(".dxf") {
        ("open-dxf", false)
    } else if lower.ends_with(".svg") {
        ("open-svg", false)
    } else if lower.ends_with(".dwg") {
        ("open-dwg", true)
    } else {
        return;
    };

    let p = Path::new(path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "drawing".to_string());
    let dir = p
        .parent()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default();

    if is_binary {
        if let Ok(bytes) = std::fs::read(path) {
            let base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
            let _ = app.emit(
                event,
                OpenFile { name, text: None, base64: Some(base64), dir },
            );
        }
    } else if let Ok(text) = std::fs::read_to_string(path) {
        let _ = app.emit(
            event,
            OpenFile { name, text: Some(text), base64: None, dir },
        );
    }
}

fn first_drawing_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| {
            let l = a.to_lowercase();
            l.ends_with(".dxf") || l.ends_with(".svg") || l.ends_with(".dwg")
        })
        .cloned()
}

/// A drawing file found by `list_drawings_in_dir`, listed in the in-app file
/// browser (R9).
#[derive(serde::Serialize)]
struct DrawingEntry {
    name: String,
    path: String,
}

/// Lists `.dxf`/`.svg` files directly inside `dir` (non-recursive), for
/// the in-app file browser's left-dock panel. Reads no file contents —
/// those are fetched on demand per visible card via `read_drawing_file`.
/// DWG isn't listed here — it's binary and import-only, opened via the Open
/// dialog or file association instead of the folder-browser grid.
#[tauri::command]
fn list_drawings_in_dir(dir: String) -> Result<Vec<DrawingEntry>, String> {
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let lower = path.to_string_lossy().to_lowercase();
        if !(lower.ends_with(".dxf") || lower.ends_with(".svg")) {
            continue;
        }
        let name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        out.push(DrawingEntry {
            name,
            path: path.to_string_lossy().to_string(),
        });
    }
    Ok(out)
}

/// Reads one drawing file's text content by full path, for rendering its
/// thumbnail or opening it into a tab. Kept separate from the directory
/// listing so a folder of hundreds of files doesn't read them all upfront.
#[tauri::command]
fn read_drawing_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        // Opens URLs (the update notifier's "download page" action).
        .plugin(tauri_plugin_opener::init())
        // A second launch (e.g. double-clicking another .dxf) forwards its
        // argv to the already-running window instead of opening a new one.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = first_drawing_arg(&argv) {
                emit_file(app, &path);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            list_drawings_in_dir,
            read_drawing_file
        ])
        .setup(|app| {
            // Handle a file passed on the initial launch.
            if let Some(path) = first_drawing_arg(&std::env::args().collect::<Vec<_>>()) {
                let handle = app.handle().clone();
                // Give the webview a moment to register its event listener.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    emit_file(&handle, &path);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Sketchor");
}
