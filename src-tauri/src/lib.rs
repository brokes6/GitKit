mod git;
mod daily_check;
mod github_token;
mod merge_requests;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(git::WatchState::default())
        .manage(git::CancelState::default())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            use tauri::Manager;
            if window.label() != "main" { return; }
            let background = matches!(event, tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Destroyed)
                || (matches!(event, tauri::WindowEvent::Resized(_))
                    && (window.is_minimized().unwrap_or(true) || !window.is_visible().unwrap_or(false)));
            if background { git::suspend_project_watches(window.app_handle()); }
        })
        .setup(|app| {
            daily_check::setup(app.handle())?;
            merge_requests::setup(app.handle())?;
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
            merge_requests::mr_snapshot,
            merge_requests::mr_configure,
            merge_requests::mr_visibility,
            merge_requests::mr_refresh,
            merge_requests::mr_mark_viewed,
            merge_requests::mr_detail,
            merge_requests::mr_commit_messages,
            merge_requests::mr_diffs,
            merge_requests::mr_download_diff,
            merge_requests::mr_discussions,
            merge_requests::mr_create_diff_comment,
            merge_requests::mr_merge,
            merge_requests::mr_close,
            merge_requests::mr_approve,
            merge_requests::mr_open,
            daily_check::daily_check_snapshot,
            daily_check::daily_check_configure,
            daily_check::daily_check_set_busy,
            daily_check::daily_check_mark_viewed,
            daily_check::daily_check_now,
            git::open_repo,
            git::project_overview::git_project_overview,
            git::project_status::git_project_status_summary,
            git::project_activity::git_project_activity,
            git::git_init,
            git::reveal_in_file_manager,
            git::open_repository_remote,
            git::open_provider_token_settings,
            git::git_branches,
            git::git_remotes,
            git::git_log,
            git::git_status,
            git::git_status_paths,
            git::git_staging_status,
            git::git_stage_files,
            git::git_unstage_files,
            git::commit_files,
            git::commit_file_diff,
            git::git_file_content,
            git::file_trace::file_history,
            git::file_trace::file_trace_diff,
            git::file_trace::file_blame,
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
            git::local_merge::git_local_merge_preview,
            git::local_merge::git_local_merge,
            git::local_merge::git_operation_state,
            git::local_merge::git_merge_continue,
            git::local_merge::git_merge_abort,
            git::local_merge::git_merge_tool,
            git::local_merge::git_cherry_pick_continue,
            git::local_merge::git_cherry_pick_abort,
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
            git::git_undo_commit_preview,
            git::git_undo_last_commit,
            git::git_fetch,
            git::git_check_updates,
            git::git_sync_local,
            daily_check::daily_check_reconcile,
            git::git_pull,
            git::git_push,
            git::git_force_push_target,
            git::git_force_push_preview,
            git::git_force_push,
            git::git_cancel,
            git::gitlab_test,
            git::gitlab_token_info,
            git::github_test,
            github_token::github_token_info,
            git::create_pull_request,
            git::github_create_repo,
            git::gitlab_create_repo,
            git::git_remote_add,
            git::git_clone,
            git::start_watch,
            git::stop_watch,
            git::project_watch_configure,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitKit");
}
