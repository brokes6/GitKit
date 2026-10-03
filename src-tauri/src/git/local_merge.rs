//! Merge and cherry-pick recovery use Git's on-disk operation state, including
//! linked worktrees and operations started in a terminal.
use super::{git_auth_command, launch_kaleidoscope_mergetool, read_git_status, run_blocking,
    run_git, staging_revision, with_staging_lock, StatusEntry};
use super::snapshot_hash::SnapshotHasher;
use serde::Serialize;
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

const OPERATION_PATHS: &[&str] = &[
    "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "MERGE_AUTOSTASH", "CHERRY_PICK_HEAD",
    "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "ORIG_HEAD",
];

pub(super) fn is_operation_metadata(name: &OsStr) -> bool {
    OPERATION_PATHS.iter().any(|candidate| name == *candidate)
}

struct OperationPaths { git_dir: PathBuf }

impl OperationPaths {
    fn resolve(path: &str) -> Result<Self, String> {
        let value = run_git(path, &["rev-parse", "--absolute-git-dir"])?;
        Ok(Self { git_dir: PathBuf::from(value.trim()) })
    }

    fn get(&self, name: &str) -> PathBuf {
        // Operation files (including ORIG_HEAD and sequencer) belong to this
        // worktree's git-dir, never the shared common-dir. Resolve once rather
        // than starting a rev-parse process for every file in each snapshot.
        self.git_dir.join(name)
    }
}

fn git_path(path: &str, name: &str) -> Result<PathBuf, String> {
    Ok(OperationPaths::resolve(path)?.get(name))
}

pub(super) fn active_operation_kind(path: &str) -> Result<Option<&'static str>, String> {
    operation_kind_at(&OperationPaths::resolve(path)?)
}

fn operation_kind_at(paths: &OperationPaths) -> Result<Option<&'static str>, String> {
    // Rebase can temporarily create CHERRY_PICK_HEAD; report the outer operation.
    for (name, kind) in [
        ("rebase-merge", "rebase"), ("rebase-apply", "rebase"), ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert"),
    ] {
        if paths.get(name).exists() { return Ok(Some(kind)); }
    }
    let sequencer = paths.get("sequencer");
    if sequencer.exists() {
        let todo = std::fs::read_to_string(sequencer.join("todo"))
            .map_err(|error| format!("无法读取 Git 操作状态：{error}"))?;
        return Ok(Some(if todo.lines().any(|line| line.starts_with("revert ")) {
            "revert"
        } else { "cherry-pick" }));
    }
    Ok(None)
}

pub(super) fn ensure_no_operation(path: &str) -> Result<(), String> {
    if active_operation_kind(path)?.is_some() {
        return Err("请先完成或中止当前 Git 操作，再执行此操作".into());
    }
    Ok(())
}

fn current_branch_head(path: &str) -> Result<(String, String), String> {
    let branch = run_git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map_err(|_| "当前处于分离 HEAD 状态，请先切换到本地分支再合并".to_string())?;
    let head = run_git(path, &["rev-parse", "--verify", "HEAD^{commit}"])
        .map_err(|_| "当前分支还没有提交，无法合并".to_string())?;
    Ok((branch.trim().to_string(), head.trim().to_string()))
}

fn check_merge_ready(path: &str) -> Result<(String, String), String> {
    if active_operation_kind(path)?.is_some() {
        return Err("请先完成或中止当前 Git 操作，再开始合并".into());
    }
    let current = current_branch_head(path)?;
    if !read_git_status(path, &[])?.is_empty() {
        return Err("工作区有未提交的改动（包括未跟踪文件），请先提交或贮藏后再合并".into());
    }
    Ok(current)
}

fn resolve_source(path: &str, source: &str) -> Result<String, String> {
    if source.trim().is_empty() || source.contains('\0') || source.starts_with('-') {
        return Err("请选择有效的来源分支".into());
    }
    // Restrict the public API to branches; --end-of-options also prevents refs
    // or revision syntax supplied through IPC from becoming command options.
    let full = run_git(path, &["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", source])?;
    if !full.trim().starts_with("refs/heads/") && !full.trim().starts_with("refs/remotes/") {
        return Err("请选择本地或远端分支作为合并来源".into());
    }
    run_git(path, &["rev-parse", "--verify", "--end-of-options", &format!("{source}^{{commit}}")])
        .map(|value| value.trim().to_string())
}

