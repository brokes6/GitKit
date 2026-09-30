use super::*;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

struct TestRepo(PathBuf);

impl TestRepo {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("gitkit-operation-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let repo = Self(root);
        repo.git(&["init", "--initial-branch=main"]);
        repo.git(&["config", "user.name", "GitKit Test"]);
        repo.git(&["config", "user.email", "gitkit-test@example.invalid"]);
        repo.git(&["config", "core.hooksPath", "/dev/null"]);
        repo.git(&["config", "commit.gpgSign", "false"]);
        repo.git(&["commit", "--allow-empty", "-m", "base"]);
        repo
    }

    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }

    fn git(&self, args: &[&str]) -> String {
        run_git(self.path(), args).unwrap().trim().to_string()
    }
}

impl Drop for TestRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn undo_last_unpushed_commit_preserves_worktree_and_unstages_files() {
    let (repo, _) = force_push_fixture();
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git(&["add", "tracked.txt"]);
    repo.git(&["commit", "-m", "tracked base"]);
    repo.git(&["push", "origin", "HEAD:main"]);
    let base = repo.git(&["rev-parse", "HEAD"]);
    std::fs::write(repo.0.join("first.txt"), "first\n").unwrap();
    repo.git(&["add", "first.txt"]);
    repo.git(&["commit", "-m", "first local commit"]);
    let first = repo.git(&["rev-parse", "HEAD"]);
    std::fs::write(repo.0.join("latest.txt"), "latest\n").unwrap();
    std::fs::write(repo.0.join("tracked.txt"), "latest tracked\n").unwrap();
    repo.git(&["add", "latest.txt", "tracked.txt"]);
    repo.git(&["commit", "-m", "latest local commit"]);
    std::fs::write(repo.0.join("staged.txt"), "staged\n").unwrap();
    repo.git(&["add", "staged.txt"]);
    std::fs::write(repo.0.join("unstaged.txt"), "unstaged\n").unwrap();

    let preview = undo_commit_preview_inner(repo.path()).unwrap();
    assert_eq!(preview.subject, "latest local commit");
    undo_last_commit_inner(repo.path(), &preview.branch, &preview.head).unwrap();

    assert_ne!(repo.git(&["rev-parse", "HEAD"]), base);
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), first);
    assert_eq!(std::fs::read_to_string(repo.0.join("latest.txt")).unwrap(), "latest\n");
    assert_eq!(std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(), "latest tracked\n");
    assert_eq!(std::fs::read_to_string(repo.0.join("staged.txt")).unwrap(), "staged\n");
    assert_eq!(std::fs::read_to_string(repo.0.join("unstaged.txt")).unwrap(), "unstaged\n");
    assert!(repo.git(&["diff", "--cached", "--name-only"]).is_empty());
    assert!(repo.git(&["diff", "--name-only"]).contains("tracked.txt"));
}

#[test]
fn undo_commit_refuses_pushed_and_changed_heads() {
    let (repo, remote) = force_push_fixture();
    std::fs::write(repo.0.join("local.txt"), "local\n").unwrap();
    repo.git(&["add", "local.txt"]);
    repo.git(&["commit", "-m", "local"]);
    let preview = undo_commit_preview_inner(repo.path()).unwrap();
    repo.git(&["commit", "--allow-empty", "-m", "later"]);
    assert!(undo_last_commit_inner(repo.path(), &preview.branch, &preview.head)
        .unwrap_err().contains("已变化"));
    repo.git(&["push", "origin", "HEAD:main"]);
    let pushed = repo.git(&["rev-parse", "HEAD"]);
    assert!(undo_commit_preview_inner(repo.path()).unwrap_err().contains("没有未推送"));
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), pushed);
    assert_eq!(run_git(&remote, &["rev-parse", "HEAD"]).unwrap().trim(), pushed);
}

#[test]
fn undo_commit_refuses_diverged_branch() {
    let (repo, _) = force_push_fixture();
    repo.git(&["commit", "--amend", "--allow-empty", "-m", "rewritten base"]);
    assert!(undo_commit_preview_inner(repo.path()).unwrap_err().contains("已分叉"));
}

#[test]
fn undo_commit_supports_local_branch_without_upstream_but_refuses_known_pushed_head() {
    let (repo, _) = force_push_fixture();
    repo.git(&["branch", "--unset-upstream"]);
    assert!(undo_commit_preview_inner(repo.path()).unwrap_err().contains("远端跟踪分支"));
    repo.git(&["commit", "--allow-empty", "-m", "local only"]);
    let preview = undo_commit_preview_inner(repo.path()).unwrap();
    assert_eq!(preview.subject, "local only");
    undo_last_commit_inner(repo.path(), &preview.branch, &preview.head).unwrap();
    assert!(undo_commit_preview_inner(repo.path()).unwrap_err().contains("远端跟踪分支"));
}

