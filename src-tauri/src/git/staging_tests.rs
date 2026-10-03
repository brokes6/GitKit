use super::*;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct StagingRepo(PathBuf);

impl StagingRepo {
    fn new(initial_commit: bool) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("gitkit-staging-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let repo = Self(root);
        repo.git(&["init", "--initial-branch=main"]);
        repo.git(&["config", "user.name", "Fixture"]);
        repo.git(&["config", "user.email", "fixture@example.invalid"]);
        repo.git(&["config", "core.hooksPath", "/dev/null"]);
        repo.git(&["config", "commit.gpgSign", "false"]);
        if initial_commit {
            repo.git(&["commit", "--allow-empty", "-m", "base"]);
        }
        repo
    }
    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
    fn git(&self, args: &[&str]) -> String {
        run_git(self.path(), args).unwrap()
    }
    fn write(&self, file: &str, contents: &str) {
        std::fs::write(self.0.join(file), contents).unwrap();
    }
    fn stage(&self, files: &[&str]) -> StagingStatus {
        stage_files_inner(
            self.path(),
            &files
                .iter()
                .map(|file| file.to_string())
                .collect::<Vec<_>>(),
            false,
        )
        .unwrap()
    }
    fn unstage(&self, files: &[&str]) -> StagingStatus {
        stage_files_inner(
            self.path(),
            &files
                .iter()
                .map(|file| file.to_string())
                .collect::<Vec<_>>(),
            true,
        )
        .unwrap()
    }
    fn commit(&self, revision: &str) {
        commit_index_inner(self.path(), "fixture change", revision, None, None).unwrap();
    }
}

impl Drop for StagingRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn staged_snapshot_and_source_specific_diffs_survive_later_working_edits() {
    let repo = StagingRepo::new(true);
    repo.write("file.txt", "base\n");
    repo.commit(&repo.stage(&["file.txt"]).revision);
    repo.write("file.txt", "staged\n");
    let staged = repo.stage(&["file.txt"]);
    repo.write("file.txt", "working\n");
    let status = read_staging_status(repo.path(), &[]).unwrap();
    assert_eq!(status.revision, staged.revision);
    assert_eq!(status.entries.len(), 1);
    assert_eq!(status.entries[0].index_status, "M");
    assert_eq!(status.entries[0].work_status, "M");
    let cached = working_file_diff_inner(repo.path(), "file.txt", true, None).unwrap();
    let working = working_file_diff_inner(repo.path(), "file.txt", false, None).unwrap();
    assert!(cached.contains("-base\n+staged"));
    assert!(!cached.contains("+working"));
    assert!(working.contains("-staged\n+working"));
    repo.commit(&status.revision);
    assert_eq!(repo.git(&["show", "HEAD:file.txt"]), "staged\n");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        "working\n"
    );
    assert!(repo.git(&["diff", "--cached"]).is_empty());
    assert!(repo.git(&["diff"]).contains("+working"));
}

#[test]
fn externally_staged_partial_contents_are_committed_without_restaging() {
    let repo = StagingRepo::new(true);
    repo.write("partial.txt", "first\nsecond\n");
    repo.commit(&repo.stage(&["partial.txt"]).revision);
    repo.write("partial.txt", "first staged\nsecond\n");
    repo.git(&["add", "--", "partial.txt"]);
    repo.write("partial.txt", "first staged\nsecond working\n");
    repo.write("outside.txt", "keep outside\n");
    repo.git(&["add", "--", "outside.txt"]);
    let review = read_staging_status(repo.path(), &[]).unwrap();
    commit_index_inner(
        repo.path(),
        "external partial",
        &review.revision,
        Some("Chosen Author"),
        Some("chosen@example.invalid"),
    )
    .unwrap();
    assert_eq!(
        repo.git(&["show", "HEAD:partial.txt"]),
        "first staged\nsecond\n"
    );
    assert_eq!(repo.git(&["show", "HEAD:outside.txt"]), "keep outside\n");
    assert!(repo.git(&["diff"]).contains("+second working"));
    assert_eq!(
        repo.git(&["log", "-1", "--format=%an <%ae>"]).trim(),
        "Chosen Author <chosen@example.invalid>"
    );
    assert_eq!(repo.git(&["config", "user.name"]).trim(), "Fixture");
    assert_eq!(
        repo.git(&["config", "user.email"]).trim(),
        "fixture@example.invalid"
    );
}