fn ancestor(path: &str, older: &str, newer: &str) -> Result<bool, String> {
    let output = git_auth_command(path, &["merge-base", "--is-ancestor", older, newer], None)
        .output().map_err(|error| format!("无法执行 git：{error}"))?;
    match output.status.code() {
        Some(0) => Ok(true), Some(1) => Ok(false),
        _ => Err(git_error(&output, "无法检查分支关系")),
    }
}

fn git_error(output: &std::process::Output, fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() { return stderr; }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() { fallback.into() } else { stdout }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMergePreview {
    pub branch: String,
    pub head: String,
    pub source: String,
    pub source_head: String,
    /// up-to-date | fast-forward | merge
    pub kind: String,
    pub conflicts: Vec<String>,
    pub files: Vec<String>,
}

fn nul_paths(output: &str) -> Vec<String> {
    output.split('\0').filter(|part| !part.is_empty()).map(str::to_string).collect()
}

fn local_merge_preview_inner(path: &str, source: &str) -> Result<LocalMergePreview, String> {
    let (branch, head) = check_merge_ready(path)?;
    let source_head = resolve_source(path, source)?;
    let mut conflicts = Vec::new();
    let kind = if ancestor(path, &source_head, &head)? { "up-to-date" }
        else if ancestor(path, &head, &source_head)? { "fast-forward" }
        else { "merge" };
    let mut merged_tree = source_head.clone();
    if kind == "merge" {
        let output = git_auth_command(path, &[
            "merge-tree", "--write-tree", "--name-only", "-z", &head, &source_head,
        ], None).output().map_err(|error| format!("无法执行 git：{error}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        match output.status.code() {
            Some(0) => {},
            Some(1) => {
                // With -z even whitespace/newlines and non-ASCII paths remain
                // literal; an empty field terminates the conflict path section.
                let mut seen = std::collections::HashSet::new();
                conflicts = stdout.split('\0').skip(1).take_while(|part| !part.is_empty())
                    .filter(|part| seen.insert((*part).to_string())).map(str::to_string).collect();
            },
            _ => return Err(git_error(&output, "无法检测合并冲突")),
        }
        merged_tree = stdout.split('\0').next().unwrap_or("").trim().to_string();
    }
    let mut files = if kind == "up-to-date" { Vec::new() } else {
        nul_paths(&run_git(path, &["diff", "--name-only", "-z", &head, &merged_tree])?)
    };
    for conflict in &conflicts {
        if !files.contains(conflict) { files.push(conflict.clone()); }
    }
    // Do not pair a preview with refs that moved during its computation.
    if current_branch_head(path)? != (branch.clone(), head.clone()) || resolve_source(path, source)? != source_head {
        return Err("当前分支或来源分支已变化，请重新预览合并".into());
    }
    Ok(LocalMergePreview { branch, head, source: source.into(), source_head, kind: kind.into(), conflicts, files })
}

#[tauri::command]
pub async fn git_local_merge_preview(path: String, source: String) -> Result<LocalMergePreview, String> {
    run_blocking(move || with_staging_lock(&path, || local_merge_preview_inner(&path, &source))).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOperation {
    pub kind: String,
    pub branch: String,
    pub head: String,
    pub conflicts: Vec<String>,
    pub staged_files: Vec<String>,
    pub unstaged_files: Vec<String>,
    pub message: String,
    pub revision: String,
    pub can_continue: bool,
    pub can_abort: bool,
    pub continue_blocked_reason: Option<String>,
}

fn hash_path(input: &mut impl Write, disk_path: &Path, working_tree: bool) -> Result<(), String> {
    match std::fs::symlink_metadata(disk_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => input.write_all(b"missing\0"),
        Err(error) => return Err(format!("无法读取合并快照：{error}")),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let target = std::fs::read_link(disk_path).map_err(|error| error.to_string())?;
            input.write_all(b"symlink\0").and_then(|_| input.write_all(target.to_string_lossy().as_bytes()))
        },
        Ok(metadata) if metadata.is_file() => {
            input.write_all(format!("file:{}\0", metadata.len()).as_bytes()).map_err(|error| error.to_string())?;
            let mut file = std::fs::File::open(disk_path).map_err(|error| error.to_string())?;
            std::io::copy(&mut file, input).map(|_| ())
        },
        Ok(metadata) if metadata.is_dir() => {
            // Metadata directories contain small Git-owned files. Worktree
            // submodules are handled separately and never traversed here.
            let mut entries = std::fs::read_dir(disk_path).map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                // Nested untracked repositories can be unborn, and their
                // object database is unrelated to the files abort may affect.
                if working_tree && entry.file_name() == ".git" { continue; }
                input.write_all(entry.file_name().to_string_lossy().as_bytes()).map_err(|error| error.to_string())?;
                input.write_all(b"\0").map_err(|error| error.to_string())?;
                hash_path(input, &entry.path(), working_tree)?;
                input.write_all(b"\0").map_err(|error| error.to_string())?;
            }
            Ok(())
        },
        Ok(_) => input.write_all(b"special\0"),
    }.map_err(|error| format!("无法读取合并快照：{error}"))
}

fn operation_revision(path: &str, entries: &[StatusEntry], paths: &OperationPaths) -> Result<String, String> {
    let staging = staging_revision(path)?;
    let gitlinks: std::collections::HashSet<String> = run_git(path, &["ls-files", "--stage", "-z"])?
        .split('\0').filter(|entry| entry.starts_with("160000 "))
        .filter_map(|entry| entry.split_once('\t').map(|(_, path)| path.to_string())).collect();
    let mut input = SnapshotHasher::new();
    input.write_all(staging.as_bytes()).map_err(|error| error.to_string())?;
    for name in OPERATION_PATHS {
        input.write_all(name.as_bytes()).map_err(|error| error.to_string())?;
        input.write_all(b"\0").map_err(|error| error.to_string())?;
        hash_path(&mut input, &paths.get(name), false)?;
        input.write_all(b"\0").map_err(|error| error.to_string())?;
    }
    for entry in entries {
        input.write_all(entry.path.as_bytes()).map_err(|error| error.to_string())?;
        input.write_all(entry.index_status.as_bytes()).map_err(|error| error.to_string())?;
        input.write_all(entry.work_status.as_bytes()).map_err(|error| error.to_string())?;
        input.write_all(b"\0").map_err(|error| error.to_string())?;
        let disk_path = Path::new(path).join(&entry.path);
        if gitlinks.contains(&entry.path) && disk_path.is_dir() && !disk_path.is_symlink()
            && disk_path.join(".git").exists() {
            // Record submodule changes without traversing clean files.
            let nested = disk_path.to_string_lossy();
            let head = run_git(&nested, &["rev-parse", "--verify", "HEAD"])
                .unwrap_or_else(|_| "unborn".into());
            input.write_all(head.as_bytes()).map_err(|error| error.to_string())?;
            let status = run_git(&nested, &["status", "--porcelain", "-uall", "-z"])?;
            input.write_all(status.as_bytes()).map_err(|error| error.to_string())?;
            for nested_entry in read_git_status(&nested, &[])? {
                input.write_all(nested_entry.path.as_bytes()).map_err(|error| error.to_string())?;
                input.write_all(b"\0").map_err(|error| error.to_string())?;
                hash_path(&mut input, &disk_path.join(&nested_entry.path), true)?;
                input.write_all(b"\0").map_err(|error| error.to_string())?;
            }
        } else { hash_path(&mut input, &disk_path, true)?; }
        input.write_all(b"\0").map_err(|error| error.to_string())?;
    }
    Ok(input.finish())
}

fn operation_state_inner(path: &str) -> Result<Option<RepositoryOperation>, String> {
    for _ in 0..3 {
        let paths = OperationPaths::resolve(path)?;
        let Some(kind) = operation_kind_at(&paths)? else { return Ok(None); };
        let entries = read_git_status(path, &[])?;
        let revision = operation_revision(path, &entries, &paths)?;
        let conflicts = nul_paths(&run_git(path, &["diff", "--name-only", "--diff-filter=U", "-z"])?);
        let original_body = if kind == "cherry-pick" { cherry_pick_message_at(path, &paths)? } else { None };
        let commit_message = match original_body.as_deref() {
            Some(body) => cherry_pick_commit_message_at(path, body, &paths)?, None => None,
        };
        let message = if let Some(body) = original_body.as_ref() {
            String::from_utf8_lossy(commit_message.as_deref().unwrap_or(body)).to_string()
        }
            else { match std::fs::read_to_string(paths.get("MERGE_MSG")) {
                Ok(value) => prepared_message(path, &value)?, Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(error) => return Err(format!("无法读取合并提交信息：{error}")),
            } };
        let branch = run_git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .unwrap_or_else(|_| "HEAD".into()).trim().to_string();
        let head = run_git(path, &["rev-parse", "--verify", "HEAD"])?.trim().to_string();
        let staged_files: Vec<String> = entries.iter().filter(|entry| entry.staged && !conflicts.contains(&entry.path))
            .map(|entry| entry.path.clone()).collect();
        let unstaged_files = entries.iter().filter(|entry| entry.work_status != " " || entry.index_status == "?")
            .map(|entry| entry.path.clone()).collect();
        let continue_blocked_reason = if kind != "cherry-pick" { None }
            else if original_body.is_none() { Some("当前 Cherry-pick 没有可恢复的原提交，请在终端完成或中止此操作".into()) }
            else if !conflicts.is_empty() { Some("仍有未解决的冲突，请解决并暂存后继续 Cherry-pick".into()) }
            else if staged_files.is_empty() { Some("Cherry-pick 没有可提交的暂存改动，请在终端选择跳过或保留空提交，也可以中止 Cherry-pick".into()) }
            else if original_body.as_ref().is_some_and(|body| String::from_utf8_lossy(body).trim().is_empty()) {
                Some("原提交说明为空，请在终端明确完成该提交，或中止 Cherry-pick".into())
            } else if commit_message.is_none() {
                Some("Cherry-pick 提交说明已被外部修改，请在终端明确完成该提交，或中止 Cherry-pick".into())
            } else { None };
        let fresh_entries = read_git_status(path, &[])?;
        if operation_kind_at(&paths)? == Some(kind) && revision == operation_revision(path, &fresh_entries, &paths)? {
            // A merge can legitimately keep the first parent's tree. An empty
            // cherry-pick or empty prepared message needs an explicit decision
            // in the terminal rather than silently inventing commit content.
            let can_continue = conflicts.is_empty()
                && (kind == "merge" || kind == "cherry-pick" && continue_blocked_reason.is_none());
            return Ok(Some(RepositoryOperation { kind: kind.into(), branch, head, conflicts,
                staged_files, unstaged_files, message, revision, can_continue,
                can_abort: kind == "merge" || kind == "cherry-pick", continue_blocked_reason }));
        }
    }
    Err("合并状态已变化，请刷新后重试".into())
}

fn prepared_message(path: &str, raw: &str) -> Result<String, String> {
    // Remove Git's generated conflict comment scaffold only when loading the
    // draft. The user's submitted message is never passed through stripspace.
    prepared_message_bytes(path, raw.as_bytes()).map(|body| String::from_utf8_lossy(&body).to_string())
}

fn prepared_message_bytes(path: &str, raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut child = git_auth_command(path, &["stripspace", "--strip-comments"], None)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|error| format!("无法读取合并提交信息：{error}"))?;
    let written = child.stdin.take().ok_or("无法读取合并提交信息")?
        .write_all(raw).map_err(|error| error.to_string());
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    written?;
    if !output.status.success() { return Err(git_error(&output, "无法读取合并提交信息")); }
    Ok(output.stdout)
}