#[test]
fn undo_initial_commit_leaves_an_unborn_branch_and_keeps_files() {
    let repo = TestRepo::new();
    std::fs::write(repo.0.join("initial.txt"), "initial\n").unwrap();
    repo.git(&["add", "initial.txt"]);
    repo.git(&["commit", "--amend", "--no-edit"]);
    std::fs::write(repo.0.join("staged.txt"), "staged\n").unwrap();
    repo.git(&["add", "staged.txt"]);

    let preview = undo_commit_preview_inner(repo.path()).unwrap();
    assert!(preview.initial);
    undo_last_commit_inner(repo.path(), &preview.branch, &preview.head).unwrap();

    assert_eq!(repo.git(&["branch", "--show-current"]), "main");
    assert!(run_git(repo.path(), &["rev-parse", "--verify", "HEAD"]).is_err());
    assert_eq!(std::fs::read_to_string(repo.0.join("initial.txt")).unwrap(), "initial\n");
    assert_eq!(std::fs::read_to_string(repo.0.join("staged.txt")).unwrap(), "staged\n");
    assert!(repo.git(&["ls-files"]).is_empty());
}

fn force_push_fixture() -> (TestRepo, String) {
    let repo = TestRepo::new();
    let remote = repo.0.join("remote.git");
    let remote = remote.to_str().unwrap().to_string();
    repo.git(&["init", "--bare", "--initial-branch=main", &remote]);
    repo.git(&["remote", "add", "origin", &remote]);
    repo.git(&["push", "-u", "origin", "main"]);
    repo.git(&["branch", "-m", "local"]);
    repo.git(&["config", "push.default", "upstream"]);
    (repo, remote)
}

#[test]
fn force_push_previews_rewritten_history_and_backs_up_old_remote_tip() {
    let (repo, remote) = force_push_fixture();
    let old_head = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["-c", "user.name=Rewritten Author", "commit", "--amend", "--allow-empty", "--no-edit", "--reset-author"]);
    let new_head = repo.git(&["rev-parse", "HEAD"]);
    assert_ne!(old_head, new_head);

    let preview = force_push_preview_inner(repo.path(), None).unwrap();
    assert_eq!(preview.remote, "origin");
    assert_eq!(preview.branch, "local");
    assert_eq!(preview.remote_branch, "main");
    assert_eq!(preview.local_head, new_head);
    assert_eq!(preview.remote_head, old_head);
    assert_eq!((preview.ahead, preview.behind), (1, 1));
    assert!(preview.same_tree);

    let backup = force_push_inner(
        repo.path(), None, &preview.remote, &preview.branch, &preview.remote_branch,
        &preview.local_head, &preview.remote_head,
    ).unwrap();
    assert_eq!(run_git(&remote, &["rev-parse", "refs/heads/main"]).unwrap().trim(), new_head);
    assert_eq!(repo.git(&["rev-parse", &backup]), old_head);
}

#[test]
fn force_push_rejects_a_remote_update_after_preview() {
    let (repo, remote) = force_push_fixture();
    repo.git(&["-c", "user.name=Rewritten Author", "commit", "--amend", "--allow-empty", "--no-edit", "--reset-author"]);
    let preview = force_push_preview_inner(repo.path(), None).unwrap();

    let other = repo.0.join("other-checkout");
    let other = other.to_str().unwrap().to_string();
    repo.git(&["clone", &remote, &other]);
    run_git(&other, &["config", "user.name", "Other Author"]).unwrap();
    run_git(&other, &["config", "user.email", "other@example.invalid"]).unwrap();
    run_git(&other, &["commit", "--allow-empty", "-m", "new remote commit"]).unwrap();
    let advanced = run_git(&other, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
    run_git(&other, &["push", "origin", "main"]).unwrap();

    let result = force_push_inner(
        repo.path(), None, &preview.remote, &preview.branch, &preview.remote_branch,
        &preview.local_head, &preview.remote_head,
    );
    assert!(result.is_err());
    assert_eq!(run_git(&remote, &["rev-parse", "refs/heads/main"]).unwrap().trim(), advanced);
}

#[test]
fn force_push_rejects_a_local_commit_after_preview() {
    let (repo, remote) = force_push_fixture();
    repo.git(&["-c", "user.name=Rewritten Author", "commit", "--amend", "--allow-empty", "--no-edit", "--reset-author"]);
    let preview = force_push_preview_inner(repo.path(), None).unwrap();
    repo.git(&["commit", "--allow-empty", "-m", "new local commit"]);

    let result = force_push_inner(
        repo.path(), None, &preview.remote, &preview.branch, &preview.remote_branch,
        &preview.local_head, &preview.remote_head,
    );
    assert!(result.unwrap_err().contains("本地分支已有新提交"));
    assert_eq!(run_git(&remote, &["rev-parse", "refs/heads/main"]).unwrap().trim(), preview.remote_head);
}

#[test]
fn force_push_refuses_different_fetch_and_push_urls() {
    let (repo, remote) = force_push_fixture();
    let other = format!("{remote}-other");
    repo.git(&["remote", "set-url", "--push", "origin", &other]);
    assert!(force_push_target(repo.path()).unwrap_err().contains("获取与推送地址不同"));
}

#[test]
fn cancellable_sync_preserves_dirty_diverged_and_linked_branches() {
    let repo = TestRepo::new();
    let base = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["branch", "topic"]);
    repo.git(&["branch", "linked"]);
    repo.git(&["checkout", "-b", "remote-tip"]);
    repo.git(&["commit", "--allow-empty", "-m", "remote commit"]);
    let remote = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["checkout", "-b", "diverged", &base]);
    repo.git(&["commit", "--allow-empty", "-m", "local commit"]);
    let diverged = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["checkout", "main"]);
    repo.git(&["remote", "add", "origin", "."]);
    repo.git(&["update-ref", "refs/remotes/origin/main", &remote]);
    for branch in ["main", "topic", "linked", "diverged"] {
        repo.git(&["branch", "--set-upstream-to=origin/main", branch]);
    }
    let linked = repo.0.join("linked-worktree");
    repo.git(&["worktree", "add", linked.to_str().unwrap(), "linked"]);

    let state = CancelState::default();
    let operation = state.begin("sync".into()).unwrap();
    let summary = sync_tracking_branches_cancellable(repo.path(), &operation).unwrap();
    assert!(summary.dirty_skipped); // untracked linked-worktree directory
    assert_eq!(summary.synced, ["topic"]);
    assert_eq!(summary.diverged, ["diverged"]);
    assert_eq!(repo.git(&["rev-parse", "main"]), base);
    assert_eq!(repo.git(&["rev-parse", "linked"]), base);
    assert_eq!(repo.git(&["rev-parse", "topic"]), remote);
    assert_eq!(repo.git(&["rev-parse", "diverged"]), diverged);

    repo.git(&["worktree", "remove", linked.to_str().unwrap()]);
    let summary = sync_tracking_branches_cancellable(repo.path(), &operation).unwrap();
    assert!(!summary.dirty_skipped);
    assert!(summary.synced.contains(&"main".to_string()));
    assert_eq!(repo.git(&["rev-parse", "main"]), remote);
}

