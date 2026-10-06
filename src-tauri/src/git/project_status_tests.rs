use super::{probe_project_directory, project_status_inner};
use crate::git::{
    apply_working_watch_request, path_triggers_status, run_git, watch_event_changes_files,
    RepoWatchRoots, WatchRegistry, WorkingWatchIntents,
};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

struct Fixture(PathBuf);

impl Fixture {
    fn plain() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("gitkit-status-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn repo() -> Self {
        let fixture = Self::plain();
        fixture.git(&["init", "--initial-branch=main"]);
        fixture.git(&["config", "user.name", "Fixture"]);
        fixture.git(&["config", "user.email", "fixture@example.invalid"]);
        fixture.git(&["config", "commit.gpgSign", "false"]);
        fixture.git(&["config", "core.hooksPath", "/dev/null"]);
        fixture.git(&["config", "core.autocrlf", "false"]);
        fixture
    }
    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
    fn git(&self, args: &[&str]) -> String {
        run_git(self.path(), args).unwrap()
    }
    fn write(&self, file: &str, text: &str) {
        std::fs::write(self.0.join(file), text).unwrap();
    }
    fn commit(&self) {
        self.git(&["add", "."]);
        self.git(&["commit", "-m", "fixture"]);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn lightweight_summary_counts_unique_paths_renames_and_untracked_files() {
    let fixture = Fixture::repo();
    fixture.write("both.txt", "base\n");
    fixture.write("rename.txt", "rename me\n");
    fixture.write("delete.txt", "delete me\n");
    fixture.write(".gitignore", "ignored/\n");
    fixture.commit();
    fixture.write("both.txt", "staged\n");
    fixture.git(&["add", "both.txt"]);
    fixture.write("both.txt", "unstaged\n");
    fixture.git(&["mv", "rename.txt", "renamed.txt"]);
    fixture.git(&["rm", "delete.txt"]);
    std::fs::create_dir(fixture.0.join("untracked")).unwrap();
    fixture.write("untracked/a.txt", "a");
    fixture.write("untracked/b.txt", "b");
    std::fs::create_dir(fixture.0.join("ignored")).unwrap();
    fixture.write("ignored/no.txt", "ignored");
    let summary = project_status_inner(fixture.path()).unwrap();
    assert!(summary.initialized);
    assert_eq!(summary.current_branch, "main");
    assert_eq!(summary.changed_files, 5); // both, rename destination, deletion, two untracked
    assert!(summary.checked_at > 0);
    std::fs::create_dir(fixture.0.join("nested")).unwrap();
    assert_eq!(
        project_status_inner(fixture.0.join("nested").to_str().unwrap())
            .unwrap()
            .changed_files,
        5
    );
}

#[test]
fn lightweight_summary_counts_conflicts_once_and_supports_detached_and_unborn_heads() {
    let fixture = Fixture::repo();
    let unborn = project_status_inner(fixture.path()).unwrap();
    assert_eq!(unborn.current_branch, "main");
    assert_eq!(unborn.changed_files, 0);
    fixture.write("conflict.txt", "base\n");
    fixture.commit();
    fixture.git(&["checkout", "-b", "topic"]);
    fixture.write("conflict.txt", "topic\n");
    fixture.commit();
    fixture.git(&["checkout", "main"]);
    fixture.write("conflict.txt", "main\n");
    fixture.commit();
    assert!(run_git(fixture.path(), &["merge", "topic"]).is_err());
    assert_eq!(
        project_status_inner(fixture.path()).unwrap().changed_files,
        1
    );
    fixture.git(&["merge", "--abort"]);
    fixture.git(&["checkout", "--detach"]);
    assert_eq!(
        project_status_inner(fixture.path()).unwrap().current_branch,
        "HEAD"
    );
}

#[test]
fn lightweight_summary_is_read_only_and_does_not_initialize_plain_directories() {
    let plain = Fixture::plain();
    plain.write("existing.txt", "keep\n");
    let summary = project_status_inner(plain.path()).unwrap();
    assert!(
        !summary.initialized && summary.current_branch.is_empty() && summary.changed_files == 0
    );
    assert!(!plain.0.join(".git").exists());
    let fixture = Fixture::repo();
    fixture.write("tracked.txt", "base\n");
    fixture.commit();
    fixture.write("tracked.txt", "changed\n");
    fixture.git(&["remote", "add", "origin", "/does/not/exist/gitkit-fixture"]);
    fixture.write(".git/FETCH_HEAD", "sentinel\n");
    let index = fixture.0.join(".git/index");
    let before = std::fs::read(&index).unwrap();
    let modified = std::fs::metadata(&index).unwrap().modified().unwrap();
    let head = fixture.git(&["rev-parse", "HEAD"]);
    for _ in 0..3 {
        assert_eq!(
            project_status_inner(fixture.path()).unwrap().changed_files,
            1
        );
    }
    assert_eq!(std::fs::read(&index).unwrap(), before);
    assert_eq!(
        std::fs::metadata(&index).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(fixture.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(
        std::fs::read_to_string(fixture.0.join(".git/FETCH_HEAD")).unwrap(),
        "sentinel\n"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.0.join("tracked.txt")).unwrap(),
        "changed\n"
    );
}

#[test]
fn lightweight_summary_surfaces_invalid_folders_and_broken_repository_metadata() {
    let fixture = Fixture::plain();
    assert!(project_status_inner(fixture.0.join("missing").to_str().unwrap()).is_err());
    fixture.write("file", "data");
    assert!(project_status_inner(fixture.0.join("file").to_str().unwrap()).is_err());
    std::fs::create_dir(fixture.0.join(".git")).unwrap();
    assert!(project_status_inner(fixture.path()).is_err());
    std::fs::remove_dir(fixture.0.join(".git")).unwrap();
    fixture.write(".git", "gitdir: /missing/gitkit-fixture\n");
    assert!(project_status_inner(fixture.path()).is_err());
    let bare = Fixture::plain();
    bare.git(&["init", "--bare"]);
    assert!(project_status_inner(bare.path()).is_err());
    let corrupt = Fixture::repo();
    corrupt.write(".git/config", "[invalid\n");
    assert!(project_status_inner(corrupt.path()).is_err());
}

#[test]
fn lightweight_summary_reads_linked_worktree_without_touching_common_metadata() {
    let fixture = Fixture::repo();
    fixture.write("tracked.txt", "base\n");
    fixture.commit();
    let linked = Fixture::plain();
    fixture.git(&["worktree", "add", "-b", "linked", linked.path()]);
    linked.write("tracked.txt", "changed\n");
    let (root, initialized) = probe_project_directory(linked.path()).unwrap();
    assert!(initialized);
    assert_eq!(root, linked.0.canonicalize().unwrap());
    let summary = project_status_inner(linked.path()).unwrap();
    assert_eq!(summary.current_branch, "linked");
    assert_eq!(summary.changed_files, 1);
    assert_eq!(
        project_status_inner(fixture.path()).unwrap().changed_files,
        0
    );
}

#[test]
fn plain_folder_pointer_initialization_discovers_external_worktree_metadata() {
    let main = Fixture::repo();
    main.write("tracked.txt", "base\n");
    main.commit();
    let linked = Fixture::plain();
    let before = RepoWatchRoots::resolve(linked.path()).unwrap();
    assert!(before.git.is_none());
    let pointer = before.repo.join(".git");
    assert!(before.pointer_changed(&pointer));
    assert!(path_triggers_status(&pointer));
    main.git(&["worktree", "add", "-b", "new-linked", linked.path()]);
    let after = RepoWatchRoots::resolve(linked.path()).unwrap();
    assert_ne!(before, after);
    let git = after.git.as_ref().unwrap();
    assert!(!git.git_dir.starts_with(&after.repo));
    assert!(!git.common_dir.starts_with(&after.repo));
    let external = git.external_watch_dirs(&after.repo);
    assert!(external.iter().any(|root| git.git_dir.starts_with(root)));
    assert!(external.iter().any(|root| git.common_dir.starts_with(root)));
    assert!(after.pointer_changed(&pointer));
    assert!(!after.pointer_changed(&git.git_dir.join("index")));
    assert!(git.triggers_status(&git.git_dir.join("index")));
    assert!(git.triggers_status(&git.common_dir.join("refs/heads/new-linked")));
}

#[test]
fn read_access_events_cannot_feed_back_into_status_or_pointer_refresh() {
    use notify::event::{AccessKind, AccessMode, CreateKind, DataChange, ModifyKind};
    use notify::EventKind;
    for access in [
        AccessKind::Any,
        AccessKind::Read,
        AccessKind::Open(AccessMode::Any),
        AccessKind::Open(AccessMode::Read),
        AccessKind::Close(AccessMode::Read),
    ] {
        assert!(!watch_event_changes_files(&EventKind::Access(access)));
    }
    assert!(watch_event_changes_files(&EventKind::Access(
        AccessKind::Close(AccessMode::Write)
    )));
    assert!(watch_event_changes_files(&EventKind::Modify(
        ModifyKind::Data(DataChange::Any)
    )));
    assert!(watch_event_changes_files(&EventKind::Create(
        CreateKind::File
    )));
}

#[test]
fn rewritten_git_pointer_changes_roots_but_index_writes_do_not_request_replacement() {
    let folder = Fixture::plain();
    let first_metadata = Fixture::plain();
    folder.git(&[
        "init",
        "--initial-branch=main",
        "--separate-git-dir",
        first_metadata.path(),
    ]);
    let before = RepoWatchRoots::resolve(folder.path()).unwrap();
    let next_metadata = Fixture::plain();
    folder.git(&["init", "--separate-git-dir", next_metadata.path()]);
    let after = RepoWatchRoots::resolve(folder.path()).unwrap();
    assert_ne!(before, after);
    assert_eq!(
        after.git.as_ref().unwrap().git_dir,
        next_metadata.0.canonicalize().unwrap()
    );
    assert!(after.pointer_changed(&after.repo.join(".git")));
    assert!(!after.pointer_changed(&after.repo.join(".git/index")));
    assert!(!after.pointer_changed(&after.git.as_ref().unwrap().git_dir.join("index")));
}

struct DropWatch(Arc<AtomicUsize>);
impl Drop for DropWatch {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn shared_watch_owners_create_once_and_release_independently() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let mut registry = WatchRegistry::default();
    registry
        .acquire_working("a".into(), |_| Ok(DropWatch(dropped.clone())))
        .unwrap();
    registry.configure_projects(vec!["a".into(), "a".into()], true, true, 1, |_| {
        panic!("duplicate watcher")
    });
    registry.release_working("a");
    assert_eq!(registry.entries.len(), 1);
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
    registry
        .acquire_working("a".into(), |_| panic!("duplicate watcher"))
        .unwrap();
    registry.configure_projects(vec![], false, false, 2, |_| panic!("background watch"));
    assert!(registry.entries["a"].working && !registry.entries["a"].project);
    registry.release_working("a");
    assert!(registry.entries.is_empty());
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}

#[test]
fn shared_watch_configuration_rejects_stale_and_duplicate_revisions() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let mut registry = WatchRegistry::default();
    registry.configure_projects(vec!["a".into()], true, true, 1, |_| {
        Ok(DropWatch(dropped.clone()))
    });
    registry.configure_projects(vec![], false, false, 3, |_| panic!("background watch"));
    for revision in [1, 2, 3] {
        let result = registry.configure_projects(vec!["a".into()], true, true, revision, |_| {
            panic!("stale foreground watch")
        });
        assert_eq!(result.revision, 3);
        assert!(registry.entries.is_empty());
    }
    registry.configure_projects(vec!["b".into()], true, true, 4, |_| {
        Ok(DropWatch(dropped.clone()))
    });
    registry.suspend_projects();
    assert!(registry.entries.is_empty());
    assert_eq!(dropped.load(Ordering::SeqCst), 2);
    registry.configure_projects(vec!["b".into()], true, true, 4, |_| {
        panic!("suspended old revision")
    });
    assert!(registry.entries.is_empty());
}

#[test]
fn native_background_reports_uncovered_current_paths_even_to_stale_foreground_requests() {
    let mut registry = WatchRegistry::<()>::default();
    let current = registry.configure_projects(
        vec!["b".into(), "a".into(), "a".into()],
        true,
        false,
        5,
        |_| panic!("native background created watch"),
    );
    assert_eq!(current.failed_paths, ["a", "b"]);
    assert_eq!(current.revision, 5);
    let stale =
        registry.configure_projects(vec!["old".into()], true, true, 4, |_| panic!("stale watch"));
    assert_eq!(stale.failed_paths, ["a", "b"]);
    assert_eq!(stale.revision, 5);
    let resumed = registry.configure_projects(vec!["a".into()], true, true, 6, |_| Ok(()));
    assert!(resumed.failed_paths.is_empty());
    registry.suspend_projects();
    let stale_after_blur = registry.configure_projects(vec!["old".into()], true, true, 5, |_| {
        panic!("stale after blur")
    });
    assert_eq!(stale_after_blur.failed_paths, ["a"]);
    assert_eq!(stale_after_blur.revision, 6);
    assert!(registry.entries.is_empty());
    let disabled = registry.configure_projects(vec!["ignored".into()], false, false, 7, |_| {
        panic!("disabled watch")
    });
    assert!(disabled.failed_paths.is_empty());
    assert!(registry.project_requested_paths.is_empty());
}

#[test]
fn shared_watch_failures_are_isolated_retriable_and_native_suspend_keeps_working_owner() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let mut registry = WatchRegistry::default();
    registry
        .acquire_working("working".into(), |_| Ok(DropWatch(dropped.clone())))
        .unwrap();
    let result = registry.configure_projects(
        vec!["working".into(), "ok".into(), "fail".into()],
        true,
        true,
        1,
        |path| {
            if path == "fail" {
                Err("fixture failure".into())
            } else {
                Ok(DropWatch(dropped.clone()))
            }
        },
    );
    assert_eq!(result.failed_paths, ["fail"]);
    assert_eq!(registry.entries.len(), 2);
    let retry =
        registry.configure_projects(vec!["working".into(), "fail".into()], true, true, 2, |_| {
            Ok(DropWatch(dropped.clone()))
        });
    assert!(retry.failed_paths.is_empty());
    assert!(!registry.entries.contains_key("ok"));
    registry.suspend_projects();
    assert_eq!(registry.entries.len(), 1);
    assert!(registry.entries["working"].working);
    assert!(!registry.entries["working"].project);
    assert_eq!(dropped.load(Ordering::SeqCst), 2);
}

#[test]
fn shared_watch_late_start_cannot_leak_after_stop_before_or_during_creation() {
    use std::sync::Mutex;
    let intents = Mutex::new(WorkingWatchIntents::default());
    let mut registry = WatchRegistry::<DropWatch>::default();
    let start = intents.lock().unwrap().request("a", true);
    let stop = intents.lock().unwrap().request("a", false);
    apply_working_watch_request(&mut registry, &intents, "a".into(), start, |_| {
        panic!("late start")
    })
    .unwrap();
    apply_working_watch_request(&mut registry, &intents, "a".into(), stop, |_| {
        panic!("stop creates watch")
    })
    .unwrap();
    assert!(registry.entries.is_empty());
    let dropped = Arc::new(AtomicUsize::new(0));
    let start = intents.lock().unwrap().request("a", true);
    let mut stop = 0;
    apply_working_watch_request(&mut registry, &intents, "a".into(), start, |_| {
        stop = intents.lock().unwrap().request("a", false);
        Ok(DropWatch(dropped.clone()))
    })
    .unwrap();
    assert!(registry.entries.is_empty());
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    apply_working_watch_request(&mut registry, &intents, "a".into(), stop, |_| {
        panic!("stop creates watch")
    })
    .unwrap();
    assert!(intents.lock().unwrap().pending.is_empty());
    let stop = intents.lock().unwrap().request("a", false);
    let start = intents.lock().unwrap().request("a", true);
    apply_working_watch_request(&mut registry, &intents, "a".into(), start, |_| {
        Ok(DropWatch(dropped.clone()))
    })
    .unwrap();
    apply_working_watch_request(&mut registry, &intents, "a".into(), stop, |_| {
        panic!("late stop")
    })
    .unwrap();
    assert!(registry.entries["a"].working);
    assert!(intents.lock().unwrap().pending.is_empty());
}

#[test]
fn shared_watch_replacement_preserves_owners_and_cannot_revive_a_released_path() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let mut registry = WatchRegistry::default();
    registry
        .acquire_working("a".into(), |_| Ok(DropWatch(dropped.clone())))
        .unwrap();
    registry.configure_projects(vec!["a".into()], true, true, 1, |_| {
        panic!("duplicate watcher")
    });
    assert!(registry
        .replace_owned_if("a", |_| true, || Err("fixture failure".into()))
        .is_err());
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
    assert!(registry.entries["a"].working && registry.entries["a"].project);
    assert!(registry
        .replace_owned_if("a", |_| true, || Ok(DropWatch(dropped.clone())))
        .unwrap());
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(registry.entries["a"].working && registry.entries["a"].project);
    assert!(!registry
        .replace_owned_if("a", |_| false, || panic!("stale instance replaced"))
        .unwrap());
    registry.suspend_projects();
    assert!(registry.entries["a"].working && !registry.entries["a"].project);
    registry.release_working("a");
    assert!(!registry
        .replace_owned_if("a", |_| true, || panic!("released path revived"))
        .unwrap());
    assert_eq!(dropped.load(Ordering::SeqCst), 2);
}

