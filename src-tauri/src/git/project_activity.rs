//! Commit metadata for the workbench activity calendar. Reads local refs only;
//! fetching, patches and graph presentation metadata are deliberately unnecessary.
use super::{git_auth_command, run_blocking};
use serde::Serialize;
use std::collections::HashSet;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActivityCommit {
    pub oid: String,
    pub committed_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActivitySummary {
    pub commits: Vec<ProjectActivityCommit>,
    pub checked_at: u64,
}

fn activity_command(path: &str, args: &[&str]) -> Command {
    let mut command = git_auth_command(path, args, None);
    command.env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1");
    command
}

fn activity_read(path: &str, args: &[&str]) -> Result<String, String> {
    let output = activity_command(path, args).output()
        .map_err(|error| format!("无法执行 git：{error}"))?;
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() || !error.is_empty() {
        return Err(if error.is_empty() { "无法读取提交活动".into() } else { error });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

struct ActivityRepository { path: String, head: Option<String> }

fn activity_repository(path: &str) -> Result<Option<ActivityRepository>, String> {
    // Match open_repo_inner's plain-folder/error distinction, with lazy object
    // fetching disabled for every probe, including HEAD verification.
    let directory = std::path::Path::new(path).canonicalize()
        .map_err(|error| format!("无法访问项目目录：{error}"))?;
    if !directory.is_dir() { return Err("请选择一个项目文件夹".into()); }
    let path = directory.to_string_lossy().to_string();
    let probe = activity_command(&path, &["rev-parse", "--is-inside-work-tree"]).output()
        .map_err(|error| format!("无法执行 git：{error}"))?;
    if !probe.status.success() {
        let error = String::from_utf8_lossy(&probe.stderr).trim().to_string();
        let has_metadata = directory.ancestors().any(|parent| parent.join(".git").symlink_metadata().is_ok());
        if !error.contains("not a git repository") || has_metadata {
            return Err(if error.is_empty() { "无法读取提交活动".into() } else { error });
        }
        return Ok(None);
    }
    if String::from_utf8_lossy(&probe.stdout).trim() != "true" {
        return Err("该目录不是一个 Git 仓库".into());
    }
    let path = activity_read(&path, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let branch = activity_read(&path, &["branch", "--show-current"])?;
    let head = activity_command(&path, &["rev-parse", "--verify", "HEAD^{commit}"]).output()
        .map_err(|error| format!("无法执行 git：{error}"))?;
    let head = if head.status.success() {
        // A tag named HEAD may generate an ambiguity warning, while Git still
        // resolves the real HEAD. Pass its OID to log to avoid that ambiguity.
        Some(String::from_utf8_lossy(&head.stdout).trim().to_string())
    } else if branch.trim().is_empty() {
        // A detached HEAD without a valid commit is corruption, not an unborn branch.
        let error = String::from_utf8_lossy(&head.stderr).trim().to_string();
        return Err(if error.is_empty() { "无法读取提交活动".into() } else { error });
    } else {
        None
    };
    Ok(Some(ActivityRepository { path, head }))
}

fn unsupported_since_filter(error: &str) -> bool {
    error.lines().any(|line| {
        line.contains("unrecognized argument: --since-as-filter")
            || (line.contains("since-as-filter")
                && (line.contains("unknown option") || line.contains("unrecognized option")))
    })
}

fn activity_log(path: &str, from_timestamp: i64, head: Option<&str>) -> Result<String, String> {
    // Unlike --since, --since-as-filter walks past older commits so ancestors
    // with newer committer dates remain visible. Use an unambiguous UTC date:
    // Git's approximate date parser mishandles some short @epoch expressions.
    let since = chrono::DateTime::from_timestamp(from_timestamp, 0)
        .map(|date| format!("--since-as-filter={}", date.to_rfc3339()));
    let mut filter = since.as_deref();
    loop {
        let mut args = vec![
            "--no-optional-locks", "log", "--format=%H%x09%ct", "--no-patch",
            "--no-color", "--no-decorate", "--no-show-signature",
            "--branches", "--remotes", "--tags",
        ];
        if let Some(head) = head { args.push(head); }
        if let Some(since) = filter { args.push(since); }
        args.push("--");
        let output = activity_command(path, &args).output()
            .map_err(|error| format!("无法执行 git：{error}"))?;
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !output.status.success() && filter.is_some() && unsupported_since_filter(&error) {
            filter = None;
            continue;
        }
        // Broken refs can produce warnings with exit status zero. A partial
        // calendar must not silently look like a successfully read repository.
        if !output.status.success() || !error.is_empty() {
            return Err(if error.is_empty() { "无法读取提交活动".into() } else { error });
        }
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
}

fn parse_activity(output: &str, from_timestamp: i64, to_timestamp: i64) -> Result<Vec<ProjectActivityCommit>, String> {
    let mut commits = Vec::new();
    let mut seen = HashSet::new();
    for line in output.lines() {
        let (oid, date) = line.split_once('\t').ok_or("无法读取提交活动")?;
        if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("无法读取提交活动".into());
        }
        let committed_at = date.parse::<i64>().map_err(|_| "无法读取提交活动")?;
        if committed_at >= from_timestamp && committed_at < to_timestamp && seen.insert(oid) {
            commits.push(ProjectActivityCommit { oid: oid.to_string(), committed_at });
        }
    }
    Ok(commits)
}

pub(super) fn project_activity_inner(path: &str, from_timestamp: i64, to_timestamp: i64) -> Result<ProjectActivitySummary, String> {
    if from_timestamp >= to_timestamp { return Err("提交活动时间范围无效".into()); }
    let commits = if let Some(repo) = activity_repository(path)? {
        parse_activity(&activity_log(&repo.path, from_timestamp, repo.head.as_deref())?, from_timestamp, to_timestamp)?
    } else {
        Vec::new()
    };
    let checked_at = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|error| format!("无法读取检查时间：{error}"))?.as_millis() as u64;
    Ok(ProjectActivitySummary { commits, checked_at })
}

/// All authors, by committer timestamp, over local heads/remotes/tags and HEAD.
/// The start is inclusive and the end exclusive. OIDs are full and unique per
/// repository; callers can deduplicate clones and worktrees across projects.
#[tauri::command]
pub async fn git_project_activity(path: String, from_timestamp: i64, to_timestamp: i64) -> Result<ProjectActivitySummary, String> {
    run_blocking(move || project_activity_inner(&path, from_timestamp, to_timestamp)).await
}

#[cfg(test)]
#[path = "project_activity_tests.rs"]
mod tests;
