use crate::search::announce_files;
use crate::slow::run_one;
use crate::state::{locked, vault_of, within_vault};
use crate::tasks::{off_thread, wait_for_picker};
use crate::tree::{list_folder as list_one_folder, FileEntry, PATIENCE};
use crate::watcher::watch_vault;
use std::path::Path;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[derive(serde::Serialize)]
pub(crate) struct OpenedFolder {
    pub(crate) path: String,
    pub(crate) entries: Vec<FileEntry>,
}

/// Takes a folder on as the open one: reads what is directly in it, and sets the
/// boundary every other command is held to. Only the top level is read - a
/// folder deeper in is read when it is opened - so a very large vault opens as
/// fast as a small one, and a folder's contents are not sent across the bridge
/// until somebody asks to see them. The whole vault is read in the background
/// into the index, which is what search and quick-open use.
pub(crate) fn adopt_folder<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    path: String,
) -> Result<OpenedFolder, String> {
    let directory = Path::new(&path);
    if !directory.is_dir() {
        return Err(format!("\"{}\" is not there any more", path));
    }

    // Resolved here so that every later check is a comparison between two
    // paths the OS has already agreed on.
    let resolved = directory.canonicalize().map_err(|e| e.to_string())?;

    // Read before anything is moved. This is the one step here that can fail
    // for a folder that `is_dir` was happy with - a directory that can be
    // entered but not listed, or one on a mount that stops answering - and
    // everything below it is a change to the window that nothing undoes.
    //
    // Done the other way round, a switch that failed left the boundary on the
    // folder that could not be read while the frontend went on showing the one
    // it had: every open tab's autosave was then refused for being "outside
    // the open folder", with the edits still in the editor and nothing on
    // screen saying why.
    let entries = list_one_folder(directory, &resolved, &resolved)?;

    // Past here the window belongs to the new folder. The one place the
    // boundary is set.
    {
        let vault = vault_of(window);
        *locked(&vault.root) = Some(resolved.clone());
        // The notes of the folder being left are no longer anything to be out
        // of date with.
        locked(&vault.known).clear();
    }

    // Started over before the watcher is, so that what the watcher reports
    // while the walk is under way is held for it rather than lost.
    let index = vault_of(window).index.clone();
    let generation = index.reset(directory, &resolved);

    // A folder that cannot be watched is still a folder worth opening; what is
    // lost is the notice, not the vault.
    if let Err(error) = watch_vault(window, &resolved) {
        log::warn!("not watching \"{}\" for changes: {}", path, error);
    }

    let announced = window.clone();
    index.build_in_background(generation, move || announce_files(&announced, true));

    Ok(OpenedFolder { path, entries })
}

/// Opens a native "open folder" dialog and returns the folder's path plus what
/// is directly in it. Returns `None` if the user cancels.
#[tauri::command]
pub(crate) async fn load_folder_picker(
    window: tauri::WebviewWindow,
) -> Result<Option<OpenedFolder>, String> {
    let scope = window.clone();
    wait_for_picker(|send| {
        window.dialog().file().pick_folder(move |folder_path| {
            let result = match folder_path {
                Some(path) => adopt_folder(&scope, path.to_string()).map(Some),
                None => Ok(None),
            };
            if matches!(result, Ok(Some(_))) {
                crate::multiwindow::changed(scope.app_handle());
            }
            send(result);
        });
    })
    .await
}

/// Reopens a folder the app already knows about, without asking for it again.
#[tauri::command]
pub(crate) async fn open_folder(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<OpenedFolder, String> {
    off_thread(move || {
        let opened = adopt_folder(&window, path)?;
        // Which folders are open is what comes back next time, and what the
        // Window menu lists.
        crate::multiwindow::changed(window.app_handle());
        Ok(opened)
    })
    .await
}

/// What is directly inside a folder of the open vault, for the sidebar to fill
/// in when the folder is opened. A folder that does not answer in time is an
/// error the sidebar shows on the folder, and can try again.
#[tauri::command]
pub(crate) async fn list_folder(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    off_thread(move || {
        // Resolving the path is a read of the filesystem like any other, and
        // gets no more time than listing the folder does.
        let listed = run_one(
            move || {
                let vault = vault_of(&window);
                let here = within_vault(&vault, std::path::Path::new(&path))?;
                if !here.is_dir() {
                    return Err(format!("\"{}\" is not a folder", path));
                }
                let root = locked(&vault.root)
                    .clone()
                    .ok_or_else(|| "No folder is open".to_string())?;
                list_one_folder(std::path::Path::new(&path), &here, &root)
            },
            PATIENCE.listing + PATIENCE.entry,
        );
        listed.unwrap_or_else(|| Err("That folder is not available right now".to_string()))
    })
    .await
}