#[tauri::command]
pub async fn git_operation_state(path: String) -> Result<Option<RepositoryOperation>, String> {
    run_blocking(move || with_staging_lock(&path, || operation_state_inner(&path))).await
}

fn validated_merge_state(path: &str, expected_revision: &str) -> Result<RepositoryOperation, String> {
    validated_operation_state(path, expected_revision, &["merge"])
}

fn validated_operation_state(path: &str, expected_revision: &str, kinds: &[&str]) -> Result<RepositoryOperation, String> {
    let current = operation_state_inner(path)?.ok_or("当前没有正在进行的 Git 操作")?;
    if !kinds.contains(&current.kind.as_str()) {
        return Err(match kinds {
            ["merge"] => "当前 Git 操作不是合并，请重新检查仓库状态",
            ["cherry-pick"] => "当前 Git 操作不是 Cherry-pick，请重新检查仓库状态",
            _ => "当前 Git 操作不支持此操作，请在终端完成或中止",
        }.into());
    }
    if expected_revision.is_empty() || current.revision != expected_revision {
        return Err("Git 操作状态或文件已变化，请重新检查后再操作".into());
    }
    Ok(current)
}

fn identity_configs(name: Option<&str>, email: Option<&str>) -> Vec<String> {
    [("user.name", name), ("user.email", email)].into_iter()
        .filter_map(|(key, value)| value.map(str::trim).filter(|value| !value.is_empty()).map(|value| format!("{key}={value}")))
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMergeResult {
    pub status: String,
    pub operation: Option<RepositoryOperation>,
}

fn local_merge_inner(path: &str, source: &str, expected_branch: &str, expected_head: &str,
    expected_source_head: &str, name: Option<&str>, email: Option<&str>) -> Result<LocalMergeResult, String> {
    let (branch, head) = check_merge_ready(path)?;
    let source_head = resolve_source(path, source)?;
    if branch != expected_branch || head != expected_head || source_head != expected_source_head {
        return Err("当前分支或来源分支已变化，请重新预览合并".into());
    }
    let already_merged = ancestor(path, &source_head, &head)?;
    let configs = identity_configs(name, email);
    let message = format!("Merge branch '{source}' into {branch}");
    let merge_options = format!("branch.{branch}.mergeoptions=");
    let mut args = vec!["-c", "core.editor=true", "-c", &merge_options];
    for config in &configs { args.extend(["-c", config]); }
    args.extend(["merge", "--strategy=ort", "--ff", "--commit", "--no-squash", "--no-autostash", "--no-edit", "-m", &message, &source_head]);
    let output = git_auth_command(path, &args, None).env("GIT_MERGE_AUTOEDIT", "no")
        .output().map_err(|error| format!("无法执行 git：{error}"))?;
    let operation = operation_state_inner(path)?;
    if !output.status.success() {
        if operation.as_ref().is_some_and(|state| state.kind == "merge" && !state.conflicts.is_empty()) {
            return Ok(LocalMergeResult { status: "conflict".into(), operation });
        }
        return Err(git_error(&output, "合并未完成"));
    }
    Ok(LocalMergeResult { status: if already_merged { "up-to-date" } else { "merged" }.into(), operation })
}

#[tauri::command]
pub async fn git_local_merge(path: String, source: String, expected_branch: String, expected_head: String,
    expected_source_head: String, name: Option<String>, email: Option<String>) -> Result<LocalMergeResult, String> {
    run_blocking(move || with_staging_lock(&path, || local_merge_inner(&path, &source, &expected_branch,
        &expected_head, &expected_source_head, name.as_deref(), email.as_deref()))).await
}

fn merge_continue_inner(path: &str, expected_revision: &str, message: &str,
    name: Option<&str>, email: Option<&str>) -> Result<(), String> {
    let state = validated_merge_state(path, expected_revision)?;
    if !state.conflicts.is_empty() { return Err("仍有未解决的冲突，请解决并暂存后继续合并".into()); }
    if message.trim().is_empty() { return Err("合并提交信息不能为空".into()); }
    let configs = identity_configs(name, email);
    let mut args = vec!["-c", "core.editor=true"];
    for config in &configs { args.extend(["-c", config]); }
    // git commit preserves MERGE_HEAD as the second parent and commits only
    // the reviewed index. Do not require an index diff: a resolved merge can
    // legitimately have the same tree as its first parent.
    args.extend(["commit", "-m", message.trim()]);
    run_git(path, &args)?;
    Ok(())
}

#[tauri::command]
pub async fn git_merge_continue(path: String, expected_revision: String, message: String,
    name: Option<String>, email: Option<String>) -> Result<(), String> {
    run_blocking(move || with_staging_lock(&path, || merge_continue_inner(&path, &expected_revision,
        &message, name.as_deref(), email.as_deref()))).await
}

fn merge_abort_inner(path: &str, expected_revision: &str) -> Result<(), String> {
    validated_merge_state(path, expected_revision)?;
    run_git(path, &["merge", "--abort"])?;
    Ok(())
}

#[tauri::command]
pub async fn git_merge_abort(path: String, expected_revision: String) -> Result<(), String> {
    run_blocking(move || with_staging_lock(&path, || merge_abort_inner(&path, &expected_revision))).await
}

fn cherry_pick_head(path: &str) -> Result<Option<String>, String> {
    cherry_pick_head_at(&OperationPaths::resolve(path)?)
}

fn cherry_pick_head_at(paths: &OperationPaths) -> Result<Option<String>, String> {
    match std::fs::read_to_string(paths.get("CHERRY_PICK_HEAD")) {
        Ok(value) => Ok(Some(value.trim().to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取 Cherry-pick 状态：{error}")),
    }
}

fn cherry_pick_message(path: &str) -> Result<Option<Vec<u8>>, String> {
    cherry_pick_message_at(path, &OperationPaths::resolve(path)?)
}

fn cherry_pick_message_at(path: &str, paths: &OperationPaths) -> Result<Option<Vec<u8>>, String> {
    if cherry_pick_head_at(paths)?.is_none() { return Ok(None); }
    let output = git_auth_command(path, &["cat-file", "commit", "CHERRY_PICK_HEAD"], None)
        .output().map_err(|error| format!("无法读取 Cherry-pick 提交说明：{error}"))?;
    if !output.status.success() { return Err(git_error(&output, "无法读取 Cherry-pick 提交说明")); }
    let body_start = output.stdout.windows(2).position(|bytes| bytes == b"\n\n")
        .ok_or("无法读取 Cherry-pick 提交说明")? + 2;
    Ok(Some(output.stdout[body_start..].to_vec()))
}

fn cherry_pick_commit_message(path: &str, original: &[u8]) -> Result<Option<Vec<u8>>, String> {
    cherry_pick_commit_message_at(path, original, &OperationPaths::resolve(path)?)
}

fn cherry_pick_commit_message_at(path: &str, original: &[u8], paths: &OperationPaths) -> Result<Option<Vec<u8>>, String> {
    let prepared = match std::fs::read(paths.get("MERGE_MSG")) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Some(original.to_vec())),
        Err(error) => return Err(format!("无法读取 Cherry-pick 提交说明：{error}")),
    };
    // Git appends -x/-s footers and conflict comments after the exact source
    // body. Strip only that generated suffix, never the author's own '#' lines
    // or significant whitespace. External edits to the body need a decision.
    let Some(suffix) = prepared.strip_prefix(original) else { return Ok(None); };
    let cleaned_suffix = prepared_message_bytes(path, suffix)?;
    let mut message = original.to_vec();
    if !cleaned_suffix.is_empty() {
        message.extend(suffix.iter().take_while(|byte| **byte == b'\n'));
        message.extend(cleaned_suffix);
    }
    Ok(Some(message))
}

fn cherry_pick_signing_option(path: &str) -> Result<Option<String>, String> {
    let paths = OperationPaths::resolve(path)?;
    let opts = paths.get("sequencer/opts");
    if !opts.exists() {
        // Git omits opts when the sequence uses defaults, including an explicit
        // --no-gpg-sign. A single pick has no sequencer and follows repo config.
        return Ok(paths.get("sequencer").exists().then(|| "--no-gpg-sign".into()));
    }
    let opts_path = opts.to_str().ok_or("无法读取 Cherry-pick 签名配置")?;
    let output = git_auth_command(path, &["config", "--file", opts_path, "--get", "options.gpg-sign"], None)
        .output().map_err(|error| format!("无法读取 Cherry-pick 签名配置：{error}"))?;
    match output.status.code() {
        Some(0) => {
            let key = String::from_utf8(output.stdout).map_err(|_| "无法读取 Cherry-pick 签名配置")?;
            Ok(Some(format!("-S{}", key.strip_suffix('\n').unwrap_or(&key))))
        },
        // Saved sequencer options explicitly govern signing, even when the
        // repository's commit.gpgSign changed after the sequence began.
        Some(1) => Ok(Some("--no-gpg-sign".into())),
        _ => Err(git_error(&output, "无法读取 Cherry-pick 签名配置")),
    }
}

fn cherry_pick_continue_inner(path: &str, expected_revision: &str,
    name: Option<&str>, email: Option<&str>) -> Result<Option<RepositoryOperation>, String> {
    let state = validated_operation_state(path, expected_revision, &["cherry-pick"])?;
    if let Some(reason) = state.continue_blocked_reason.as_ref() { return Err(reason.clone()); }
    let picked_head = cherry_pick_head(path)?;
    let original = cherry_pick_message(path)?.ok_or("当前 Cherry-pick 提交已变化，请重新检查仓库状态")?;
    let message = cherry_pick_commit_message(path, &original)?
        .ok_or("Cherry-pick 提交说明已被外部修改，请在终端明确完成该提交，或中止 Cherry-pick")?;
    let configs = identity_configs(name, email);
    let mut identity_args = vec!["-c", "core.editor=true"];
    for config in &configs { identity_args.extend(["-c", config]); }
    let signing_option = cherry_pick_signing_option(path)?;
    let mut commit_args = identity_args.clone();
    // Native --continue hard-codes --cleanup=strip. Commit this paused pick with
    // the source's exact body so '#' lines and trailing whitespace survive.
    // CHERRY_PICK_HEAD makes Git retain its author/date; user.* selects committer.
    commit_args.extend(["commit", "--cleanup=verbatim", "--file=-"]);
    if let Some(option) = &signing_option { commit_args.push(option); }
    let mut child = git_auth_command(path, &commit_args, None).env("GIT_EDITOR", "true")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|error| format!("无法执行 git：{error}"))?;
    let written = child.stdin.take().ok_or("无法传递 Cherry-pick 提交说明")?
        .write_all(&message).map_err(|error| format!("无法传递 Cherry-pick 提交说明：{error}"));
    let committed = child.wait_with_output().map_err(|error| format!("无法执行 git：{error}"))?;
    written?;
    if !committed.status.success() { return Err(git_error(&committed, "Cherry-pick 未完成")); }
    // A single pick ends with commit. For an external multi-pick sequence,
    // Git's continue advances the todo list and applies the remaining commits.
    if !git_path(path, "sequencer")?.exists() { return operation_state_inner(path); }
    let mut args = identity_args;
    if signing_option.as_deref() == Some("--no-gpg-sign") {
        args.extend(["-c", "commit.gpgSign=false"]);
    }
    args.extend(["cherry-pick", "--continue"]);
    let output = git_auth_command(path, &args, None).env("GIT_EDITOR", "true").output()
        .map_err(|error| format!("无法执行 git：{error}"))?;
    let operation = operation_state_inner(path)?;
    if !output.status.success() {
        // Only a newly reached conflicted commit is a recoverable result. A
        // failed hook or empty pick at the reviewed commit must remain an error.
        if operation.as_ref().is_some_and(|next| next.kind == "cherry-pick"
            && !next.conflicts.is_empty() && next.head != state.head)
            && cherry_pick_head(path)? != picked_head {
            return Ok(operation);
        }
        return Err(git_error(&output, "Cherry-pick 未完成"));
    }
    Ok(operation)
}