#[test]
fn cancellation_interrupts_git_status_during_local_sync() {
    use std::os::unix::fs::PermissionsExt;
    let repo = TestRepo::new();
    let hook = repo.0.join(".git/test-fsmonitor");
    let marker = repo.0.join(".git/fsmonitor-started");
    std::fs::write(
        &hook,
        "#!/bin/sh\nprintf ready > .git/fsmonitor-started\nsleep 60\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    repo.git(&["config", "core.fsmonitor", hook.to_str().unwrap()]);
    let state = CancelState::default();
    let operation = state.begin("sync".into()).unwrap();
    let path = repo.path().to_string();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = sync_tracking_branches_cancellable(&path, &operation);
        drop(operation);
        let _ = tx.send(result.map(|_| ()));
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let reached_status = marker.exists();
    state.cancel("sync").unwrap();
    let result = rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(reached_status, "Git did not reach the local sync phase");
    assert_eq!(result.unwrap_err(), operation::CANCELLED);
}

#[test]
fn scheduled_check_fetches_remote_refs_without_moving_local_head() {
    let remote = TestRepo::new();
    let checkout = remote.0.join("checkout");
    remote.git(&["clone", remote.path(), checkout.to_str().unwrap()]);
    let path = checkout.to_str().unwrap().to_string();
    let before = run_git(&path, &["rev-parse", "HEAD"]).unwrap();
    remote.git(&["commit", "--allow-empty", "-m", "remote update"]);
    let result = tauri::async_runtime::block_on(check_updates(path.clone(), None,
        Some((CancelState::default(), "daily-check-test".into())))).unwrap();
    assert_eq!(result.behind.len(), 1);
    assert_eq!(result.behind[0].behind, 1);
    assert_eq!(result.behind[0].ahead, 0);
    assert_eq!(run_git(&path, &["rev-parse", "HEAD"]).unwrap(), before);
}

#[test]
fn scheduled_check_cancellation_reaches_local_status_after_fetch() {
    use std::os::unix::fs::PermissionsExt;
    let repo = TestRepo::new();
    let hook = repo.0.join(".git/test-fsmonitor");
    let marker = repo.0.join(".git/fsmonitor-started");
    std::fs::write(&hook, "#!/bin/sh\nprintf ready > .git/fsmonitor-started\nsleep 60\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    repo.git(&["config", "core.fsmonitor", hook.to_str().unwrap()]);
    let state = CancelState::default();
    let worker_state = state.clone();
    let path = repo.path().to_string();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let outcome = tauri::async_runtime::block_on(check_updates(path, None,
            Some((worker_state, "daily-check-cancel".into()))));
        let _ = tx.send(outcome.map(|_| ()));
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(10)); }
    state.cancel_background("daily-check-cancel");
    assert!(marker.exists(), "check never reached its local status phase");
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap().unwrap_err(), operation::CANCELLED);
}
