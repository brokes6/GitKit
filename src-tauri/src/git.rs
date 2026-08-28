// GitKit — Git backend. Shells out to the system `git` so that the user's
// existing SSH keys, credentials and hooks are reused as-is.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

/// macOS GUI apps (launched from Finder/Dock) inherit a minimal PATH — usually
/// just `/usr/bin:/bin:/usr/sbin:/sbin` — that omits Homebrew and other common
/// install dirs. So tools the user has in their terminal (notably `git-lfs`,
/// which git's checkout/merge hooks and smudge filter invoke) aren't found, and
/// operations fail with "'git-lfs' was not found on your path" even though they
/// work from a shell. Prepend the usual locations so the subprocess sees the
/// same tools the user does.
fn augmented_path() -> String {
    let extras = [
        "/opt/homebrew/bin", // Homebrew (Apple Silicon)
        "/opt/homebrew/sbin",
        "/usr/local/bin", // Homebrew (Intel) / manual installs
        "/usr/local/sbin",
        "/opt/local/bin", // MacPorts
    ];
    let base = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<&str> = extras.to_vec();
    parts.extend(base.split(':').filter(|s| !s.is_empty()));
    // Dedup while preserving order (extras first, so they win).
    let mut seen = std::collections::HashSet::new();
    parts.retain(|p| seen.insert(*p));
    parts.join(":")
}

/// Build a `Command` that never flashes a console window on Windows. Every
/// subprocess (git polls run constantly) must go through this, otherwise each
/// spawn pops a cmd window that steals focus — on Windows the app looks like
/// it's flickering a terminal nonstop.
fn command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Run a git command inside `repo`, returning stdout on success or stderr on failure.
fn run_git(repo: &str, args: &[&str]) -> Result<String, String> {
    run_git_auth(repo, args, None)
}

/// Run a git command with client-side hooks disabled (`core.hooksPath=/dev/null`).
/// Used for app-driven branch/checkout/merge operations: a broken user hook — most
/// commonly a Git LFS `post-checkout` hook when `git-lfs` isn't installed — otherwise
/// makes an operation that actually succeeded ("Switched to a new branch …") report
/// failure. LFS smudge/clean *filters* are config-driven, not hooks, so large-file
/// content still materialises normally.
fn run_git_nohooks(repo: &str, args: &[&str]) -> Result<String, String> {
    let mut full: Vec<&str> = vec!["-c", "core.hooksPath=/dev/null"];
    full.extend_from_slice(args);
    run_git_auth(repo, &full, None)
}

/// True when a git error is the "git-lfs not installed" complaint printed by the
/// LFS hooks. Used to retry the operation with hooks disabled.
fn is_lfs_missing(err: &str) -> bool {
    err.contains("git-lfs") && err.contains("not found")
}