#[tauri::command]
pub async fn git_cherry_pick_continue(path: String, expected_revision: String,
    name: Option<String>, email: Option<String>) -> Result<Option<RepositoryOperation>, String> {
    run_blocking(move || with_staging_lock(&path, || cherry_pick_continue_inner(&path,
        &expected_revision, name.as_deref(), email.as_deref()))).await
}

fn cherry_pick_abort_inner(path: &str, expected_revision: &str) -> Result<(), String> {
    validated_operation_state(path, expected_revision, &["cherry-pick"])?;
    run_git(path, &["cherry-pick", "--abort"])?;
    Ok(())
}

#[tauri::command]
pub async fn git_cherry_pick_abort(path: String, expected_revision: String) -> Result<(), String> {
    run_blocking(move || with_staging_lock(&path, || cherry_pick_abort_inner(&path, &expected_revision))).await
}

fn merge_tool_state(path: &str, expected_revision: &str) -> Result<RepositoryOperation, String> {
    let state = validated_operation_state(path, expected_revision, &["merge", "cherry-pick"])?;
    if state.conflicts.is_empty() { return Err("当前没有未解决的冲突".into()); }
    Ok(state)
}

#[tauri::command]
pub async fn git_merge_tool(path: String, expected_revision: String) -> Result<(), String> {
    run_blocking(move || with_staging_lock(&path, || {
        merge_tool_state(&path, &expected_revision)?;
        launch_kaleidoscope_mergetool(&path)
    })).await
}

#[cfg(test)]
#[path = "local_merge_tests.rs"]
mod tests;
