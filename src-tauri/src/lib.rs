// Desktop shell. The frontend is the same dist/ the PWA serves; this process
// only supplies the file plugins the browser backend cannot provide with the
// same guarantees.

/// The document a double-click launched us with, if any. Reading argv is the
/// whole of Windows file-association handling.
///
/// Mirrors the frontend's isDocumentName: the two current extensions, which are
/// also the only ones registered as associations, plus the legacy pair so a
/// document from an older semester still opens.
const DOC_EXTS: [&str; 4] = [".lcirb", ".lcirc", ".board.json", ".chip.json"];

#[tauri::command]
fn launch_file() -> Option<String> {
    std::env::args().skip(1).find(|a| {
        let lower = a.to_lowercase();
        !a.starts_with('-') && DOC_EXTS.iter().any(|e| lower.ends_with(e))
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![launch_file])
        // persisted-scope must be registered after fs/dialog: it restores the
        // scopes those plugins granted in an earlier run.
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // A WebView has no tabs to open into, so window.open cannot send the
        // reporter to the screenshot form. Scoped to that one host.
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Logicuitry");
}