#[test]
fn actual_unstage_preserves_working_contents_and_excludes_file_from_commit() {
    let repo = StagingRepo::new(true);
    repo.write("a.txt", "a\n");
    repo.write("b.txt", "b\n");
    repo.stage(&["a.txt", "b.txt"]);
    let remaining = repo.unstage(&["b.txt"]);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("b.txt")).unwrap(),
        "b\n"
    );
    assert!(
        !remaining
            .entries
            .iter()
            .find(|entry| entry.path == "b.txt")
            .unwrap()
            .staged
    );
    repo.commit(&remaining.revision);
    assert_eq!(repo.git(&["show", "HEAD:a.txt"]), "a\n");
    assert!(run_git(repo.path(), &["show", "HEAD:b.txt"]).is_err());
}

#[test]
fn unborn_staging_unstaging_and_initial_commit_preserve_new_files() {
    let repo = StagingRepo::new(false);
    repo.write("initial.txt", "index\n");
    let staged = repo.stage(&["initial.txt"]);
    assert!(
        working_file_diff_inner(repo.path(), "initial.txt", true, None)
            .unwrap()
            .contains("+index")
    );
    repo.write("initial.txt", "working\n");
    let unstaged = repo.unstage(&["initial.txt"]);
    assert_eq!(unstaged.entries[0].index_status, "?");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("initial.txt")).unwrap(),
        "working\n"
    );
    assert!(repo.git(&["ls-files"]).is_empty());
    assert_ne!(staged.revision, unstaged.revision);
    repo.commit(&repo.stage(&["initial.txt"]).revision);
    assert_eq!(repo.git(&["show", "HEAD:initial.txt"]), "working\n");
}

#[test]
fn deletions_and_renames_stage_and_unstage_both_rename_paths() {
    let repo = StagingRepo::new(true);
    repo.write("old.txt", "rename content\n");
    repo.write("delete.txt", "delete content\n");
    repo.commit(&repo.stage(&["old.txt", "delete.txt"]).revision);
    std::fs::remove_file(repo.0.join("delete.txt")).unwrap();
    assert_eq!(
        repo.stage(&["delete.txt"])
            .entries
            .iter()
            .find(|entry| entry.path == "delete.txt")
            .unwrap()
            .index_status,
        "D"
    );
    repo.unstage(&["delete.txt"]);
    assert!(!repo.0.join("delete.txt").exists());
    assert!(repo.git(&["diff", "--cached"]).is_empty());
    repo.git(&["mv", "--", "old.txt", "new.txt"]);
    let rename = read_staging_status(repo.path(), &[]).unwrap();
    let entry = rename
        .entries
        .iter()
        .find(|entry| entry.path == "new.txt")
        .unwrap();
    assert_eq!(entry.original_path.as_deref(), Some("old.txt"));
    assert_eq!(entry.index_status, "R");
    let diff = working_file_diff_inner(repo.path(), "new.txt", true, Some("old.txt")).unwrap();
    assert!(diff.contains("rename from old.txt") && diff.contains("rename to new.txt"));
    repo.write("new.txt", "rename content\nextra\n");
    repo.stage(&["new.txt"]); // Does not add an absent old path a second time.
    let unstaged = repo.unstage(&["new.txt"]);
    assert!(unstaged.entries.iter().all(|entry| !entry.staged));
    assert!(!repo.0.join("old.txt").exists());
    assert_eq!(
        std::fs::read_to_string(repo.0.join("new.txt")).unwrap(),
        "rename content\nextra\n"
    );
    assert!(repo.git(&["diff", "--cached"]).is_empty());
}

#[test]
fn literal_special_paths_do_not_expand_pathspecs_and_invalid_paths_do_not_mutate() {
    let repo = StagingRepo::new(true);
    let files = [
        "[a].txt",
        ":(glob)*.txt",
        "-option.txt",
        "空 格.txt",
        "line\nbreak.txt",
    ];
    for file in files {
        repo.write(file, "literal\n");
    }
    repo.write("a.txt", "should remain unstaged\n");
    let staged = repo.stage(&files);
    assert_eq!(
        staged.entries.iter().filter(|entry| entry.staged).count(),
        files.len()
    );
    assert!(
        !staged
            .entries
            .iter()
            .find(|entry| entry.path == "a.txt")
            .unwrap()
            .staged
    );
    for invalid in ["../outside", "/absolute", ".", "", "bad\0path"] {
        assert!(stage_files_inner(repo.path(), &[invalid.to_string()], false).is_err());
        assert!(working_file_diff_inner(repo.path(), invalid, true, None).is_err());
    }
    assert_eq!(staging_revision(repo.path()).unwrap(), staged.revision);
    repo.commit(&staged.revision);
    for file in files {
        assert_eq!(repo.git(&["show", &format!("HEAD:{file}")]), "literal\n");
    }
}

