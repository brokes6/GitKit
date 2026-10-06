//! Read-only sidebar counts. This deliberately skips HEAD validation, refs,
//! upstream comparisons, operations and the staging snapshot cache.
use super::{git_auth_command, read_git_status, run_blocking, run_git};
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusSummary {
    pub initialized: bool,
    pub current_branch: String,
    pub changed_files: usize,
    pub checked_at: u64,
}

/// Shared with watcher creation so plain folders can be watched without being
/// initialized, while broken metadata and inaccessible folders remain errors.
pub(super) fn probe_project_directory(path: &str) -> Result<(PathBuf, bool), String> {
    let directory = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("无法访问项目目录：{error}"))?;
    if !directory.is_dir() {
        return Err("请选择一个项目文件夹".into());
    }
    let probe = git_auth_command(
        &directory.to_string_lossy(),
        &[
            "--no-optional-locks",
            "rev-parse",
            "--is-inside-work-tree",
            "--show-toplevel",
        ],
        None,
    )
    .env("LC_ALL", "C")
    .output()
    .map_err(|error| format!("无法执行 git：{error}"))?;
    if !probe.status.success() {
        let error = String::from_utf8_lossy(&probe.stderr).trim().to_string();
        let has_metadata = directory
            .ancestors()
            .any(|parent| parent.join(".git").symlink_metadata().is_ok());
        if error.contains("not a git repository") && !has_metadata {
            return Ok((directory, false));
        }
        return Err(if error.is_empty() {
            "git 命令失败".into()
        } else {
            error
        });
    }
    let output = String::from_utf8_lossy(&probe.stdout);
    let Some(top) = output.strip_prefix("true\n") else {
        return Err("该目录不是一个 Git 仓库".into());
    };
    let root = PathBuf::from(top.trim_end_matches(['\r', '\n']));
    if !root.is_absolute() || !root.is_dir() {
        return Err("无法读取项目目录".into());
    }
    Ok((root, true))
}

pub(super) fn project_status_inner(path: &str) -> Result<ProjectStatusSummary, String> {
    let (directory, initialized) = probe_project_directory(path)?;
    let (current_branch, changed_files) = if initialized {
        let path = directory.to_string_lossy();
        let current = run_git(&path, &["--no-optional-locks", "branch", "--show-current"])?;
        let current = current.trim().to_string();
        let paths: HashSet<String> = read_git_status(&path, &[])?
            .into_iter()
            .map(|entry| entry.path)
            .collect();
        (
            if current.is_empty() {
                "HEAD".into()
            } else {
                current
            },
            paths.len(),
        )
    } else {
        (String::new(), 0)
    };
    Ok(ProjectStatusSummary {
        initialized,
        current_branch,
        changed_files,
        checked_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    })
}

#[tauri::command]
pub async fn git_project_status_summary(path: String) -> Result<ProjectStatusSummary, String> {
    run_blocking(move || project_status_inner(&path)).await
}

#[cfg(test)]
#[path = "project_status_tests.rs"]
mod tests;