#[test]
#[ignore = "manual sidebar/full overview comparison on 100 tracking branches"]
fn lightweight_summary_benchmark_against_full_overview() {
    use crate::git::{git_auth_command, project_overview::project_overview_inner};
    use std::io::Write;
    use std::process::Stdio;
    use std::time::Instant;

    let fixture = Fixture::repo();
    fixture.write("tracked.txt", "base\n");
    fixture.commit();
    let base = fixture.git(&["rev-parse", "HEAD"]);
    fixture.git(&[
        "remote",
        "add",
        "origin",
        "/nonexistent/gitkit-status-remote",
    ]);
    fixture.git(&["update-ref", "refs/remotes/origin/main", base.trim()]);
    fixture.git(&["branch", "--set-upstream-to=origin/main", "main"]);
    let mut refs = String::new();
    let mut config = String::new();
    for index in 0..99 {
        let name = format!("tracking-{index}");
        refs.push_str(&format!("create refs/heads/{name} {}\n", base.trim()));
        config.push_str(&format!(
            "\n[branch \"{name}\"]\n\tremote = origin\n\tmerge = refs/heads/main\n"
        ));
    }
    let mut child = git_auth_command(fixture.path(), &["update-ref", "--stdin"], None)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(refs.as_bytes())
        .unwrap();
    assert!(child.wait_with_output().unwrap().status.success());
    std::fs::OpenOptions::new()
        .append(true)
        .open(fixture.0.join(".git/config"))
        .unwrap()
        .write_all(config.as_bytes())
        .unwrap();
    fixture.git(&["checkout", "-b", "remote-side"]);
    fixture.write("remote.txt", "remote\n");
    fixture.commit();
    let remote = fixture.git(&["rev-parse", "HEAD"]);
    fixture.git(&["update-ref", "refs/remotes/origin/main", remote.trim()]);
    fixture.git(&["checkout", "main"]);
    fixture.write("tracked.txt", "local change\n");
    assert_eq!(
        project_overview_inner(fixture.path())
            .unwrap()
            .behind_branches
            .len(),
        100
    );
    assert_eq!(
        project_status_inner(fixture.path()).unwrap().changed_files,
        1
    );
    let (mut overview_ms, mut status_ms) = (Vec::new(), Vec::new());
    for sample in 0..7 {
        // Alternate order to reduce warm-filesystem/order bias.
        for lightweight in if sample % 2 == 0 {
            [true, false]
        } else {
            [false, true]
        } {
            let start = Instant::now();
            if lightweight {
                assert_eq!(
                    project_status_inner(fixture.path()).unwrap().changed_files,
                    1
                );
                status_ms.push(start.elapsed().as_secs_f64() * 1000.0);
            } else {
                assert_eq!(
                    project_overview_inner(fixture.path())
                        .unwrap()
                        .behind_branches
                        .len(),
                    100
                );
                overview_ms.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
    }
    let mean = |values: &[f64]| values.iter().sum::<f64>() / values.len() as f64;
    println!("100 tracking branches: full overview {overview_ms:?} ms (mean {:.2}); lightweight {status_ms:?} ms (mean {:.2})", mean(&overview_ms), mean(&status_ms));
}
