mod git;

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

/// Toggle the macOS vibrancy (frosted-glass) material on the main window at
/// runtime. No-op on non-macOS. The window must be transparent
/// (`app.macOSPrivateApi` + `transparent: true` in tauri.conf.json) for the
/// blur to show.
#[tauri::command]
fn set_vibrancy(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if enabled {
            apply_vibrancy(
                &window,
                NSVisualEffectMaterial::Sidebar,
                Some(NSVisualEffectState::Active),
                None,
            )
            .map_err(|e| e.to_string())?;
        } else {
            clear_vibrancy(&window).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, enabled);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(git::WatchState::default())
        .manage(git::CancelState::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Desktop-only plugins: window-state remembers window geometry
            // across launches; updater + process power in-app auto-update.
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_window_state::Builder::default().build())?;
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            // Frosted-glass vibrancy on the main window (macOS only).
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::Sidebar,
                        Some(NSVisualEffectState::Active),
                        None,
                    );
                }
            }
            // Windows has no equivalent of macOS's Overlay title bar, so drop the
            // native decorations and let the app draw its own immersive top bar +
            // window controls (see WindowControls in the frontend).
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            git::open_repo,
            git::reveal_in_file_manager,
            git::git_branches,
            git::git_remotes,
            git::git_log,
            git::git_status,
            git::git_status_paths,
            git::commit_files,
            git::commit_file_diff,
            git::working_file_diff,
            git::file_preview,
            git::git_has_changes,
            git::git_discard_file,
            git::git_discard_all,
            git::check_deps,
            git::git_checkout,
            git::git_stash_push,
            git::git_stash_list,
            git::git_stash_apply,
            git::git_stash_drop,
            git::git_stash_files,
            git::git_stash_file_diff,
            git::git_merge_preview,
            git::git_cherry_pick,
            git::git_cherry_pick_preflight,
            git::git_create_branch,
            git::git_delete_branch,
            git::git_rename_branch,
            git::git_remove_worktree,
            git::git_tags,
            git::git_create_tag,
            git::git_push_tag,
            git::git_checkout_sync,
            git::git_commit,
            git::git_fetch,
            git::git_check_updates,
            git::git_sync_local,
            git::git_pull,
            git::git_push,
            git::git_cancel,
            git::gitlab_test,
            git::github_test,
            git::create_pull_request,
            git::github_create_repo,
            git::git_remote_add,
            git::git_clone,
            git::start_watch,
            git::stop_watch,
            set_vibrancy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitKit");
}
