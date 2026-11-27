use super::{local_merge, run_blocking, run_git, run_git_nohooks, with_staging_lock};
use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreation {
    pub name: String,
    pub head: String,
    pub switch_to: Option<String>,
}

/// Equal branch tips alone don't prove a branch is new. A commit, reset, or
/// fast-forward replaces the creation entry at the tip of the branch reflog.
pub(super) fn created_from(path: &str, name: &str, head: &str) -> Option<String> {
    let reference = format!("refs/heads/{name}");
    let log = run_git(
        path,
        &[
            "reflog",
            "show",
            "-1",
            "--no-show-signature",
            "--format=%H%x09%gs",
            &reference,
            "--",
        ],
    )
    .ok()?;
    let (oid, message) = log.trim_end().split_once('\t')?;
    if oid != head {
        return None;
    }
    Some(message.strip_prefix("branch: Created from ")?.to_string())
}

// Match the reachability check git branch -d will perform after switching:
// the configured upstream, or the proposed checkout when there is no upstream.
fn merged_after_switch(path: &str, head: &str, target: &str) -> bool {
    let merge_into = run_git(
        path,
        &[
            "rev-parse",
            "--verify",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .unwrap_or_else(|_| format!("refs/heads/{target}"));
    run_git(
        path,
        &["merge-base", "--is-ancestor", head, merge_into.trim()],
    )
    .is_ok()
}

fn return_branch(path: &str, name: &str, head: &str, start: &str) -> Option<String> {
    let base = start.strip_prefix("refs/heads/").unwrap_or(start);
    let previous = run_git(
        path,
        &["rev-parse", "--verify", "--symbolic-full-name", "@{-1}"],
    )
    .ok();
    let previous = previous
        .as_deref()
        .and_then(|s| s.trim().strip_prefix("refs/heads/"))
        .filter(|&s| s != name);
    if let Some(previous) = previous {
        if previous == base || merged_after_switch(path, head, previous) {
            return Some(previous.to_string());
        }
    }
    // A different local base may contain commits the previous checkout does
    // not. Returning to that base lets Git keep its normal safe-delete check.
    if base != name
        && run_git(
            path,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{base}"),
            ],
        )
        .is_ok()
    {
        return Some(base.to_string());
    }
    previous.map(str::to_string)
}

pub(super) fn preview(path: &str, name: &str, head: &str, current: bool) -> Option<BranchCreation> {
    let start = created_from(path, name, head)?;
    let switch_to = if current {
        Some(return_branch(path, name, head, &start)?)
    } else {
        None
    };
    Some(BranchCreation {
        name: name.into(),
        head: head.into(),
        switch_to,
    })
}

fn inspect(path: &str, name: &str) -> Result<Option<BranchCreation>, String> {
    let head = run_git(
        path,
        &[
            "show-ref",
            "--verify",
            "--hash",
            &format!("refs/heads/{name}"),
        ],
    )?;
    let current = run_git(path, &["branch", "--show-current"])?;
    Ok(preview(path, name, head.trim(), current.trim() == name))
}

#[tauri::command]
pub async fn git_branch_creation_preview(
    path: String,
    name: String,
) -> Result<Option<BranchCreation>, String> {
    run_blocking(move || inspect(&path, &name)).await
}

pub(super) fn undo(path: &str, expected: &BranchCreation) -> Result<(), String> {
    local_merge::ensure_no_operation(path)?;
    if inspect(path, &expected.name)?.as_ref() != Some(expected) {
        return Err("分支状态已变化，请重新检查后再撤回创建".into());
    }
    if let Some(target) = &expected.switch_to {
        if !merged_after_switch(path, &expected.head, target) {
            return Err("创建时的提交尚未合入目标分支或上游，已保留本地分支".into());
        }
        run_git_nohooks(
            path,
            &[
                "switch",
                "--no-guess",
                "--no-overwrite-ignore",
                "--",
                target,
            ],
        )?;
    }
    // Keep Git's merge and linked-worktree protections. Recheck the tip after
    // switching too, since another Git client can move it during checkout.
    let reference = format!("refs/heads/{}", expected.name);
    let delete = || {
        if run_git(path, &["show-ref", "--verify", "--hash", &reference])?.trim() != expected.head {
            return Err("分支状态已变化，请重新检查后再撤回创建".into());
        }
        run_git(path, &["branch", "-d", "--", &expected.name])
    };
    if let Err(error) = delete() {
        return Err(match &expected.switch_to {
            Some(target) => format!("已切换到 {target}，但删除本地分支失败：{error}"),
            None => error,
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn git_undo_branch_creation(
    path: String,
    expected: BranchCreation,
) -> Result<(), String> {
    run_blocking(move || with_staging_lock(&path, || undo(&path, &expected))).await
}