/// Like `run_git` but, when a `token` is supplied, feeds it to any HTTP(S) auth
/// prompt as `oauth2:<token>` via a one-shot credential helper. `GIT_TERMINAL_PROMPT=0`
/// is always set so git fails fast instead of hanging on an interactive prompt
/// (the token is passed through the environment, never on the argv).
fn run_git_auth(repo: &str, args: &[&str], token: Option<&str>) -> Result<String, String> {
    let mut cmd = command("git");
    cmd.arg("-C").arg(repo);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("PATH", augmented_path());
    if let Some(tok) = token.filter(|s| !s.trim().is_empty()) {
        cmd.env("GITKIT_GL_TOKEN", tok.trim());
        // Clear inherited helpers, then supply ours (reads the token from env).
        cmd.arg("-c").arg("credential.helper=");
        cmd.arg("-c")
            .arg("credential.helper=!f() { echo username=oauth2; echo \"password=$GITKIT_GL_TOKEN\"; }; f");
    }
    let out = cmd
        .args(args)
        .output()
        .map_err(|e| format!("无法执行 git：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "git 命令失败".to_string()
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Compute stable patch ids for the visible history in one pipeline. Feeding a
/// single `git log -p` stream into `git patch-id --stable` avoids spawning two
/// git processes per commit when a repository is opened. Patch ids deliberately
/// ignore commit metadata, so cherry-picked commits with the same diff match
/// even though their hashes and parents differ.
fn stable_patch_ids(repo: &str, limit: u32) -> Result<HashMap<String, String>, String> {
    let max_count = format!("--max-count={limit}");
    let mut producer = command("git");
    producer
        .arg("-C")
        .arg(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("PATH", augmented_path())
        .args([
            "log",
            "--all",
            "--topo-order",
            "--no-merges",
            max_count.as_str(),
            "--pretty=format:commit %H",
            "-p",
            "--no-color",
            "--no-ext-diff",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut producer = producer
        .spawn()
        .map_err(|e| format!("无法读取提交差异：{e}"))?;
    let stdout = producer
        .stdout
        .take()
        .ok_or_else(|| "无法读取提交差异".to_string())?;

    let mut consumer = command("git");
    consumer
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("PATH", augmented_path())
        .args(["patch-id", "--stable"])
        .stdin(Stdio::from(stdout))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let consumer_out = consumer
        .spawn()
        .and_then(|child| child.wait_with_output())
        .map_err(|e| format!("无法计算提交变更标识：{e}"))?;
    let producer_out = producer
        .wait_with_output()
        .map_err(|e| format!("无法读取提交差异：{e}"))?;

    if !producer_out.status.success() {
        let err = String::from_utf8_lossy(&producer_out.stderr)
            .trim()
            .to_string();
        return Err(if err.is_empty() {
            "读取提交差异失败".into()
        } else {
            err
        });
    }
    if !consumer_out.status.success() {
        let err = String::from_utf8_lossy(&consumer_out.stderr)
            .trim()
            .to_string();
        return Err(if err.is_empty() {
            "计算提交变更标识失败".into()
        } else {
            err
        });
    }

    let mut ids = HashMap::new();
    for line in String::from_utf8_lossy(&consumer_out.stdout).lines() {
        let mut fields = line.split_whitespace();
        let (Some(patch_id), Some(commit_hash)) = (fields.next(), fields.next()) else {
            continue;
        };
        ids.insert(commit_hash.to_string(), patch_id.to_string());
    }
    Ok(ids)
}

#[derive(Serialize)]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub current_branch: String,
}

/// Validate that `path` is inside a work tree and return basic repo info.
#[tauri::command]
pub async fn open_repo(path: String) -> Result<RepoInfo, String> {
    run_blocking(move || {
        let inside = run_git(&path, &["rev-parse", "--is-inside-work-tree"])?;
        if inside.trim() != "true" {
            return Err("该目录不是一个 Git 仓库".to_string());
        }
        let top = run_git(&path, &["rev-parse", "--show-toplevel"])?
            .trim()
            .to_string();
        let name = std::path::Path::new(&top)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "repo".to_string());
        let current = run_git(&top, &["branch", "--show-current"])?.trim().to_string();
        Ok(RepoInfo {
            path: top,
            name,
            current_branch: if current.is_empty() {
                "HEAD".to_string()
            } else {
                current
            },
        })
    })
    .await
}

/// Reveal a working-tree file in the platform file manager. Historical commits
/// can reference files that no longer exist; in that case, open the nearest
/// existing parent directory instead. The relative path is validated so this
/// command cannot be used to escape the repository root.
#[tauri::command]
pub async fn reveal_in_file_manager(path: String, file: Option<String>) -> Result<(), String> {
    run_blocking(move || {
        use std::path::{Component, Path, PathBuf};

        let repo = Path::new(&path)
            .canonicalize()
            .map_err(|e| format!("无法访问仓库目录：{e}"))?;
        let mut requested = repo.clone();
        if let Some(relative) = file.as_deref().filter(|value| !value.trim().is_empty()) {
            let relative = Path::new(relative);
            if relative.is_absolute()
                || relative.components().any(|part| {
                    matches!(part, Component::Prefix(_) | Component::RootDir | Component::ParentDir)
                })
            {
                return Err("文件路径不在当前仓库中".into());
            }
            requested.push(relative);
        }

        let target = if requested.exists() {
            let canonical = requested
                .canonicalize()
                .map_err(|e| format!("无法访问文件位置：{e}"))?;
            if !canonical.starts_with(&repo) {
                return Err("文件路径不在当前仓库中".into());
            }
            canonical
        } else {
            let mut existing: PathBuf = requested;
            while existing != repo && !existing.exists() {
                existing.pop();
            }
            let canonical = existing
                .canonicalize()
                .map_err(|e| format!("无法访问文件位置：{e}"))?;
            if !canonical.starts_with(&repo) {
                return Err("文件路径不在当前仓库中".into());
            }
            canonical
        };
        let is_file = target.is_file();

        #[cfg(target_os = "macos")]
        let status = {
            let mut cmd = command("open");
            if is_file {
                cmd.arg("-R");
            }
            cmd.arg(&target).status()
        };

        #[cfg(target_os = "windows")]
        let status = {
            let mut cmd = command("explorer.exe");
            if is_file {
                cmd.arg(format!("/select,{}", target.to_string_lossy()));
            } else {
                cmd.arg(&target);
            }
            cmd.status()
        };

        #[cfg(target_os = "linux")]
        let status = {
            let open_target = if is_file {
                target.parent().unwrap_or(&repo)
            } else {
                &target
            };
            command("xdg-open").arg(open_target).status()
        };

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        return Err("当前平台暂不支持打开文件管理器".into());

        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        match status {
            Ok(code) if code.success() => Ok(()),
            Ok(_) => Err("文件管理器未能打开该位置".into()),
            Err(e) => Err(format!("无法启动文件管理器：{e}")),
        }
    })
    .await
}

#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub short_hash: String,
    pub head_hash: String,
    pub upstream: Option<String>,
    pub current: bool,
    pub ahead: u32,
    pub behind: u32,
    pub is_remote: bool,
    /// Absolute path of the *linked* worktree that has this branch checked out,
    /// if any. Such a branch can be neither checked out nor deleted from the
    /// main worktree until that worktree is removed.
    pub worktree: Option<String>,
}

/// Map `refs/heads/<name>` → worktree path for every worktree **other than the
/// one being browsed** (`git worktree list --porcelain`). The open worktree is
/// excluded by comparing against its own top level, not by position: GitKit may
/// have been pointed at a linked worktree rather than the main one, in which
/// case it is the main worktree's branch that is blocked. Detached entries have
/// no `branch` line and drop out; a failure here degrades to an empty map rather
/// than breaking branch listing.
fn linked_worktree_branches(path: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(out) = run_git(path, &["worktree", "list", "--porcelain"]) else {
        return map;
    };
    let own = run_git(path, &["rev-parse", "--show-toplevel"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let mut cur: Option<String> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            cur = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            match &cur {
                Some(wt) if *wt != own => {
                    map.insert(b.trim().to_string(), wt.clone());
                }
                _ => {}
            }
        } else if line.trim().is_empty() {
            cur = None;
        }
    }
    map
}

#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<BranchInfo>, String> {
    run_blocking(move || {
    let fmt = "%(refname:short)\x1f%(objectname:short)\x1f%(upstream:short)\x1f%(HEAD)\x1f%(refname)\x1f%(objectname)";
    let out = run_git(
        &path,
        &[
            "for-each-ref",
            &format!("--format={fmt}"),
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let worktrees = linked_worktree_branches(&path);
    let mut res = Vec::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 6 {
            continue;
        }
        let name = f[0].to_string();
        // Skip the symbolic remote HEAD (e.g. "origin/HEAD").
        if name.ends_with("/HEAD") {
            continue;
        }
        let is_remote = f[4].starts_with("refs/remotes/");
        let upstream = if f[2].is_empty() {
            None
        } else {
            Some(f[2].to_string())
        };
        let current = f[3] == "*";
        let (mut ahead, mut behind) = (0u32, 0u32);
        if let Some(up) = &upstream {
            if let Ok(c) = run_git(
                &path,
                &[
                    "rev-list",
                    "--left-right",
                    "--count",
                    &format!("{name}...{up}"),
                ],
            ) {
                let nums: Vec<&str> = c.split_whitespace().collect();
                if nums.len() == 2 {
                    ahead = nums[0].parse().unwrap_or(0);
                    behind = nums[1].parse().unwrap_or(0);
                }
            }
        }
        let worktree = if is_remote {
            None
        } else {
            worktrees.get(f[4]).cloned()
        };
        res.push(BranchInfo {
            name,
            short_hash: f[1].to_string(),
            head_hash: f[5].to_string(),
            upstream,
            current,
            ahead,
            behind,
            is_remote,
            worktree,
        });
    }
    Ok(res)
    })
    .await
}

#[derive(Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

#[tauri::command]
pub async fn git_remotes(path: String) -> Result<Vec<RemoteInfo>, String> {
    run_blocking(move || {
    let out = run_git(&path, &["remote", "-v"])?;
    let mut res: Vec<RemoteInfo> = Vec::new();
    for line in out.lines() {
        // "origin\thttps://…  (fetch)"
        let mut it = line.split_whitespace();
        let name = it.next().unwrap_or("");
        let url = it.next().unwrap_or("");
        if name.is_empty() || res.iter().any(|r| r.name == name) {
            continue;
        }
        res.push(RemoteInfo {
            name: name.to_string(),
            url: url.to_string(),
        });
    }
    Ok(res)
    })
    .await
}

#[derive(Serialize)]
pub struct CommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub date: String,
    pub committer_date: String,
    pub patch_id: Option<String>,
    pub refs: Vec<String>,
    pub subject: String,
    pub body: String,
    // True for a stash tip (refs/stash). Its internal index/untracked parent
    // commits are collapsed away so the graph shows one node per stash.
    pub is_stash: bool,
}

#[tauri::command]
pub async fn git_log(path: String, limit: Option<u32>) -> Result<Vec<CommitInfo>, String> {
    run_blocking(move || {
    let limit = limit.unwrap_or(400);
    // Patch-id is an enhancement: history must remain available even if an old
    // or unusual Git installation cannot produce it.
    let patch_ids = match stable_patch_ids(&path, limit) {
        Ok(ids) => ids,
        Err(_) => HashMap::new(),
    };
    // Field sep \x1f, record sep \x1e.
    let fmt = "%H\x1f%h\x1f%P\x1f%an\x1f%ae\x1f%aI\x1f%cI\x1f%D\x1f%s\x1f%b\x1e";
    let out = run_git(
        &path,
        &[
            "log",
            "--all",
            "--topo-order",
            &format!("--max-count={limit}"),
            &format!("--pretty=format:{fmt}"),
        ],
    )?;
    let mut res = Vec::new();
    for rec in out.split('\x1e') {
        let rec = rec.trim_start_matches('\n');
        if rec.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.split('\x1f').collect();
        if f.len() < 10 {
            continue;
        }
        let parents = if f[2].trim().is_empty() {
            vec![]
        } else {
            f[2].split_whitespace().map(|s| s.to_string()).collect()
        };
        let refs = if f[7].trim().is_empty() {
            vec![]
        } else {
            f[7]
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        };
        res.push(CommitInfo {
            hash: f[0].to_string(),
            short_hash: f[1].to_string(),
            parents,
            author_name: f[3].to_string(),
            author_email: f[4].to_string(),
            date: f[5].to_string(),
            committer_date: f[6].to_string(),
            patch_id: patch_ids.get(f[0]).cloned(),
            refs,
            subject: f[8].to_string(),
            body: f[9].to_string(),
            is_stash: false,
        });
    }

    // Collapse stashes to a single node. A stash tip is a merge commit whose
    // parents are [base, index, (untracked)]; the index/untracked parents are
    // reachable via --all but belong to no branch. Hide them and keep only the
    // real base parent so the graph renders one node per stash.
    let stash_tips: std::collections::HashSet<String> = run_git(&path, &["stash", "list", "--format=%H"])
        .unwrap_or_default()
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if !stash_tips.is_empty() {
        let mut hidden: std::collections::HashSet<String> = std::collections::HashSet::new();
        for c in res.iter_mut() {
            if stash_tips.contains(&c.hash) {
                c.is_stash = true;
                for p in c.parents.iter().skip(1) {
                    hidden.insert(p.clone());
                }
                c.parents.truncate(1);
            }
        }
        res.retain(|c| !hidden.contains(&c.hash));
    }

    Ok(res)
    })
    .await
}

#[derive(Serialize)]
pub struct StatusEntry {
    pub path: String,
    pub index_status: String,
    pub work_status: String,
    pub staged: bool,
}

fn parse_status_entries(out: &str) -> Vec<StatusEntry> {
    let mut res = Vec::new();
    let mut fields = out.split('\0');
    while let Some(entry) = fields.next() {
        // Records are "XY <path>"; the trailing empty field after the last NUL and
        // any short/garbage record are skipped.
        if entry.len() < 4 {
            continue;
        }
        let x = &entry[0..1];
        let y = &entry[1..2];
        let p = entry[3..].to_string();
        // A rename/copy (R/C in either column) carries its source path as the NEXT
        // NUL-separated field; consume it and keep the new path we already have.
        if x == "R" || x == "C" || y == "R" || y == "C" {
            let _ = fields.next();
        }
        let staged = x != " " && x != "?";
        res.push(StatusEntry {
            path: p,
            index_status: x.to_string(),
            work_status: y.to_string(),
            staged,
        });
    }
    res
}

fn read_git_status(path: &str, paths: &[String]) -> Result<Vec<StatusEntry>, String> {
    // `-z` emits NUL-separated, UNQUOTED paths. `-uall` lists untracked files
    // individually. `--no-optional-locks` prevents a read from rewriting the
    // index and feeding back into the watcher.
    let mut args = vec![
        "--literal-pathspecs".to_string(),
        "--no-optional-locks".to_string(),
        "status".to_string(),
        "--porcelain".to_string(),
        "-uall".to_string(),
        "-z".to_string(),
    ];
    if !paths.is_empty() {
        args.push("--".to_string());
        args.extend(paths.iter().cloned());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(path, &refs).map(|out| parse_status_entries(&out))
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<Vec<StatusEntry>, String> {
    run_blocking(move || read_git_status(&path, &[])).await
}

/// Incremental status for a coalesced batch of working-tree paths. Invalid or
/// oversized batches fall back to the caller's next full reconciliation.
#[tauri::command]
pub async fn git_status_paths(path: String, paths: Vec<String>) -> Result<Vec<StatusEntry>, String> {
    run_blocking(move || {
        use std::path::{Component, Path};
        if paths.is_empty() || paths.len() > 256 {
            return read_git_status(&path, &[]);
        }
        for item in &paths {
            let candidate = Path::new(item);
            if item.is_empty()
                || candidate.is_absolute()
                || candidate.components().any(|part| {
                    matches!(part, Component::Prefix(_) | Component::RootDir | Component::ParentDir)
                })
            {
                return Err("工作区事件包含无效路径".into());
            }
        }
        read_git_status(&path, &paths)
    })
    .await
}

#[derive(Serialize)]
pub struct FileStat {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

/// Parse paired `--numstat -z` + `--name-status -z` output into per-file stats.
/// `-z` gives NUL-separated, UNQUOTED paths (spaces / 中文 / quotes survive intact),
/// which the newline form would wrap in C-style quotes and corrupt. A rename/copy
/// carries its old + new paths as two extra NUL fields in BOTH streams; we keep the
/// new path. numstat marks a rename with an empty path column; name-status with an
/// `R`/`C` status letter.
fn parse_diff_files(numstat: &str, names: &str) -> Vec<FileStat> {
    let mut adds: std::collections::HashMap<String, (u32, u32)> = std::collections::HashMap::new();
    let mut it = numstat.split('\0');
    while let Some(field) = it.next() {
        if field.is_empty() {
            continue;
        }
        let cols: Vec<&str> = field.splitn(3, '\t').collect();
        if cols.len() < 3 {
            continue;
        }
        let a = cols[0].parse::<u32>().unwrap_or(0);
        let d = cols[1].parse::<u32>().unwrap_or(0);
        let p = if cols[2].is_empty() {
            let _old = it.next();
            it.next().unwrap_or("").to_string()
        } else {
            cols[2].to_string()
        };
        if !p.is_empty() {
            adds.insert(p, (a, d));
        }
    }
    let mut res = Vec::new();
    let mut it = names.split('\0');
    while let Some(status) = it.next() {
        if status.is_empty() {
            continue;
        }
        let letter = status.chars().next().unwrap_or('M').to_string();
        let p = if letter == "R" || letter == "C" {
            let _old = it.next();
            it.next().unwrap_or("").to_string()
        } else {
            it.next().unwrap_or("").to_string()
        };
        if p.is_empty() {
            continue;
        }
        let (a, d) = adds.get(&p).copied().unwrap_or((0, 0));
        res.push(FileStat {
            path: p,
            status: letter,
            additions: a,
            deletions: d,
        });
    }
    res
}

/// Files changed in a commit, with per-file add/delete counts.
#[tauri::command]
pub async fn commit_files(path: String, hash: String) -> Result<Vec<FileStat>, String> {
    run_blocking(move || {
        let numstat = run_git(&path, &["show", "--format=", "--numstat", "-M", "-z", &hash])?;
        let names = run_git(&path, &["show", "--format=", "--name-status", "-M", "-z", &hash])?;
        Ok(parse_diff_files(&numstat, &names))
    })
    .await
}

/// Diff of a single file within a commit.
#[tauri::command]
pub async fn commit_file_diff(path: String, hash: String, file: String) -> Result<String, String> {
    run_blocking(move || run_git(&path, &["show", "--format=", "-M", &hash, "--", &file])).await
}

/// True if the working tree has any staged or unstaged changes.
#[tauri::command]
pub async fn git_has_changes(path: String) -> Result<bool, String> {
    run_blocking(move || {
        let out = run_git(&path, &["status", "--porcelain"])?;
        Ok(!out.trim().is_empty())
    })
    .await
}

/// Discard working-tree changes to a single file. A tracked file is reset to its
/// HEAD version (`checkout HEAD -- <file>`); an untracked file/dir is deleted
/// (`clean -fd -- <file>`). Destructive — the UI confirms first.
#[tauri::command]
pub async fn git_discard_file(path: String, file: String) -> Result<(), String> {
    run_blocking(move || {
        // `ls-files --error-unmatch` exits non-zero for a path git isn't tracking.
        let tracked = run_git(&path, &["ls-files", "--error-unmatch", "--", &file]).is_ok();
        if tracked {
            run_git(&path, &["checkout", "HEAD", "--", &file])?;
        } else {
            run_git(&path, &["clean", "-fd", "--", &file])?;
        }
        Ok(())
    })
    .await
}

/// Discard ALL working-tree changes: reset tracked files to HEAD and remove every
/// untracked file/dir. Destructive — the UI confirms first.
#[tauri::command]
pub async fn git_discard_all(path: String) -> Result<(), String> {
    run_blocking(move || {
        run_git(&path, &["reset", "--hard", "HEAD"])?;
        run_git(&path, &["clean", "-fd"])?;
        Ok(())
    })
    .await
}

#[derive(Serialize)]
pub struct DepInfo {
    pub name: String,
    pub found: bool,
    pub version: String,
    pub path: String,
}

/// Probe a CLI dependency: resolve its path (`command -v`) and read its version,
/// using the same augmented PATH the git subprocesses get so the result matches
/// what the app can actually run.
fn probe_dep(bin: &str, version_args: &[&str]) -> DepInfo {
    let path = command("sh")
        .env("PATH", augmented_path())
        .arg("-c")
        .arg(format!("command -v {bin}"))
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let version = command(bin)
        .env("PATH", augmented_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(version_args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    DepInfo {
        name: bin.to_string(),
        found: !path.is_empty() || !version.is_empty(),
        version,
        path,
    }
}

/// Check the CLI dependencies GitKit shells out to (git, git-lfs). Reports whether
/// each is on the app's PATH and its version, so the user can tell why LFS repos
/// misbehave.
#[tauri::command]
pub async fn check_deps() -> Result<Vec<DepInfo>, String> {
    run_blocking(|| {
        Ok(vec![
            probe_dep("git", &["--version"]),
            probe_dep("git-lfs", &["version"]),
            probe_dep("ksdiff", &["--version"]),
        ])
    })
    .await
}

/// Check out a branch. Fails (with git's message) if the switch is unsafe. Runs
/// off the UI thread so a slow checkout doesn't freeze the app.
#[tauri::command]
pub async fn git_checkout(path: String, branch: String) -> Result<(), String> {
    run_blocking(move || {
        run_git_nohooks(&path, &["checkout", &branch])?;
        Ok(())
    })
    .await
}

/// Git's canonical empty-tree object id, used as the merge base when a commit
/// has no parent (a root commit) so `merge-tree` still has something to diff.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Parse `git merge-tree --write-tree --name-only` output: line 1 is the merged
/// tree oid, the lines up to the first blank line are the conflicted paths, and
/// anything after is informational. Dedups while preserving order.
fn parse_merge_tree_conflicts(stdout: &str) -> Vec<String> {
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in stdout.lines().skip(1) {
        if line.is_empty() {
            break;
        }
        let f = line.trim();
        if !f.is_empty() && seen.insert(f.to_string()) {
            files.push(f.to_string());
        }
    }
    files
}

/// Paths with unmerged (conflicted) index entries — i.e. what's left to resolve
/// while a cherry-pick/merge is in progress.
fn unmerged_files(repo: &str) -> Vec<String> {
    // `-z` → NUL-separated, unquoted paths (safe for spaces / 中文).
    run_git(repo, &["diff", "--name-only", "--diff-filter=U", "-z"])
        .map(|s| {
            s.split('\0')
                .map(|l| l.to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Launch Kaleidoscope (`ksdiff`) as git's merge tool for every conflicted file.
/// The tool config is injected inline via `-c`, leaving the user's git config
/// untouched. Blocks until the user finishes resolving in Kaleidoscope.
fn launch_kaleidoscope_mergetool(repo: &str) -> Result<(), String> {
    let cmd_cfg = "mergetool.kaleidoscope.cmd=ksdiff --merge --output \"$MERGED\" \
                   --base \"$BASE\" -- \"$LOCAL\" \"$REMOTE\"";
    let out = command("git")
        .arg("-C")
        .arg(repo)
        .env("PATH", augmented_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            cmd_cfg,
            "-c",
            "mergetool.kaleidoscope.trustExitCode=true",
            "mergetool",
            "--tool=kaleidoscope",
            "--no-prompt",
        ])
        .output()
        .map_err(|e| format!("无法启动 Kaleidoscope：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "Kaleidoscope 合并未完成".to_string()
        } else {
            err
        });
    }
    Ok(())
}

/// Predict whether cherry-picking `hash` onto `target` (or the current branch)
/// would conflict, WITHOUT touching the working tree or index. Runs an in-memory
/// 3-way merge via `git merge-tree`: base = the commit's first parent, ours = the
/// target branch tip, theirs = the commit. Returns the paths that would conflict
/// (empty ⇒ the cherry-pick applies cleanly).
#[tauri::command]
pub async fn git_cherry_pick_preflight(
    path: String,
    hash: String,
    target: Option<String>,
) -> Result<Vec<String>, String> {
    run_blocking(move || {
        // "ours": the branch the commit will land on.
        let ours = target
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("HEAD")
            .to_string();
        // "base": the commit's first parent, or the empty tree for a root commit.
        let base = match run_git(&path, &["rev-parse", "--verify", "--quiet", &format!("{hash}^")]) {
            Ok(p) if !p.trim().is_empty() => p.trim().to_string(),
            _ => EMPTY_TREE.to_string(),
        };
        let out = command("git")
            .arg("-C")
            .arg(&path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("PATH", augmented_path())
            .args([
                "merge-tree",
                "--write-tree",
                "--name-only",
                &format!("--merge-base={base}"),
                &ours,
                &hash,
            ])
            .output()
            .map_err(|e| format!("无法执行 git：{e}"))?;
        match out.status.code() {
            Some(0) => Ok(Vec::new()), // clean merge
            Some(1) => Ok(parse_merge_tree_conflicts(
                &String::from_utf8_lossy(&out.stdout),
            )),
            _ => {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                Err(if err.is_empty() {
                    "遴选预检失败".to_string()
                } else {
                    err
                })
            }
        }
    })
    .await
}

#[derive(Serialize)]
pub struct CherryPickResult {
    /// "clean" — applied cleanly; "resolved" — conflicts resolved via Kaleidoscope
    /// and the cherry-pick was continued; "conflict" — left mid-cherry-pick with
    /// unresolved files.
    pub status: String,
    pub conflicts: Vec<String>,
}

/// Cherry-pick a commit. When `target` is given and isn't the current branch,
/// check it out first so the commit lands on that branch. A conflict is not a
/// hard error: it leaves the repo in a resolvable `CHERRY_PICK_HEAD` state and is
/// reported as `status: "conflict"`. When `use_kaleidoscope` is set, conflicts are
/// opened in Kaleidoscope and, once fully resolved, the cherry-pick is continued.
#[tauri::command]
pub async fn git_cherry_pick(
    path: String,
    hash: String,
    target: Option<String>,
    use_kaleidoscope: bool,
) -> Result<CherryPickResult, String> {
    run_blocking(move || {
        if let Some(t) = target.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let cur = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
            if cur.trim() != t {
                run_git_nohooks(&path, &["checkout", t])?;
            }
        }
        let applied = run_git_nohooks(&path, &["cherry-pick", &hash]);
        if applied.is_ok() {
            return Ok(CherryPickResult {
                status: "clean".to_string(),
                conflicts: Vec::new(),
            });
        }
        // Non-zero exit: a conflict leaves unmerged entries; anything else is a
        // genuine failure (dirty tree, empty commit, …) that we surface verbatim.
        let conflicts = unmerged_files(&path);
        if conflicts.is_empty() {
            return Err(applied.unwrap_err());
        }
        if use_kaleidoscope {
            // Best-effort: whatever the tool does, re-derive state from the index.
            let _ = launch_kaleidoscope_mergetool(&path);
            let remaining = unmerged_files(&path);
            if remaining.is_empty() {
                // core.editor=true accepts the prepared message without prompting.
                run_git_nohooks(&path, &["-c", "core.editor=true", "cherry-pick", "--continue"])?;
                return Ok(CherryPickResult {
                    status: "resolved".to_string(),
                    conflicts: Vec::new(),
                });
            }
            return Ok(CherryPickResult {
                status: "conflict".to_string(),
                conflicts: remaining,
            });
        }
        Ok(CherryPickResult {
            status: "conflict".to_string(),
            conflicts,
        })
    })
    .await
}

/// Stage `files` and commit them with `message`. When `name`/`email` are given,
/// the identity is injected per-commit (`git -c user.name=… -c user.email=…`)
/// without touching the repo/global config.
#[tauri::command]
pub async fn git_commit(
    path: String,
    message: String,
    files: Vec<String>,
    name: Option<String>,
    email: Option<String>,
) -> Result<(), String> {
    run_blocking(move || {
    if message.trim().is_empty() {
        return Err("提交信息不能为空".into());
    }
    if files.is_empty() {
        return Err("没有要提交的文件".into());
    }
    // Stage exactly the requested files (handles adds, modifications, deletions).
    // `git add -- <path>` matches pathspecs only against the working tree + index,
    // so a file whose deletion is ALREADY staged (gone from both) fails with
    // "pathspec … did not match any files" and aborts the whole commit. Since the
    // UI commits from the staged list, this hits any already-staged deletion.
    // `update-index --add --remove` takes literal paths and stages the current
    // worktree state for each (add / modify / delete) without that pathspec check.
    let mut add_args: Vec<&str> = vec!["update-index", "--add", "--remove", "--"];
    for f in &files {
        add_args.push(f.as_str());
    }
    run_git(&path, &add_args)?;

    // Build `[-c user.name=…] [-c user.email=…] commit -m <message>`.
    let name_cfg = name.as_deref().map(str::trim).filter(|s| !s.is_empty())
        .map(|n| format!("user.name={}", n));
    let email_cfg = email.as_deref().map(str::trim).filter(|s| !s.is_empty())
        .map(|e| format!("user.email={}", e));
    let mut args: Vec<&str> = Vec::new();
    if let Some(ref c) = name_cfg {
        args.push("-c");
        args.push(c);
    }
    if let Some(ref c) = email_cfg {
        args.push("-c");
        args.push(c);
    }
    args.push("commit");
    args.push("-m");
    args.push(message.trim());
    run_git(&path, &args)?;
    Ok(())
    })
    .await
}

// Every git op shells out to `git`, which blocks. Tauri runs synchronous `#[command]`
// fns ON THE MAIN THREAD, so a sync command that calls git freezes the whole UI for
// the duration (≈1s on a first, uncached repo load). Running the work through this
// helper hops it onto tokio's blocking pool — the UI thread stays free and the four
// parallel reads on a project switch actually run concurrently.
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("任务失败：{e}"))?
}

/// What a fetch managed to sync, so the UI can say more than "done".
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FetchSummary {
    /// Local branches fast-forwarded to their upstream.
    pub synced: Vec<String>,
    /// Branches left alone because local and remote have diverged.
    pub diverged: Vec<String>,
    /// True when the current branch was behind but the working tree is dirty.
    pub dirty_skipped: bool,
}

/// Fetch all remotes (prune deleted remote branches). `token` (optional) is used
/// for HTTP(S) auth against GitLab-style remotes. After fetching, every local
/// branch that is strictly behind its upstream is fast-forwarded, so a plain
/// 获取 leaves local in sync with the remote:
///   * diverged branches (any local-only commit) are never touched;
///   * the current branch is skipped while the working tree is dirty;
///   * branches checked out in a linked worktree are skipped (git refuses).
#[tauri::command]
pub async fn git_fetch(
    cancels: tauri::State<'_, CancelState>,
    path: String,
    token: Option<String>,
    op_id: String,
    on_progress: tauri::ipc::Channel<GitProgress>,
) -> Result<FetchSummary, String> {
    let cancels = cancels.inner().clone();
    run_blocking(move || {
        // Phase 1 — download from every remote, streaming git's own progress.
        run_git_streaming(
            &path,
            &["fetch", "--all", "--prune", "--progress"],
            token.as_deref(),
            &op_id,
            "获取中",
            &on_progress,
            &cancels,
        )?;
        // Phase 2 — fast-forward local branches. git prints nothing here, so
        // announce it ourselves; otherwise the bar would stall on "接收对象 100%".
        let _ = on_progress.send(GitProgress {
            phase: "更新本地分支".into(),
            percent: None,
            raw: "正在更新本地分支…".into(),
        });
        let summary = sync_tracking_branches(&path);
        let _ = on_progress.send(GitProgress {
            phase: "完成".into(),
            percent: Some(100),
            raw: "获取完成".into(),
        });
        Ok(summary)
    })
    .await
}

/// Fast-forward local branches onto their upstream after a fetch. Best-effort:
/// every step is allowed to fail without failing the fetch itself.
fn sync_tracking_branches(path: &str) -> FetchSummary {
    let mut sum = FetchSummary::default();
    let fmt = "%(refname:short)\x1f%(upstream)\x1f%(HEAD)";
    let Ok(out) = run_git(path, &["for-each-ref", &format!("--format={fmt}"), "refs/heads"]) else {
        return sum;
    };
    // Only read the working tree once — it can't change mid-sync.
    let dirty = run_git(path, &["status", "--porcelain"]).map(|s| !s.trim().is_empty()).unwrap_or(true);
    let worktrees = linked_worktree_branches(path);

    for line in out.lines() {
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 3 || f[1].is_empty() {
            continue; // no upstream → nothing to sync to
        }
        let (name, upstream, current) = (f[0], f[1], f[2] == "*");
        // Someone else's worktree owns this branch; leave it to that window.
        if !current && worktrees.contains_key(&format!("refs/heads/{name}")) {
            continue;
        }
        let Ok(counts) = run_git(path, &["rev-list", "--left-right", "--count", &format!("{name}...{upstream}")]) else {
            continue;
        };
        let nums: Vec<u32> = counts.split_whitespace().filter_map(|n| n.parse().ok()).collect();
        if nums.len() != 2 {
            continue;
        }
        let (ahead, behind) = (nums[0], nums[1]);
        if behind == 0 {
            continue; // already up to date (or only ahead — that's a push, not a fetch)
        }
        if ahead > 0 {
            sum.diverged.push(name.to_string()); // needs a real merge/rebase; never auto-resolve
            continue;
        }
        if current {
            if dirty {
                sum.dirty_skipped = true;
                continue;
            }
            // Hooks off so a missing git-lfs can't fail an otherwise fine FF.
            if run_git_nohooks(path, &["merge", "--ff-only", upstream]).is_ok() {
                sum.synced.push(name.to_string());
            }
        } else {
            // `fetch .` fast-forwards the ref without a checkout and refuses on
            // non-FF or a branch checked out elsewhere — git enforces safety.
            if run_git_nohooks(path, &["fetch", ".", &format!("{upstream}:refs/heads/{name}")]).is_ok() {
                sum.synced.push(name.to_string());
            }
        }
    }
    sum
}

/// One local branch that has fallen behind its upstream.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BehindBranch {
    pub name: String,
    pub upstream: String,
    pub behind: u32,
    /// Local-only commits — non-zero means diverged, which no fast-forward can fix.
    pub ahead: u32,
    pub current: bool,
}

/// What one repo's update check found.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub behind: Vec<BehindBranch>,
    /// Working tree has uncommitted changes — the current branch can't be synced.
    pub dirty: bool,
    pub current_branch: String,
}

/// Check a repo for new upstream commits WITHOUT touching any local branch: the
/// fetch only moves remote-tracking refs, then every local branch is compared to
/// its upstream. Applying the result is a separate, explicit step
/// (`git_sync_local`) so the scheduled check can report first and pull second.
///
/// Runs unattended, so it fails fast instead of hanging: a stalled HTTP transfer
/// aborts, and ssh neither prompts nor waits long on an unreachable host.
#[tauri::command]
pub async fn git_check_updates(path: String, token: Option<String>) -> Result<UpdateCheck, String> {
    run_blocking(move || {
        let mut cmd = command("git");
        cmd.arg("-C").arg(&path);
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.env("PATH", augmented_path());
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=15");
        if let Some(tok) = token.as_deref().filter(|s| !s.trim().is_empty()) {
            cmd.env("GITKIT_GL_TOKEN", tok.trim());
            cmd.arg("-c").arg("credential.helper=");
            cmd.arg("-c")
                .arg("credential.helper=!f() { echo username=oauth2; echo \"password=$GITKIT_GL_TOKEN\"; }; f");
        }
        let out = cmd
            .args([
                "-c",
                "http.lowSpeedLimit=1000",
                "-c",
                "http.lowSpeedTime=20",
                "fetch",
                "--all",
                "--prune",
                "--quiet",
            ])
            .output()
            .map_err(|e| format!("无法执行 git：{e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() { "获取失败".into() } else { err });
        }
        Ok(collect_behind(&path))
    })
    .await
}

/// Compare every local branch with its upstream (read-only; assumes a fetch just ran).
fn collect_behind(path: &str) -> UpdateCheck {
    let mut res = UpdateCheck {
        current_branch: run_git(path, &["branch", "--show-current"])
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
        dirty: run_git(path, &["status", "--porcelain"])
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
        behind: Vec::new(),
    };
    let fmt = "%(refname:short)\x1f%(upstream)\x1f%(HEAD)";
    let Ok(out) = run_git(path, &["for-each-ref", &format!("--format={fmt}"), "refs/heads"]) else {
        return res;
    };
    for line in out.lines() {
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 3 || f[1].is_empty() {
            continue; // no upstream → nothing to compare against
        }
        let (name, upstream, current) = (f[0], f[1], f[2] == "*");
        let Ok(counts) = run_git(
            path,
            &["rev-list", "--left-right", "--count", &format!("{name}...{upstream}")],
        ) else {
            continue;
        };
        let nums: Vec<u32> = counts.split_whitespace().filter_map(|n| n.parse().ok()).collect();
        if nums.len() != 2 || nums[1] == 0 {
            continue; // up to date, or only ahead — that's a push, not an update
        }
        res.behind.push(BehindBranch {
            name: name.to_string(),
            upstream: upstream.trim_start_matches("refs/remotes/").to_string(),
            behind: nums[1],
            ahead: nums[0],
            current,
        });
    }
    res
}

/// Fast-forward local branches onto their already-fetched upstreams — the "pull"
/// half of the check → pull flow. No network: the refs came in with the check.
/// Same safety rules as the tail of a fetch (diverged branches and a dirty current
/// branch are reported, never forced).
#[tauri::command]
pub async fn git_sync_local(path: String) -> Result<FetchSummary, String> {
    run_blocking(move || Ok(sync_tracking_branches(&path))).await
}

/// Check out `branch` and fast-forward it to `hash` (a remote commit), syncing the
/// local branch up to the remote without merging or losing history.
#[tauri::command]
pub async fn git_checkout_sync(path: String, branch: String, hash: String) -> Result<(), String> {
    run_blocking(move || {
        // Skip the checkout when already on the target branch — re-checking-out
        // the current branch is a no-op that still fires the post-checkout hook
        // (and prints "Already on 'X'"), which is pure noise for a plain FF-sync.
        let cur = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        if cur.trim() != branch.trim() {
            run_git_nohooks(&path, &["checkout", &branch])?;
        }
        run_git_nohooks(&path, &["merge", "--ff-only", &hash])?;
        Ok(())
    })
    .await
}

/// Pull the current branch from its upstream.
#[tauri::command]
pub async fn git_pull(
    cancels: tauri::State<'_, CancelState>,
    path: String,
    token: Option<String>,
    op_id: String,
    on_progress: tauri::ipc::Channel<GitProgress>,
) -> Result<(), String> {
    let cancels = cancels.inner().clone();
    run_blocking(move || {
        // Disable hooks (LFS post-merge/checkout) so a missing git-lfs can't fail a
        // pull that otherwise succeeds; auth token still passes through. Streamed so
        // the UI shows the fetch phase's progress and can be cancelled.
        run_git_streaming(
            &path,
            &["-c", "core.hooksPath=/dev/null", "pull", "--progress"],
            token.as_deref(),
            &op_id,
            "拉取中",
            &on_progress,
            &cancels,
        )
    })
    .await
}

/// Push the current branch. Sets the upstream automatically if it has none.
#[tauri::command]
pub async fn git_push(path: String, token: Option<String>) -> Result<(), String> {
    run_blocking(move || {
        let tok = token.as_deref();
        // Push with the given args, keeping hooks so a working git-lfs uploads its
        // objects via the pre-push hook. If that hook fails only because git-lfs
        // isn't installed (it *aborts* the push, unlike post-* hooks), retry once
        // with hooks disabled so the push still lands — LFS objects can't be
        // uploaded without git-lfs anyway.
        let push = |args: &[&str]| -> Result<(), String> {
            match run_git_auth(&path, args, tok) {
                Ok(_) => Ok(()),
                Err(e) if is_lfs_missing(&e) => {
                    let mut a: Vec<&str> = vec!["-c", "core.hooksPath=/dev/null"];
                    a.extend_from_slice(args);
                    run_git_auth(&path, &a, tok).map(|_| ())
                }
                Err(e) => Err(e),
            }
        };
        match push(&["push"]) {
            Ok(_) => Ok(()),
            Err(e) => {
                if e.contains("has no upstream") || e.contains("set-upstream") || e.contains("--set-upstream") {
                    let branch = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
                    let branch = branch.trim().to_string();
                    push(&["push", "--set-upstream", "origin", &branch])
                } else {
                    Err(e)
                }
            }
        }
    })
    .await
}

/// Create a branch `name` from `base`. When `checkout` is true, switch to it
/// (`git checkout -b`); otherwise just create it (`git branch`).
#[tauri::command]
pub async fn git_create_branch(
    path: String,
    name: String,
    base: String,
    checkout: bool,
) -> Result<(), String> {
    run_blocking(move || {
    let name = name.trim();
    let base = base.trim();
    if name.is_empty() {
        return Err("分支名称不能为空".into());
    }
    if checkout {
        run_git_nohooks(&path, &["checkout", "-b", name, base])?;
    } else {
        run_git(&path, &["branch", name, base])?;
    }
    Ok(())
    })
    .await
}

/// Delete a local branch. `force` uses `-D` (drops unmerged commits); otherwise
/// `-d`, which refuses to delete a branch whose work isn't merged. Cannot delete
/// the currently checked-out branch (git rejects it).
#[tauri::command]
pub async fn git_delete_branch(path: String, name: String, force: bool) -> Result<(), String> {
    run_blocking(move || {
        let name = name.trim();
        if name.is_empty() {
            return Err("分支名称不能为空".into());
        }
        run_git(&path, &["branch", if force { "-D" } else { "-d" }, name]).map_err(|e| {
            // A branch checked out in a linked worktree is refused even by `-D`.
            // git's wording ("cannot delete branch 'x' used by worktree at 'y'")
            // gives no way out, so name the real blocker and the path.
            if let Some(wt) = worktree_path_from_error(&e) {
                format!("分支 {name} 正被工作树占用：{wt}\n需要先移除该工作树才能删除分支。")
            } else {
                e
            }
        })?;
        Ok(())
    })
    .await
}

/// Whether `worktree` is still listed as a worktree of this repository.
fn worktree_is_registered(path: &str, worktree: &str) -> bool {
    match run_git(path, &["worktree", "list", "--porcelain"]) {
        Ok(out) => out
            .lines()
            .filter_map(|l| l.strip_prefix("worktree "))
            .any(|p| p.trim() == worktree),
        // Can't tell → assume it's there so the caller still reports a failure.
        Err(_) => true,
    }
}

/// Pull the worktree path out of git's "used by worktree at '<path>'" error.
fn worktree_path_from_error(err: &str) -> Option<String> {
    let rest = err.split("used by worktree at ").nth(1)?;
    let rest = rest.trim_start().strip_prefix('\'')?;
    let end = rest.find('\'')?;
    Some(rest[..end].to_string())
}

/// Remove a linked worktree (`git worktree remove --force`). `--force` is
/// required because these worktrees are typically dirty — the caller is
/// expected to have confirmed the loss of uncommitted work. If the directory is
/// already gone but still registered, prune the stale record and retry.
#[tauri::command]
pub async fn git_remove_worktree(path: String, worktree: String) -> Result<(), String> {
    run_blocking(move || {
        let worktree = worktree.trim();
        if worktree.is_empty() {
            return Err("工作树路径不能为空".into());
        }
        match run_git(&path, &["worktree", "remove", "--force", worktree]) {
            Ok(_) => Ok(()),
            Err(e) => {
                let _ = run_git(&path, &["worktree", "prune"]);
                // Prune only clears *stale* records. If it dropped this one the
                // job is done; otherwise the worktree really is still there and
                // the original error is the useful one to surface.
                if !worktree_is_registered(&path, worktree) {
                    return Ok(());
                }
                run_git(&path, &["worktree", "remove", "--force", worktree])
                    .map(|_| ())
                    .map_err(|_| e)
            }
        }
    })
    .await
}

/// Rename a local branch (`git branch -m from to`). Works on the current branch
/// too. Refuses when `to` already exists (git errors, surfaced to the caller).
#[tauri::command]
pub async fn git_rename_branch(path: String, from: String, to: String) -> Result<(), String> {
    run_blocking(move || {
        let from = from.trim();
        let to = to.trim();
        if to.is_empty() {
            return Err("新分支名称不能为空".into());
        }
        run_git(&path, &["branch", "-m", from, to])?;
        Ok(())
    })
    .await
}

#[derive(serde::Serialize)]
pub struct TagInfo {
    pub name: String,
    pub target: String,
    pub date: String,
    pub subject: String,
}

/// List all tags, newest first. `target` is the short hash the tag points at,
/// `subject` the annotation message subject (or the commit subject for
/// lightweight tags).
#[tauri::command]
pub async fn git_tags(path: String) -> Result<Vec<TagInfo>, String> {
    run_blocking(move || {
        let out = run_git(
            &path,
            &[
                "for-each-ref",
                "--sort=-creatordate",
                "refs/tags",
                "--format=%(refname:short)\x1f%(objectname:short)\x1f%(creatordate:short)\x1f%(contents:subject)",
            ],
        )?;
        let mut tags = Vec::new();
        for line in out.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let f: Vec<&str> = line.splitn(4, '\x1f').collect();
            tags.push(TagInfo {
                name: f.first().unwrap_or(&"").to_string(),
                target: f.get(1).unwrap_or(&"").to_string(),
                date: f.get(2).unwrap_or(&"").to_string(),
                subject: f.get(3).unwrap_or(&"").to_string(),
            });
        }
        Ok(tags)
    })
    .await
}

/// Create a tag on the current HEAD. A non-empty `message` makes it an
/// annotated tag (`git tag -a`, records tagger + date); an empty one makes a
/// lightweight tag (a bare pointer).
#[tauri::command]
pub async fn git_create_tag(path: String, name: String, message: String) -> Result<(), String> {
    run_blocking(move || {
        let name = name.trim();
        if name.is_empty() {
            return Err("标签名不能为空".into());
        }
        let msg = message.trim();
        if msg.is_empty() {
            run_git(&path, &["tag", name])?;
        } else {
            run_git(&path, &["tag", "-a", name, "-m", msg])?;
        }
        Ok(())
    })
    .await
}

/// Push a single tag to `origin`.
#[tauri::command]
pub async fn git_push_tag(path: String, name: String, token: Option<String>) -> Result<(), String> {
    run_blocking(move || {
        let n = name.trim();
        if n.is_empty() {
            return Err("标签名不能为空".into());
        }
        run_git_auth(&path, &["push", "origin", n], token.as_deref()).map(|_| ())
    })
    .await
}

/// Stash working-tree changes (including untracked files).
#[tauri::command]
pub async fn git_stash_push(path: String, message: String) -> Result<(), String> {
    run_blocking(move || {
    let msg = if message.trim().is_empty() {
        "GitKit stash".to_string()
    } else {
        message
    };
    run_git(&path, &["stash", "push", "-u", "-m", &msg])?;
    Ok(())
    })
    .await
}

#[derive(Serialize)]
pub struct StashEntry {
    index: usize,
    message: String,
    date: String, // relative, e.g. "2 hours ago"
}

/// List stash entries, newest first (stash@{0} first).
#[tauri::command]
pub async fn git_stash_list(path: String) -> Result<Vec<StashEntry>, String> {
    run_blocking(move || {
        // %gs = reflog subject ("On <branch>: <msg>"), %cr = relative date. \x1f field sep.
        let out = run_git(&path, &["stash", "list", "--format=%gs%x1f%cr"])?;
        let mut list = Vec::new();
        for (i, line) in out.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let mut parts = line.split('\u{1f}');
            let raw = parts.next().unwrap_or("");
            let date = parts.next().unwrap_or("").to_string();
            // Strip the "On <branch>: " / "WIP on <branch>: " prefix for a cleaner label.
            let message = raw.splitn(2, ": ").nth(1).unwrap_or(raw).trim().to_string();
            list.push(StashEntry { index: i, message, date });
        }
        Ok(list)
    })
    .await
}

#[derive(Serialize)]
pub struct MergePreview {
    pub conflict: bool,
    pub files: Vec<String>,
}

/// Detect whether merging `source` into `target` would conflict, without touching
/// the working tree, index, or any refs. Uses `git merge-tree --write-tree` (git
/// 2.38+), whose exit code is 1 on conflict — so we shell out directly rather than
/// via run_git, which treats any non-zero exit as a hard error.
#[tauri::command]
pub async fn git_merge_preview(
    path: String,
    source: String,
    target: String,
) -> Result<MergePreview, String> {
    run_blocking(move || {
        let out = command("git")
            .arg("-C")
            .arg(&path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("PATH", augmented_path())
            .args([
                "merge-tree",
                "--write-tree",
                "--name-only",
                target.as_str(),
                source.as_str(),
            ])
            .output()
            .map_err(|e| format!("无法执行 git：{e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        match out.status.code().unwrap_or(-1) {
            // Clean merge: stdout is just the merged tree OID.
            0 => Ok(MergePreview { conflict: false, files: vec![] }),
            // Conflict: line 0 is the tree OID; the conflicted-file section follows,
            // one path per line (thanks to --name-only), terminated by a blank line
            // before git's informational messages.
            1 => {
                let mut files = Vec::new();
                let mut seen = std::collections::HashSet::new();
                for line in stdout.lines().skip(1) {
                    if line.trim().is_empty() {
                        break;
                    }
                    let f = line.trim().to_string();
                    if seen.insert(f.clone()) {
                        files.push(f);
                    }
                }
                Ok(MergePreview { conflict: true, files })
            }
            // Old git without --write-tree, bad ref, etc. — surface as an error so
            // the caller can degrade gracefully (skip the conflict hint).
            _ => {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                Err(if err.is_empty() {
                    "无法检测合并冲突".to_string()
                } else {
                    err
                })
            }
        }
    })
    .await
}

/// Apply a stash entry to the working tree (keeps the entry in the stash list).
#[tauri::command]
pub async fn git_stash_apply(path: String, index: usize) -> Result<(), String> {
    run_blocking(move || {
        run_git(&path, &["stash", "apply", &format!("stash@{{{index}}}")])?;
        Ok(())
    })
    .await
}

/// Delete a stash entry.
#[tauri::command]
pub async fn git_stash_drop(path: String, index: usize) -> Result<(), String> {
    run_blocking(move || {
        run_git(&path, &["stash", "drop", &format!("stash@{{{index}}}")])?;
        Ok(())
    })
    .await
}

/// Files changed in a stash — diffed against its base commit (first parent), which
/// sidesteps the multi-parent merge-commit quirks of `git show` on a stash.
#[tauri::command]
pub async fn git_stash_files(path: String, index: usize) -> Result<Vec<FileStat>, String> {
    run_blocking(move || {
        let base = format!("stash@{{{index}}}^1");
        let stash = format!("stash@{{{index}}}");
        let numstat = run_git(&path, &["diff", "--numstat", "-M", "-z", &base, &stash])?;
        let names = run_git(&path, &["diff", "--name-status", "-M", "-z", &base, &stash])?;
        Ok(parse_diff_files(&numstat, &names))
    })
    .await
}

/// Diff of a single file within a stash (against the stash's base commit).
#[tauri::command]
pub async fn git_stash_file_diff(path: String, index: usize, file: String) -> Result<String, String> {
    run_blocking(move || {
        let base = format!("stash@{{{index}}}^1");
        let stash = format!("stash@{{{index}}}");
        run_git(&path, &["diff", "-M", &base, &stash, "--", &file])
    })
    .await
}

#[derive(Serialize)]
pub struct FilePreview {
    kind: String, // "text" | "binary" | "too_large" | "empty" | "missing"
    diff: String, // '+'-prefixed lines, so it renders as an all-additions diff
    lines: usize, // total lines in the file
    truncated: bool,
    size: u64,
}

/// Preview an untracked/new file by reading it directly (no git subprocess).
/// Guards for performance: skips files over 1 MB, detects binary via a null-byte
/// scan, and caps the returned diff to 2000 lines so rendering stays cheap.
#[tauri::command]
pub async fn file_preview(path: String, file: String) -> Result<FilePreview, String> {
    run_blocking(move || {
    const MAX_SIZE: u64 = 1_000_000;
    const MAX_LINES: usize = 2000;
    let empty = |kind: &str, size: u64| FilePreview {
        kind: kind.into(), diff: String::new(), lines: 0, truncated: false, size,
    };

    let full = std::path::Path::new(&path).join(&file);
    let meta = match std::fs::metadata(&full) {
        Ok(m) => m,
        Err(_) => return Ok(empty("missing", 0)),
    };
    let size = meta.len();
    if size == 0 {
        return Ok(empty("empty", 0));
    }
    if size > MAX_SIZE {
        return Ok(empty("too_large", size));
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    let sample = bytes.len().min(8192);
    if bytes[..sample].contains(&0u8) {
        return Ok(empty("binary", size));
    }
    let text = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => return Ok(empty("binary", size)),
    };
    let total = text.lines().count();
    let mut diff = String::new();
    for line in text.lines().take(MAX_LINES) {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    Ok(FilePreview { kind: "text".into(), diff, lines: total, truncated: total > MAX_LINES, size })
    })
    .await
}

/// Diff of a single working-tree file. Staging in GitKit is app-side (git's index
/// isn't touched until commit), so we always show the TOTAL change vs HEAD — that
/// way a file previews the same whether it sits in the staged or unstaged list.
/// `_staged` is kept for API compatibility. Falls back to the index diff in a repo
/// with no commits yet.
#[tauri::command]
pub async fn working_file_diff(path: String, file: String, _staged: bool) -> Result<String, String> {
    run_blocking(move || {
        match run_git(&path, &["diff", "HEAD", "--", file.as_str()]) {
            Ok(d) => Ok(d),
            Err(_) => run_git(&path, &["diff", "--", file.as_str()]),
        }
    })
    .await
}

/// Test a GitHub / GitHub Enterprise connection via `GET {api}/user`. `url` is
/// the instance root (blank/`github.com` → api.github.com; a GHE host → `{host}/api/v3`).
#[tauri::command]
pub async fn github_test(url: String, token: String) -> Result<String, String> {
    if token.trim().is_empty() {
        return Err("请填写访问令牌".into());
    }
    let base = url.trim().trim_end_matches('/');
    let api = if base.is_empty() || base.ends_with("github.com") {
        "https://api.github.com".to_string()
    } else if base.contains("api.github.com") {
        base.to_string()
    } else {
        format!("{}/api/v3", base)
    };
    let endpoint = format!("{}/user", api);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&endpoint)
        .header("Authorization", format!("Bearer {}", token.trim()))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "GitKit") // GitHub rejects requests with no User-Agent
        .send()
        .await
        .map_err(|e| format!("无法连接：{}", e))?;
    let status = resp.status();
    if status.is_success() {
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let login = v.get("login").and_then(|x| x.as_str()).unwrap_or("");
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
        Ok(if name.is_empty() { format!("@{}", login) } else { format!("{} (@{})", name, login) })
    } else if status.as_u16() == 401 {
        Err("认证失败：令牌无效或权限不足".into())
    } else if status.as_u16() == 404 {
        Err("接口未找到：请确认地址是 GitHub 实例根地址".into())
    } else {
        Err(format!("请求失败：HTTP {}", status.as_u16()))
    }
}

/// Test a self-hosted GitLab connection by calling `GET /api/v4/user` with the
/// personal access token. Runs in Rust (no browser CORS). Returns "name (@login)".
#[tauri::command]
pub async fn gitlab_test(url: String, token: String) -> Result<String, String> {
    let base = url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请填写 GitLab 地址".into());
    }
    if token.trim().is_empty() {
        return Err("请填写访问令牌".into());
    }
    let api = format!("{}/api/v4/user", base);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&api)
        .header("PRIVATE-TOKEN", token.trim())
        .send()
        .await
        .map_err(|e| format!("无法连接：{}", e))?;
    let status = resp.status();
    if status.is_success() {
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let login = v.get("username").and_then(|x| x.as_str()).unwrap_or("");
        Ok(format!("{} (@{})", name, login))
    } else if status.as_u16() == 401 {
        Err("认证失败：令牌无效或权限不足".into())
    } else if status.as_u16() == 404 {
        Err("接口未找到：请确认地址是 GitLab 实例根地址".into())
    } else {
        Err(format!("请求失败：HTTP {}", status.as_u16()))
    }
}

/// "owner/repo" (GitHub) or "group/…/project" (GitLab) parsed from a remote URL.
fn repo_path_from_remote(url: &str) -> String {
    let u = url.trim();
    let after_host: &str = if let Some(rest) = u.strip_prefix("http://").or_else(|| u.strip_prefix("https://")) {
        rest.find('/').map(|i| &rest[i + 1..]).unwrap_or("")
    } else if let Some(idx) = u.find('@') {
        let rest = &u[idx + 1..];
        rest.find(':').map(|i| &rest[i + 1..]).unwrap_or("")
    } else {
        ""
    };
    after_host
        .trim_start_matches('/')
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or(after_host.trim_start_matches('/').trim_end_matches('/'))
        .to_string()
}

/// Percent-encode a GitLab project path (slashes → %2F) for use as the :id.
fn urlencode_path(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}

fn github_api_base(url: &str) -> String {
    let base = url.trim().trim_end_matches('/');
    if base.is_empty() || base.ends_with("github.com") {
        "https://api.github.com".to_string()
    } else if base.contains("api.github.com") {
        base.to_string()
    } else {
        format!("{}/api/v3", base)
    }
}

/// Open a URL in the user's default browser (cross-platform: macOS `open`,
/// Windows `cmd /C start`, other unix `xdg-open`). Best-effort; errors ignored.
fn open_in_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

/// Create a merge/pull request on the remote and open it in the browser.
/// Returns the web URL of the created request.
#[tauri::command]
pub async fn create_pull_request(
    provider: String,     // "gitlab" | "github"
    instance_url: String, // configured instance root (may be empty for github.com)
    remote_url: String,   // origin URL, to parse the project path
    token: String,
    source: String,
    target: String,
    title: String,
    description: String,
) -> Result<String, String> {
    if title.trim().is_empty() {
        return Err("标题不能为空".into());
    }
    if source.trim() == target.trim() {
        return Err("来源分支与目标分支不能相同".into());
    }
    let path = repo_path_from_remote(&remote_url);
    if path.is_empty() {
        return Err("无法从远程地址解析仓库路径".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let web_url = if provider == "github" {
        let base = github_api_base(&instance_url);
        let mut seg = path.splitn(2, '/');
        let owner = seg.next().unwrap_or("");
        let repo = seg.next().unwrap_or("");
        let endpoint = format!("{}/repos/{}/{}/pulls", base, owner, repo);
        let body = serde_json::json!({
            "title": title.trim(), "head": source.trim(), "base": target.trim(), "body": description,
        });
        let resp = client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", token.trim()))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "GitKit")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("请求失败：{}", e))?;
        let ok = resp.status().is_success();
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        if ok {
            v.get("html_url").and_then(|x| x.as_str()).unwrap_or("").to_string()
        } else {
            let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("创建失败");
            return Err(format!("GitHub：{}", msg));
        }
    } else {
        let base = instance_url.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err("请先在设置中填写 GitLab 实例地址".into());
        }
        let endpoint = format!("{}/api/v4/projects/{}/merge_requests", base, urlencode_path(&path));
        let body = serde_json::json!({
            "source_branch": source.trim(), "target_branch": target.trim(),
            "title": title.trim(), "description": description,
        });
        let resp = client
            .post(&endpoint)
            .header("PRIVATE-TOKEN", token.trim())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("请求失败：{}", e))?;
        let ok = resp.status().is_success();
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        if ok {
            v.get("web_url").and_then(|x| x.as_str()).unwrap_or("").to_string()
        } else {
            let msg = v
                .get("message")
                .or_else(|| v.get("error"))
                .map(|m| m.to_string())
                .unwrap_or_else(|| "创建失败".into());
            return Err(format!("GitLab：{}", msg));
        }
    };

    if !web_url.is_empty() {
        open_in_browser(&web_url);
    }
    Ok(web_url)
}

#[derive(Serialize)]
pub struct GithubRepo {
    pub clone_url: String,
    pub html_url: String,
    pub full_name: String,
}

/// Create a repository on GitHub / GitHub Enterprise under the token's account
/// (`POST {api}/user/repos`) and return its URLs. Bootstraps a remote for a
/// local-only repo; the caller then wires it as `origin` and pushes.
#[tauri::command]
pub async fn github_create_repo(
    instance_url: String,
    token: String,
    name: String,
    private: bool,
    description: String,
) -> Result<GithubRepo, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("仓库名称不能为空".into());
    }
    if token.trim().is_empty() {
        return Err("请先配置访问令牌".into());
    }
    let endpoint = format!("{}/user/repos", github_api_base(&instance_url));
    let body = serde_json::json!({
        "name": name,
        "private": private,
        "description": description.trim(),
        "auto_init": false,
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", token.trim()))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "GitKit")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{}", e))?;
    let status = resp.status();
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if status.is_success() {
        Ok(GithubRepo {
            clone_url: v.get("clone_url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            html_url: v.get("html_url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            full_name: v.get("full_name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        })
    } else if status.as_u16() == 401 {
        Err("认证失败：令牌无效或权限不足（需 repo 权限）".into())
    } else {
        let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("创建失败");
        // 422 usually carries a more specific reason (e.g. name already exists).
        let extra = v
            .get("errors")
            .and_then(|e| e.as_array())
            .and_then(|a| a.first())
            .and_then(|e| e.get("message").and_then(|m| m.as_str()));
        Err(match extra {
            Some(x) => format!("GitHub：{}（{}）", msg, x),
            None => format!("GitHub：{}", msg),
        })
    }
}

/// Add a remote (`git remote add <name> <url>`) to a local repo.
#[tauri::command]
pub async fn git_remote_add(path: String, name: String, url: String) -> Result<(), String> {
    run_blocking(move || run_git(&path, &["remote", "add", &name, &url]).map(|_| ())).await
}

/// One streamed progress update from a running `git clone`, pushed to the
/// frontend over a channel. `percent` is `None` for lines that carry no
/// percentage (e.g. "Cloning into …", "remote: Enumerating objects: 1234").
#[derive(Clone, Serialize)]
pub struct CloneProgress {
    pub phase: String,        // short Chinese label for the current step
    pub percent: Option<u32>, // 0..=100 within the current step
    pub raw: String,          // the raw git line, for a detail readout
}

/// The directory name `git clone` would create for a URL: the last path segment
/// with a trailing ".git" stripped. Handles https ("https://host/group/repo.git")
/// and scp-style ssh ("git@host:group/repo.git"); falls back to "repo".
fn repo_name_from_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let last = trimmed.rsplit(|c| c == '/' || c == ':').next().unwrap_or("");
    let name = last.strip_suffix(".git").unwrap_or(last).trim();
    if name.is_empty() {
        "repo".to_string()
    } else {
        name.to_string()
    }
}

/// Map a `git --progress` line (clone/fetch/pull share the same transfer phases)
/// to a short Chinese phase label. `fallback` is used for lines that carry no
/// recognizable phase (e.g. "From github.com:…") — clone passes "克隆中", fetch
/// "获取中", etc.
fn transfer_phase_label(line: &str, fallback: &str) -> String {
    let label = if line.contains("Receiving objects") {
        "接收对象"
    } else if line.contains("Resolving deltas") {
        "处理增量"
    } else if line.contains("Compressing objects") {
        "压缩对象"
    } else if line.contains("Counting objects") {
        "统计对象"
    } else if line.contains("Enumerating objects") {
        "枚举对象"
    } else if line.contains("Updating files") || line.contains("Checking out files") {
        "检出文件"
    } else if line.starts_with("Cloning") {
        "准备克隆"
    } else {
        fallback
    };
    label.to_string()
}

/// Extract the first "NN%" percentage from a git progress line, if present.
fn parse_clone_percent(line: &str) -> Option<u32> {
    let bytes = line.as_bytes();
    let pct = line.find('%')?;
    let mut start = pct;
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    if start == pct {
        return None;
    }
    line[start..pct].parse::<u32>().ok().map(|p| p.min(100))
}

/// One streamed progress update from a running fetch/pull, pushed to the
/// frontend over a channel. Same shape as `CloneProgress`; kept separate so the
/// two transfer flows can carry different phase vocabularies without coupling.
#[derive(Clone, Serialize)]
pub struct GitProgress {
    pub phase: String,        // short Chinese label for the current step
    pub percent: Option<u32>, // 0..=100 within the current step
    pub raw: String,          // the raw git line, for a detail readout
}

/// A handle to one running, cancellable git subprocess plus the flag `git_cancel`
/// sets to mark it user-cancelled (so the runner reports 取消 instead of failure).
type CancelHandle = (Arc<Mutex<std::process::Child>>, Arc<AtomicBool>);

/// Running, cancellable git subprocesses (fetch/pull) keyed by a frontend-supplied
/// op id. Kept in Tauri managed state; `git_cancel(op_id)` looks the child up and
/// kills it, which EOFs its stderr and unwinds the streaming loop. Wrapped in an
/// `Arc` so a command can clone the map out of `State` and move it into the
/// blocking worker thread.
#[derive(Default, Clone)]
pub struct CancelState(pub Arc<Mutex<HashMap<String, CancelHandle>>>);

/// Sentinel error a cancelled op returns; the frontend maps it to a quiet "已取消"
/// toast instead of a red failure.
const CANCELLED: &str = "__cancelled__";

/// Run a git command that reports `--progress` on stderr, streaming each line to
/// the UI as a `GitProgress` and honoring cancellation via `CancelState`. Mirrors
/// the streaming loop in `git_clone`. `fallback_phase` labels lines with no
/// recognizable transfer phase. Registers the child under `op_id` so
/// `git_cancel(op_id)` can kill it; returns `Err(CANCELLED)` when that happens.
fn run_git_streaming(
    repo: &str,
    args: &[&str],
    token: Option<&str>,
    op_id: &str,
    fallback_phase: &str,
    on_progress: &tauri::ipc::Channel<GitProgress>,
    cancels: &CancelState,
) -> Result<(), String> {
    let mut cmd = command("git");
    cmd.arg("-C").arg(repo);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("PATH", augmented_path());
    if let Some(tok) = token.filter(|s| !s.trim().is_empty()) {
        cmd.env("GITKIT_GL_TOKEN", tok.trim());
        cmd.arg("-c").arg("credential.helper=");
        cmd.arg("-c")
            .arg("credential.helper=!f() { echo username=oauth2; echo \"password=$GITKIT_GL_TOKEN\"; }; f");
    }
    cmd.args(args);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("无法执行 git：{e}"))?;
    let stderr = child.stderr.take().ok_or("无法读取 git 输出")?;
    let mut reader = std::io::BufReader::new(stderr);

    // Register for cancellation. The `cancelled` flag distinguishes a user kill
    // from a real failure regardless of the child's exit status.
    let cancelled = Arc::new(AtomicBool::new(false));
    let child = Arc::new(Mutex::new(child));
    if let Ok(mut m) = cancels.0.lock() {
        m.insert(op_id.to_string(), (child.clone(), cancelled.clone()));
    }

    // Same read-a-byte, split-on-\r-or-\n loop as clone: git refreshes progress
    // in place with '\r'. The BufReader buffers the real syscalls.
    let mut buf: Vec<u8> = Vec::new();
    let mut byte = [0u8; 1];
    let mut tail: Vec<String> = Vec::new(); // recent lines, for an error message
    loop {
        match std::io::Read::read(&mut reader, &mut byte) {
            Ok(0) => break,
            Ok(_) => {
                let c = byte[0];
                if c == b'\r' || c == b'\n' {
                    if !buf.is_empty() {
                        let line = String::from_utf8_lossy(&buf).trim().to_string();
                        buf.clear();
                        if !line.is_empty() {
                            let _ = on_progress.send(GitProgress {
                                phase: transfer_phase_label(&line, fallback_phase),
                                percent: parse_clone_percent(&line),
                                raw: line.clone(),
                            });
                            tail.push(line);
                            if tail.len() > 10 {
                                tail.remove(0);
                            }
                        }
                    }
                } else {
                    buf.push(c);
                }
            }
            Err(_) => break,
        }
    }

    // Deregister, then reap. stderr EOF means the process is already exiting (on
    // its own or via a cancel kill), so this wait() returns promptly.
    if let Ok(mut m) = cancels.0.lock() {
        m.remove(op_id);
    }
    let status = child.lock().unwrap().wait().map_err(|e| format!("git 执行失败：{e}"))?;
    if cancelled.load(Ordering::SeqCst) {
        return Err(CANCELLED.into());
    }
    if !status.success() {
        let msg = tail
            .iter()
            .rev()
            .find(|l| l.contains("fatal") || l.contains("error"))
            .cloned()
            .or_else(|| tail.last().cloned())
            .unwrap_or_else(|| "操作失败".into());
        return Err(msg);
    }
    Ok(())
}

/// Cancel a running fetch/pull by op id: kill its subprocess and flag it so the
/// runner reports a cancel rather than a failure. No-op if the op already ended.
#[tauri::command]
pub fn git_cancel(cancels: tauri::State<'_, CancelState>, op_id: String) -> Result<(), String> {
    // Clone the handle out under the map lock, then release it before killing so
    // we never hold the map lock across the child lock.
    let entry = cancels.0.lock().map_err(|e| e.to_string())?.get(&op_id).cloned();
    if let Some((child, flag)) = entry {
        flag.store(true, Ordering::SeqCst);
        let _ = child.lock().map(|mut c| c.kill());
    }
    Ok(())
}

/// Clone `url` into a NEW subdirectory of `dest` (the parent folder the user
/// picked), streaming git's progress to the frontend via the `on_progress`
/// channel. Returns the absolute path of the cloned repository on success.
///
/// `token` (optional) is fed to HTTP(S) auth as `oauth2:<token>` via a one-shot
/// credential helper — the same mechanism as fetch/pull/push; SSH URLs use the
/// user's existing keys. `GIT_TERMINAL_PROMPT=0` makes auth failures fail fast
/// instead of hanging on an interactive prompt.
#[tauri::command]
pub async fn git_clone(
    url: String,
    dest: String,
    token: Option<String>,
    on_progress: tauri::ipc::Channel<CloneProgress>,
) -> Result<String, String> {
    run_blocking(move || {
        let url = url.trim().to_string();
        if url.is_empty() {
            return Err("请填写仓库地址".into());
        }
        let parent = std::path::Path::new(dest.trim());
        if dest.trim().is_empty() || !parent.is_dir() {
            return Err("请选择一个有效的目标文件夹".into());
        }
        let target = parent.join(repo_name_from_url(&url));
        if target.exists() {
            return Err(format!("目标已存在，请换个位置或先删除：{}", target.display()));
        }
        let target_str = target.to_string_lossy().to_string();

        let mut cmd = command("git");
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.env("PATH", augmented_path());
        if let Some(tok) = token.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            cmd.env("GITKIT_GL_TOKEN", tok);
            cmd.arg("-c").arg("credential.helper=");
            cmd.arg("-c").arg(
                "credential.helper=!f() { echo username=oauth2; echo \"password=$GITKIT_GL_TOKEN\"; }; f",
            );
        }
        cmd.args(["clone", "--progress", &url, &target_str]);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("无法执行 git：{e}"))?;
        let stderr = child.stderr.take().ok_or("无法读取 git 输出")?;
        let mut reader = std::io::BufReader::new(stderr);

        let _ = on_progress.send(CloneProgress {
            phase: "准备克隆".into(),
            percent: None,
            raw: format!("克隆 {url}"),
        });

        // git emits progress with '\r' (in-place refresh) and '\n' (new line), so
        // split on either. Read a byte at a time — the BufReader buffers the actual
        // syscalls, so this isn't a per-byte read on the pipe.
        let mut buf: Vec<u8> = Vec::new();
        let mut byte = [0u8; 1];
        let mut tail: Vec<String> = Vec::new(); // recent lines, for an error message
        loop {
            match std::io::Read::read(&mut reader, &mut byte) {
                Ok(0) => break,
                Ok(_) => {
                    let c = byte[0];
                    if c == b'\r' || c == b'\n' {
                        if !buf.is_empty() {
                            let line = String::from_utf8_lossy(&buf).trim().to_string();
                            buf.clear();
                            if !line.is_empty() {
                                let _ = on_progress.send(CloneProgress {
                                    phase: transfer_phase_label(&line, "克隆中"),
                                    percent: parse_clone_percent(&line),
                                    raw: line.clone(),
                                });
                                tail.push(line);
                                if tail.len() > 10 {
                                    tail.remove(0);
                                }
                            }
                        }
                    } else {
                        buf.push(c);
                    }
                }
                Err(_) => break,
            }
        }

        let status = child.wait().map_err(|e| format!("git 执行失败：{e}"))?;
        if !status.success() {
            // Prefer a fatal/error line; otherwise the last thing git printed.
            let msg = tail
                .iter()
                .rev()
                .find(|l| l.contains("fatal") || l.contains("error"))
                .cloned()
                .or_else(|| tail.last().cloned())
                .unwrap_or_else(|| "克隆失败".into());
            return Err(msg);
        }

        let _ = on_progress.send(CloneProgress {
            phase: "完成".into(),
            percent: Some(100),
            raw: "克隆完成".into(),
        });
        Ok(target_str)
    })
    .await
}

/// Live filesystem watchers, one per watched repo path. Kept in Tauri managed
/// state so the OS watch stays alive until `stop_watch` drops it. Replaces the
/// old 3-second `git status` polling: edits show up as soon as the OS reports
/// them (tens of ms) instead of on the next poll tick.
#[derive(Default)]
pub struct WatchState(pub Mutex<HashMap<String, RecommendedWatcher>>);

const WATCH_PATH_LIMIT: usize = 256;

#[derive(Default)]
struct WatchBatch {
    paths: HashSet<String>,
    full: bool,
}

#[derive(Clone, Serialize)]
struct WorkingTreeChanged {
    path: String,
    paths: Vec<String>,
    full: bool,
}

fn path_in_git(p: &std::path::Path) -> bool {
    p.components().any(|component| component.as_os_str() == ".git")
}

fn git_relative_path(p: &std::path::Path) -> String {
    p.components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// Working-tree writes always affect status. Inside `.git`, only metadata that
/// can change the visible working state is relevant; objects, logs and lock
/// files are intentionally ignored to avoid event storms during fetches.
fn path_triggers_status(p: &std::path::Path) -> bool {
    let mut components = p.components();
    while let Some(component) = components.next() {
        if component.as_os_str() != ".git" {
            continue;
        }
        let Some(first) = components.next().map(|item| item.as_os_str()) else {
            return false;
        };
        return first == "index"
            || first == "HEAD"
            || first == "packed-refs"
            || first == "refs"
            || first == "config"
            || (first == "info"
                && components.next().is_some_and(|item| item.as_os_str() == "exclude"));
    }
    true
}

/// Start watching `path` recursively. Emits one coalesced `working-tree-changed`
/// event for working files or status-relevant Git metadata. Idempotent — watching
/// an already-watched repo is a no-op. The watcher lives in `WatchState` until
/// `stop_watch` removes (and thus drops) it.
#[tauri::command]
pub fn start_watch(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatchState>,
    path: String,
) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if map.contains_key(&path) {
        return Ok(());
    }
    let repo = path.clone();
    // `notify` can deliver several events for one editor save. Coalesce them
    // before crossing the Rust/WebView boundary so idle and burst CPU stay low.
    let emit_pending = Arc::new(AtomicBool::new(false));
    let batch = Arc::new(Mutex::new(WatchBatch::default()));
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            let mut relevant = false;
            if let Ok(mut pending_batch) = batch.lock() {
                if ev.need_rescan() {
                    relevant = true;
                    pending_batch.full = true;
                    pending_batch.paths.clear();
                }
                for event_path in ev.paths.iter().filter(|p| path_triggers_status(p)) {
                    relevant = true;
                    if path_in_git(event_path) {
                        pending_batch.full = true;
                        pending_batch.paths.clear();
                        continue;
                    }
                    if event_path.file_name().is_some_and(|name| {
                        name == ".gitignore" || name == ".gitmodules"
                    }) {
                        pending_batch.full = true;
                        pending_batch.paths.clear();
                        continue;
                    }
                    if pending_batch.full {
                        continue;
                    }
                    match event_path.strip_prefix(std::path::Path::new(&repo)) {
                        Ok(relative) if !relative.as_os_str().is_empty() => {
                            pending_batch.paths.insert(git_relative_path(relative));
                            if pending_batch.paths.len() > WATCH_PATH_LIMIT {
                                pending_batch.full = true;
                                pending_batch.paths.clear();
                            }
                        }
                        _ => {
                            pending_batch.full = true;
                            pending_batch.paths.clear();
                        }
                    }
                }
            }
            if relevant && !emit_pending.swap(true, Ordering::AcqRel) {
                let app = app.clone();
                let repo = repo.clone();
                let pending = Arc::clone(&emit_pending);
                let batch = Arc::clone(&batch);
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(120)).await;
                    let (paths, full) = batch
                        .lock()
                        .map(|mut current| {
                            let paths = current.paths.drain().collect();
                            let full = current.full;
                            current.full = false;
                            (paths, full)
                        })
                        .unwrap_or_else(|_| (Vec::new(), true));
                    // Clear before emitting: an event arriving during the status
                    // refresh can schedule exactly one later reconciliation.
                    pending.store(false, Ordering::Release);
                    let _ = app.emit(
                        "working-tree-changed",
                        WorkingTreeChanged { path: repo, paths, full },
                    );
                });
            }
        }
    })
    .map_err(|e| format!("无法创建文件监听：{e}"))?;
    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| format!("无法监听目录：{e}"))?;
    map.insert(path, watcher);
    Ok(())
}

/// Stop watching `path` (drops the watcher, releasing the OS watch).
#[tauri::command]
pub fn stop_watch(state: tauri::State<'_, WatchState>, path: String) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&path);
    Ok(())
}

#[cfg(test)]
mod watch_tests {
    use super::path_triggers_status;
    use std::path::Path;

    #[test]
    fn filters_git_churn_but_keeps_status_metadata() {
        assert!(path_triggers_status(Path::new("/repo/src/main.ts")));
        assert!(path_triggers_status(Path::new("/repo/.git/index")));
        assert!(path_triggers_status(Path::new("/repo/.git/HEAD")));
        assert!(path_triggers_status(Path::new("/repo/.git/refs/heads/main")));
        assert!(path_triggers_status(Path::new("/repo/.git/info/exclude")));
        assert!(path_triggers_status(Path::new("/repo/.git/config")));
        assert!(!path_triggers_status(Path::new("/repo/.git/objects/aa/bb")));
        assert!(!path_triggers_status(Path::new("/repo/.git/logs/HEAD")));
        assert!(!path_triggers_status(Path::new("/repo/.git/index.lock")));
    }
}
