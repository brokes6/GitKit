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