#[test]
fn stale_index_head_and_branch_revisions_are_rejected_without_restaging() {
    let repo = StagingRepo::new(true);
    repo.write("one.txt", "one\n");
    let reviewed = repo.stage(&["one.txt"]);
    repo.write("two.txt", "two\n");
    repo.git(&["add", "--", "two.txt"]);
    assert!(
        commit_index_inner(repo.path(), "stale", &reviewed.revision, None, None)
            .unwrap_err()
            .contains("已变化")
    );
    let reviewed = read_staging_status(repo.path(), &[]).unwrap();
    repo.git(&["branch", "same-head"]);
    repo.git(&["symbolic-ref", "HEAD", "refs/heads/same-head"]);
    assert!(
        commit_index_inner(repo.path(), "stale", &reviewed.revision, None, None)
            .unwrap_err()
            .contains("已变化")
    );
    let reviewed = read_staging_status(repo.path(), &[]).unwrap();
    repo.git(&["commit", "--allow-empty", "-m", "outside commit"]);
    assert!(
        commit_index_inner(repo.path(), "stale", &reviewed.revision, None, None)
            .unwrap_err()
            .contains("已变化")
    );
    assert_eq!(
        repo.git(&["log", "-1", "--format=%s"]).trim(),
        "outside commit"
    );
}

#[test]
fn empty_index_and_message_are_rejected() {
    let repo = StagingRepo::new(true);
    let review = read_staging_status(repo.path(), &[]).unwrap();
    assert!(
        commit_index_inner(repo.path(), "message", &review.revision, None, None)
            .unwrap_err()
            .contains("没有要提交")
    );
    repo.write("intent.txt", "working\n");
    repo.git(&["add", "-N", "--", "intent.txt"]);
    let review = read_staging_status(repo.path(), &[]).unwrap();
    assert!(
        commit_index_inner(repo.path(), "message", &review.revision, None, None)
            .unwrap_err()
            .contains("没有要提交")
    );
    let review = repo.stage(&["intent.txt"]);
    assert!(
        commit_index_inner(repo.path(), "  ", &review.revision, None, None)
            .unwrap_err()
            .contains("不能为空")
    );
    assert_eq!(repo.git(&["show", ":intent.txt"]), "working\n");
}

#[cfg(unix)]
#[test]
fn failing_commit_hook_preserves_index_and_working_changes() {
    use std::os::unix::fs::PermissionsExt;
    let repo = StagingRepo::new(true);
    repo.write("file.txt", "staged\n");
    let reviewed = repo.stage(&["file.txt"]);
    repo.write("file.txt", "working\n");
    let hooks = repo.0.join("hooks");
    std::fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho fixture-hook-failed >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    assert!(
        commit_index_inner(repo.path(), "keep draft", &reviewed.revision, None, None)
            .unwrap_err()
            .contains("fixture-hook-failed")
    );
    assert_eq!(staging_revision(repo.path()).unwrap(), reviewed.revision);
    assert_eq!(repo.git(&["show", ":file.txt"]), "staged\n");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        "working\n"
    );
}

#[test]
fn conflicts_have_readable_revisions_and_use_merge_continuation_after_staged_resolution() {
    let repo = StagingRepo::new(true);
    repo.write("conflict.txt", "base\n");
    repo.commit(&repo.stage(&["conflict.txt"]).revision);
    repo.git(&["checkout", "-b", "other"]);
    repo.write("conflict.txt", "other\n");
    repo.commit(&repo.stage(&["conflict.txt"]).revision);
    repo.git(&["checkout", "main"]);
    repo.write("conflict.txt", "main\n");
    repo.commit(&repo.stage(&["conflict.txt"]).revision);
    assert!(run_git(repo.path(), &["merge", "other"]).is_err());
    let conflicted = read_staging_status(repo.path(), &[]).unwrap();
    assert!(
        commit_index_inner(repo.path(), "blocked", &conflicted.revision, None, None)
            .unwrap_err()
            .contains("当前 Git 操作")
    );
    repo.write("conflict.txt", "resolved\n");
    let resolved = repo.stage(&["conflict.txt"]);
    assert!(commit_index_inner(repo.path(), "blocked", &resolved.revision, None, None).is_err());
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let state = runtime.block_on(local_merge::git_operation_state(repo.path().into())).unwrap().unwrap();
    runtime.block_on(local_merge::git_merge_continue(repo.path().into(), state.revision,
        "resolved merge".into(), None, None)).unwrap();
    assert_eq!(repo.git(&["show", "HEAD:conflict.txt"]), "resolved\n");
}

