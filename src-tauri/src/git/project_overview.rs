//! Small read-only snapshots for the project homepage. No fetch, history, diff
//! contents or background watchers are needed to inspect an added project.
use super::{git_auth_command, local_merge, open_repo_inner, read_git_status, run_blocking, run_git, BehindBranch};
use serde::Serialize;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverviewSummary {
    pub initialized: bool,
    pub has_head: bool,
    pub current_branch: String,
    pub detached: bool,
    pub has_remotes: bool,
    pub upstream: Option<String>,
    pub upstream_remote: bool,
    pub upstream_missing: bool,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub changed_files: usize,
    pub staged_files: usize,
    pub unstaged_files: usize,
    pub conflict_files: usize,
    pub operation: Option<String>,
    pub behind_branches: Vec<BehindBranch>,
    pub checked_at: u64,
}

fn read_overview_refs(path: &str, format: &str, patterns: &[&str]) -> Result<String, String> {
    let mut args = vec!["--no-optional-locks", "for-each-ref", format];
    args.extend_from_slice(patterns);
    let output = git_auth_command(path, &args, None)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .output().map_err(|error| format!("无法执行 git：{error}"))?;
    // Git can skip a malformed ref with a warning and still exit successfully.
    // Do not turn that repository error into a missing upstream or a clean row.
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() || !error.is_empty() {
        return Err(if error.is_empty() { "无法读取分支信息".into() } else { error });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_tracking_counts(track: &str) -> Result<Option<(u32, u32)>, String> {
    if track == "gone" { return Ok(None); }
    if track.is_empty() { return Ok(Some((0, 0))); }
    let (mut ahead, mut behind) = (None, None);
    for part in track.split(", ") {
        let (kind, count) = part.split_once(' ').ok_or("无法读取分支提交数量")?;
        let count = count.parse::<u32>().map_err(|_| "无法读取分支提交数量")?;
        match kind {
            "ahead" if ahead.is_none() => ahead = Some(count),
            "behind" if behind.is_none() => behind = Some(count),
            _ => return Err("无法读取分支提交数量".into()),
        }
    }
    Ok(Some((ahead.unwrap_or(0), behind.unwrap_or(0))))
}

fn compare_refs(path: &str, branch: &str, upstream: &str) -> Result<(u32, u32), String> {
    let comparison = format!("{branch}...{upstream}");
    let output = run_git(path, &["rev-list", "--left-right", "--count", &comparison, "--"])?;
    let counts = output.split_whitespace().map(str::parse::<u32>).collect::<Result<Vec<_>, _>>()
        .map_err(|_| "无法读取分支提交数量".to_string())?;
    if counts.len() != 2 { return Err("无法读取分支提交数量".into()); }
    Ok((counts[0], counts[1]))
}

fn display_ref(reference: &str) -> String {
    reference.trim_start_matches("refs/remotes/").trim_start_matches("refs/heads/").to_string()
}

pub(super) fn project_overview_inner(path: &str) -> Result<ProjectOverviewSummary, String> {
    let info = open_repo_inner(path)?;
    let mut summary = ProjectOverviewSummary {
        initialized: info.initialized,
        has_head: info.has_head,
        detached: info.initialized && info.current_branch == "HEAD",
        current_branch: info.current_branch,
        has_remotes: false,
        upstream: None,
        upstream_remote: false,
        upstream_missing: false,
        ahead: None,
        behind: None,
        changed_files: 0,
        staged_files: 0,
        unstaged_files: 0,
        conflict_files: 0,
        operation: None,
        behind_branches: Vec::new(),
        checked_at: 0,
    };
    if info.initialized {
        let path = info.path.as_str();
        let entries = read_git_status(path, &[])?;
        let (mut changed, mut staged, mut unstaged, mut conflicts) =
            (HashSet::new(), HashSet::new(), HashSet::new(), HashSet::new());
        for entry in &entries {
            changed.insert(&entry.path);
            let conflict = entry.index_status == "U" || entry.work_status == "U"
                || matches!(format!("{}{}", entry.index_status, entry.work_status).as_str(), "AA" | "DD");
            if conflict { conflicts.insert(&entry.path); }
            if !conflict && entry.index_status != " " && entry.index_status != "?" { staged.insert(&entry.path); }
            if conflict || entry.work_status != " " { unstaged.insert(&entry.path); }
        }
        summary.changed_files = changed.len();
        summary.staged_files = staged.len();
        summary.unstaged_files = unstaged.len();
        summary.conflict_files = conflicts.len();
        summary.operation = local_merge::active_operation_kind(path)?.map(str::to_string);
        summary.has_remotes = !run_git(path, &["remote"])?.trim().is_empty();
        // Git computes every tracking comparison in one process. Full ref names
        // avoid ambiguous local/remote names; objecttype also validates local
        // branch tips rather than silently accepting missing commit objects.
        let format = "--format=%(refname)%1f%(upstream)%1f%(HEAD)%1f%(upstream:track,nobracket)%1f%(objecttype)";
        let branches = read_overview_refs(path, format, &["refs/heads"])?;
        let mut rows = Vec::new();
        let mut gone = HashSet::new();
        for line in branches.lines().filter(|line| !line.is_empty()) {
            let fields = line.split('\x1f').collect::<Vec<_>>();
            if fields.len() != 5 || fields[4] != "commit" { return Err("无法读取分支信息".into()); }
            let (branch, upstream, current) = (fields[0], fields[1], fields[2] == "*");
            // An unborn branch has no ref. If a current ref exists but HEAD was
            // unreadable, surface the error instead of reporting an empty repo.
            if current && !summary.has_head { run_git(path, &["rev-parse", "--verify", "HEAD^{commit}"])?; }
            if upstream.is_empty() { continue; }
            let counts = parse_tracking_counts(fields[3])?;
            if counts.is_none() { gone.insert(upstream); }
            rows.push((branch, upstream, current, counts));
        }
        // `gone` can mean a missing ref, an unreadable object, or a tip which
        // cannot be compared as a commit. Validate all such upstreams together;
        // only genuinely missing refs keep an unknown comparison. This extra
        // query is unnecessary for the normal synchronized/ahead/behind paths.
        let mut present_gone = HashSet::new();
        if !gone.is_empty() {
            let patterns = gone.iter().copied().collect::<Vec<_>>();
            let refs = read_overview_refs(path, "--format=%(refname)%1f%(objecttype)", &patterns)?;
            for line in refs.lines().filter(|line| !line.is_empty()) {
                let fields = line.split('\x1f').collect::<Vec<_>>();
                if fields.len() != 2 { return Err("无法读取分支信息".into()); }
                // A missing refs/foo can match refs/foo/bar; only the exact
                // configured upstream is relevant to this branch comparison.
                if gone.contains(fields[0]) { present_gone.insert(fields[0].to_string()); }
            }
        }
        for (branch, upstream, current, counts) in rows {
            let available = counts.is_some() || present_gone.contains(upstream);
            if current {
                summary.upstream = Some(display_ref(upstream));
                summary.upstream_remote = summary.has_remotes && upstream.starts_with("refs/remotes/");
                summary.upstream_missing = !available;
            }
            if !available { continue; }
            // A valid tip may have appeared during the snapshot; uncommon gone
            // cases use the strict existing comparison rather than guessing.
            let (ahead, behind) = match counts {
                Some(counts) => counts,
                None => compare_refs(path, branch, upstream)?,
            };
            if current { summary.ahead = Some(ahead); summary.behind = Some(behind); }
            if behind > 0 {
                summary.behind_branches.push(BehindBranch {
                    name: display_ref(branch), upstream: display_ref(upstream), ahead, behind, current,
                });
            }
        }
    }
    summary.checked_at = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|error| format!("无法读取检查时间：{error}"))?.as_millis() as u64;
    Ok(summary)
}

#[tauri::command]
pub async fn git_project_overview(path: String) -> Result<ProjectOverviewSummary, String> {
    run_blocking(move || project_overview_inner(&path)).await
}

#[cfg(test)]
#[path = "project_overview_tests.rs"]
mod tests;