#[test]
fn porcelain_parser_keeps_original_paths_and_does_not_consume_following_records() {
    let entries = parse_status_entries(
        "RM new name.txt\0old name.txt\0?? next.txt\0C  copy.txt\0source.txt\0",
    );
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].path, "new name.txt");
    assert_eq!(entries[0].original_path.as_deref(), Some("old name.txt"));
    assert_eq!(entries[1].path, "next.txt");
    assert_eq!(entries[1].original_path, None);
    assert_eq!(entries[2].original_path.as_deref(), Some("source.txt"));
}

#[test]
fn linked_worktree_watcher_resolves_external_index_and_shared_refs() {
    let repo = StagingRepo::new(true);
    let worktree = repo.0.join("linked");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "linked",
        worktree.to_str().unwrap(),
    ]);
    let roots = WatchGitRoots::resolve(worktree.to_str().unwrap()).unwrap();
    let external = roots.external_watch_dirs(&worktree.canonicalize().unwrap());
    assert_eq!(external, vec![roots.common_dir.clone()]);
    for relative in ["index", "HEAD", "config.worktree"] {
        let path = roots.git_dir.join(relative);
        assert!(roots.is_metadata(&path) && roots.triggers_status(&path));
    }
    assert!(roots.triggers_status(&roots.common_dir.join("refs/heads/linked")));
    assert!(!roots.triggers_status(&roots.git_dir.join("index.lock")));
    assert!(!roots.triggers_status(&roots.common_dir.join("objects/aa/bb")));
    assert!(!roots.triggers_status(&roots.common_dir.join("worktrees/other/index")));
}

#[test]
fn incremental_destination_or_source_status_retains_rename_pairing() {
    let repo = StagingRepo::new(true);
    repo.write("old.txt", "rename\n");
    repo.write("other.txt", "other\n");
    repo.commit(&repo.stage(&["old.txt", "other.txt"]).revision);
    repo.git(&["mv", "--", "old.txt", "new.txt"]);
    repo.write("other.txt", "unrelated\n");
    assert!(read_staging_status(repo.path(), &[]).unwrap().full);
    for changed in ["old.txt", "new.txt"] {
        let status = read_staging_status(repo.path(), &[changed.to_string()]).unwrap();
        if !status.full { assert_eq!(status.entries.len(), 1); }
        let renamed = status.entries.iter().find(|entry| entry.path == "new.txt").unwrap();
        assert_eq!(renamed.index_status, "R");
        assert_eq!(renamed.original_path.as_deref(), Some("old.txt"));
    }
}

#[test]
fn staging_lock_serializes_repository_root_and_subdirectory_aliases() {
    use std::sync::mpsc;
    let repo = StagingRepo::new(true);
    let nested = repo.0.join("nested");
    std::fs::create_dir(&nested).unwrap();
    let root = repo.path().to_string();
    let (entered_sender, entered_receiver) = mpsc::channel();
    let (release_sender, release_receiver) = mpsc::channel();
    let first = std::thread::spawn(move || {
        with_staging_lock(&root, || {
            entered_sender.send(()).unwrap();
            release_receiver.recv().unwrap();
            Ok(())
        })
        .unwrap();
    });
    entered_receiver.recv().unwrap();
    let (second_sender, second_receiver) = mpsc::channel();
    let second = std::thread::spawn(move || {
        with_staging_lock(nested.to_str().unwrap(), || {
            second_sender.send(()).unwrap();
            Ok(())
        })
        .unwrap();
    });
    assert!(second_receiver
        .recv_timeout(Duration::from_millis(100))
        .is_err());
    release_sender.send(()).unwrap();
    second_receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    first.join().unwrap();
    second.join().unwrap();
}

#[test]
fn changing_empty_file_from_intent_to_add_to_staged_invalidates_review() {
    let repo = StagingRepo::new(true);
    repo.write("one.txt", "reviewed\n");
    repo.stage(&["one.txt"]);
    repo.write("empty.txt", "");
    repo.git(&["add", "-N", "--", "empty.txt"]);
    let reviewed = read_staging_status(repo.path(), &[]).unwrap();
    repo.git(&["add", "--", "empty.txt"]);
    assert_ne!(staging_revision(repo.path()).unwrap(), reviewed.revision);
    assert!(
        commit_index_inner(repo.path(), "stale", &reviewed.revision, None, None)
            .unwrap_err()
            .contains("已变化")
    );
}

#[test]
fn incremental_snapshots_keep_worktree_edits_and_reconcile_external_index_and_head_changes() {
    let repo = StagingRepo::new(true);
    repo.write("selected.txt", "base\n");
    repo.write("other.txt", "base\n");
    repo.commit(&repo.stage(&["selected.txt", "other.txt"]).revision);
    repo.write("selected.txt", "edit one\n");
    let initial = read_staging_status(repo.path(), &[]).unwrap();
    repo.write("selected.txt", "edit two\n");
    let partial = read_staging_status(repo.path(), &["selected.txt".into()]).unwrap();
    assert_eq!(partial.revision, initial.revision);
    assert!(partial.entries.iter().any(|entry| entry.path == "selected.txt" && entry.work_status == "M"));
    assert!(working_file_diff_inner(repo.path(), "selected.txt", false, None).unwrap().contains("edit two"));

    // The requested path becomes clean while an outside tool changes another
    // index entry. Returning an empty partial would leave stale reviewed rows.
    repo.write("selected.txt", "base\n");
    repo.write("other.txt", "external staging\n");
    repo.git(&["add", "--", "other.txt"]);
    let external = read_staging_status(repo.path(), &["selected.txt".into()]).unwrap();
    assert!(external.full);
    assert_ne!(external.revision, initial.revision);
    assert!(external.entries.iter().any(|entry| entry.path == "other.txt" && entry.staged));
    assert!(!external.entries.iter().any(|entry| entry.path == "selected.txt"));

    repo.git(&["commit", "-m", "outside tool"]);
    let committed = read_staging_status(repo.path(), &["selected.txt".into()]).unwrap();
    assert!(committed.full);
    assert!(committed.entries.is_empty());
    assert_ne!(committed.revision, external.revision);
    assert!(commit_index_inner(repo.path(), "stale", &external.revision, None, None).unwrap_err().contains("已变化"));
}

#[test]
fn symbolic_and_packed_ref_changes_invalidate_cached_review_without_an_index_change() {
    let repo = StagingRepo::new(true);
    let original = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.git(&["commit", "--allow-empty", "-m", "another head"]);
    let later = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.git(&["update-ref", "refs/heads/alias", &original]);
    repo.git(&["symbolic-ref", "refs/heads/main", "refs/heads/alias"]);
    let before = read_staging_status(repo.path(), &[]).unwrap();
    repo.git(&["update-ref", "refs/heads/alias", &later]);
    let changed = read_staging_status(repo.path(), &["clean.txt".into()]).unwrap();
    assert!(changed.full);
    assert_ne!(changed.revision, before.revision);
    repo.git(&["pack-refs", "--all"]);
    let packed = read_staging_status(repo.path(), &["clean.txt".into()]).unwrap();
    assert!(packed.full);
    assert_eq!(packed.revision, changed.revision);
}

#[test]
fn replacing_head_content_outside_the_app_invalidates_the_cached_index_review() {
    let repo = StagingRepo::new(true);
    repo.write("file.txt", "first\n");
    repo.commit(&repo.stage(&["file.txt"]).revision);
    let original = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.write("file.txt", "second\n");
    repo.commit(&repo.stage(&["file.txt"]).revision);
    let replacement = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.git(&["reset", "--hard", &original]);
    let before = read_staging_status(repo.path(), &[]).unwrap();
    assert!(before.entries.is_empty());
    repo.git(&["replace", &original, &replacement]);
    let replaced = read_staging_status(repo.path(), &["clean.txt".into()]).unwrap();
    assert!(replaced.full);
    assert_ne!(replaced.revision, before.revision);
    assert!(replaced.entries.iter().any(|entry| entry.path == "file.txt" && entry.staged));
    assert_eq!(replaced.revision, staging_revision(repo.path()).unwrap());
    repo.git(&["replace", "-d", &original]);
    let restored = read_staging_status(repo.path(), &["clean.txt".into()]).unwrap();
    assert!(restored.full);
    assert_eq!(restored.revision, before.revision);
}

#[test]
#[ignore = "manual performance measurement with 20000 untracked files"]
fn staging_benchmark_incremental_status_on_many_untracked_files() {
    let repo = StagingRepo::new(true);
    for number in 0..20_000 { repo.write(&format!("untracked-{number}.txt"), "content\n"); }
    let started = std::time::Instant::now();
    let full = read_staging_status(repo.path(), &[]).unwrap();
    let full_elapsed = started.elapsed();
    assert_eq!(full.entries.len(), 20_000);
    let started = std::time::Instant::now();
    for _ in 0..5 {
        let partial = read_staging_status(repo.path(), &["untracked-0.txt".into()]).unwrap();
        assert!(!partial.full);
        assert_eq!(partial.entries.len(), 1);
        assert_eq!(partial.revision, full.revision);
    }
    eprintln!("20000 untracked files: full {:?}; incremental average {:?}", full_elapsed, started.elapsed() / 5);
}
