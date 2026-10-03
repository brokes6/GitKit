use super::*;
use crate::git::{commit_index_inner, stage_files_inner, WatchGitRoots};
use std::time::{SystemTime, UNIX_EPOCH};

struct Repo(PathBuf);

impl Repo {
    fn new() -> Self {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let serial = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let repo = Self(std::env::temp_dir().join(format!("gitkit-merge-{}-{nonce}-{serial}", std::process::id())));
        std::fs::create_dir(&repo.0).unwrap();
        repo.git(&["init", "--initial-branch=main"]);
        repo.git(&["config", "user.name", "Fixture"]);
        repo.git(&["config", "user.email", "fixture@example.invalid"]);
        repo.git(&["config", "core.hooksPath", "/dev/null"]);
        repo.git(&["config", "commit.gpgSign", "false"]);
        repo.write("file.txt", "base\n");
        repo.commit("base");
        repo
    }
    fn path(&self) -> &str { self.0.to_str().unwrap() }
    fn git(&self, args: &[&str]) -> String { run_git(self.path(), args).unwrap() }
    fn write(&self, path: &str, contents: &str) { std::fs::write(self.0.join(path), contents).unwrap(); }
    fn commit(&self, message: &str) {
        self.git(&["add", "--all"]);
        self.git(&["commit", "-m", message]);
    }
    fn preview(&self) -> LocalMergePreview { local_merge_preview_inner(self.path(), "feature").unwrap() }
    fn merge(&self, preview: &LocalMergePreview) -> Result<LocalMergeResult, String> {
        local_merge_inner(self.path(), &preview.source, &preview.branch, &preview.head,
            &preview.source_head, None, None)
    }
    fn ff_source(&self) {
        self.git(&["checkout", "-b", "feature"]);
        self.write("feature.txt", "source\n");
        self.commit("feature");
        self.git(&["checkout", "main"]);
    }
    fn diverged_source(&self) {
        self.ff_source();
        self.write("main.txt", "target\n");
        self.commit("main");
    }
    fn conflict_source(&self, file: &str) {
        if file != "file.txt" {
            self.git(&["mv", "--", "file.txt", file]);
            self.commit("rename");
        }
        self.git(&["checkout", "-b", "feature"]);
        self.write(file, "theirs\n");
        self.commit("theirs");
        self.git(&["checkout", "main"]);
        self.write(file, "ours\n");
        self.commit("ours");
    }
    fn state(&self) -> RepositoryOperation { operation_state_inner(self.path()).unwrap().unwrap() }
    fn resolve(&self, file: &str, contents: &str) {
        self.write(file, contents);
        stage_files_inner(self.path(), &[file.into()], false).unwrap();
    }
}
impl Drop for Repo {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

#[test]
fn fast_forward_and_already_merged_match_git_without_extra_commit() {
    let repo = Repo::new();
    repo.ff_source();
    let preview = repo.preview();
    assert_eq!(preview.kind, "fast-forward");
    assert_eq!(preview.files, vec!["feature.txt"]);
    let result = repo.merge(&preview).unwrap();
    assert_eq!(result.status, "merged");
    assert!(result.operation.is_none());
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), preview.source_head);
    let preview = repo.preview();
    assert_eq!(preview.kind, "up-to-date");
    assert!(preview.files.is_empty());
    assert_eq!(repo.merge(&preview).unwrap().status, "up-to-date");
}

#[test]
fn clean_divergence_creates_merge_with_selected_identity_and_honors_default_ff_policy_override() {
    let repo = Repo::new();
    repo.diverged_source();
    repo.git(&["config", "merge.ff", "only"]);
    repo.git(&["config", "merge.autoStash", "true"]);
    let preview = repo.preview();
    assert_eq!(preview.kind, "merge");
    assert!(preview.conflicts.is_empty());
    local_merge_inner(repo.path(), &preview.source, &preview.branch, &preview.head,
        &preview.source_head, Some("Chosen User"), Some("chosen@example.invalid")).unwrap();
    assert_eq!(repo.git(&["show", "-s", "--format=%P"]).trim(), format!("{} {}", preview.head, preview.source_head));
    assert_eq!(repo.git(&["show", "-s", "--format=%an <%ae>|%cn <%ce>"]).trim(),
        "Chosen User <chosen@example.invalid>|Chosen User <chosen@example.invalid>");
    assert_eq!(repo.git(&["config", "user.name"]).trim(), "Fixture");
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]).trim(), "Merge branch 'feature' into main");
    assert!(operation_state_inner(repo.path()).unwrap().is_none());
}

#[test]
fn literal_conflict_paths_survive_preview_execution_and_resolution() {
    let repo = Repo::new();
    let file = " 空格中文\nfile.txt ";
    repo.conflict_source(file);
    let preview = repo.preview();
    assert_eq!(preview.conflicts, vec![file]);
    let result = repo.merge(&preview).unwrap();
    assert_eq!(result.status, "conflict");
    assert_eq!(result.operation.unwrap().conflicts, vec![file]);
    assert!(!repo.state().message.contains("Conflicts:"));
    repo.resolve(file, "resolved\n");
    let reviewed = repo.state();
    assert_eq!(reviewed.staged_files, vec![file]);
    assert!(reviewed.conflicts.is_empty());
    repo.write(file, "later edit\n");
    assert!(merge_continue_inner(repo.path(), &reviewed.revision, "merge reviewed", None, None).is_err());
    let fresh = repo.state();
    assert_eq!(fresh.unstaged_files, vec![file]);
    merge_continue_inner(repo.path(), &fresh.revision, "merge reviewed", Some("Resolver"), Some("resolver@example.invalid")).unwrap();
    assert_eq!(repo.git(&["show", &format!("HEAD:{file}")]), "resolved\n");
    assert_eq!(std::fs::read_to_string(repo.0.join(file)).unwrap(), "later edit\n");
    assert_eq!(repo.git(&["show", "-s", "--format=%P"]).trim(), format!("{} {}", preview.head, preview.source_head));
    assert_eq!(repo.git(&["show", "-s", "--format=%an <%ae>"]).trim(), "Resolver <resolver@example.invalid>");
    assert!(operation_state_inner(repo.path()).unwrap().is_none());
}

#[test]
fn unresolved_continue_is_rejected_and_resolving_to_ours_can_create_empty_tree_merge() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    let preview = repo.preview();
    repo.merge(&preview).unwrap();
    let unresolved = repo.state();
    assert!(merge_continue_inner(repo.path(), &unresolved.revision, "merge", None, None).unwrap_err().contains("未解决"));
    repo.resolve("file.txt", "ours\n");
    assert!(repo.git(&["diff", "--cached", "--name-only"]).is_empty());
    let state = repo.state();
    merge_continue_inner(repo.path(), &state.revision, "keep ours", None, None).unwrap();
    assert_eq!(repo.git(&["rev-parse", "HEAD^{tree}"]).trim(), repo.git(&["rev-parse", "HEAD^1^{tree}"]).trim());
    assert_eq!(repo.git(&["show", "-s", "--format=%P"]).trim(), format!("{} {}", preview.head, preview.source_head));
}

#[test]
fn abort_restores_current_branch_and_checks_same_status_content_changes() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    let preview = repo.preview();
    repo.merge(&preview).unwrap();
    let state = repo.state();
    repo.write("file.txt", "edited resolution\n");
    assert!(merge_abort_inner(repo.path(), &state.revision).unwrap_err().contains("已变化"));
    assert_eq!(std::fs::read_to_string(repo.0.join("file.txt")).unwrap(), "edited resolution\n");
    let fresh = repo.state();
    merge_abort_inner(repo.path(), &fresh.revision).unwrap();
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), preview.head);
    assert_eq!(std::fs::read_to_string(repo.0.join("file.txt")).unwrap(), "ours\n");
    assert!(operation_state_inner(repo.path()).unwrap().is_none());
}

#[test]
fn abort_checks_untracked_content_and_preserves_untracked_files() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    repo.merge(&repo.preview()).unwrap();
    repo.write("new.txt", "one\n");
    let state = repo.state();
    repo.write("new.txt", "two\n");
    assert!(merge_abort_inner(repo.path(), &state.revision).is_err());
    merge_abort_inner(repo.path(), &repo.state().revision).unwrap();
    assert_eq!(std::fs::read_to_string(repo.0.join("new.txt")).unwrap(), "two\n");
}

#[test]
fn snapshot_covers_same_status_same_size_changes_at_end_of_large_untracked_file() {
    use std::io::{Read, Seek, SeekFrom};
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    repo.merge(&repo.preview()).unwrap();
    let payload = repo.0.join("large.bin");
    let file = std::fs::File::create(&payload).unwrap();
    file.set_len(16 * 1024 * 1024).unwrap();
    drop(file);
    let status = repo.git(&["status", "--porcelain", "-uall", "-z"]);
    let reviewed = repo.state();
    let index_revision = staging_revision(repo.path()).unwrap();
    let mut file = std::fs::OpenOptions::new().write(true).open(&payload).unwrap();
    file.seek(SeekFrom::End(-1)).unwrap();
    file.write_all(b"x").unwrap();
    drop(file);
    assert_eq!(repo.git(&["status", "--porcelain", "-uall", "-z"]), status);
    assert_eq!(staging_revision(repo.path()).unwrap(), index_revision);
    assert!(merge_abort_inner(repo.path(), &reviewed.revision).unwrap_err().contains("已变化"));
    let fresh = repo.state();
    assert_ne!(fresh.revision, reviewed.revision);
    merge_abort_inner(repo.path(), &fresh.revision).unwrap();
    let mut file = std::fs::File::open(payload).unwrap();
    file.seek(SeekFrom::End(-1)).unwrap();
    let mut tail = [0];
    file.read_exact(&mut tail).unwrap();
    assert_eq!(tail, *b"x");
}

#[test]
fn dirty_untracked_staged_and_unstaged_changes_block_start_without_touching_files() {
    let repo = Repo::new();
    repo.ff_source();
    let preview = repo.preview();
    repo.write("local.txt", "local\n");
    assert!(repo.merge(&preview).unwrap_err().contains("未提交"));
    assert!(local_merge_preview_inner(repo.path(), "feature").is_err());
    repo.git(&["add", "local.txt"]);
    assert!(repo.merge(&preview).is_err());
    repo.git(&["reset", "--", "local.txt"]);
    std::fs::remove_file(repo.0.join("local.txt")).unwrap();
    repo.write("file.txt", "working\n");
    assert!(repo.merge(&preview).is_err());
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), preview.head);
    assert_eq!(std::fs::read_to_string(repo.0.join("file.txt")).unwrap(), "working\n");
}

#[test]
fn branch_head_and_source_movements_invalidate_preview() {
    let repo = Repo::new();
    repo.ff_source();
    let preview = repo.preview();
    repo.git(&["checkout", "-b", "other"]);
    assert!(repo.merge(&preview).unwrap_err().contains("已变化"));
    repo.git(&["checkout", "main"]);
    repo.git(&["commit", "--allow-empty", "-m", "moved target"]);
    assert!(repo.merge(&preview).unwrap_err().contains("已变化"));
    let fresh = repo.preview();
    repo.git(&["checkout", "feature"]);
    repo.git(&["commit", "--allow-empty", "-m", "moved source"]);
    repo.git(&["checkout", "main"]);
    assert!(repo.merge(&fresh).unwrap_err().contains("已变化"));
}

#[test]
fn detached_head_and_nonbranch_sources_are_rejected() {
    let repo = Repo::new();
    repo.ff_source();
    assert!(local_merge_preview_inner(repo.path(), "-bad").is_err());
    let sha = repo.git(&["rev-parse", "feature"]);
    assert!(local_merge_preview_inner(repo.path(), sha.trim()).is_err());
    repo.git(&["tag", "tagged", "feature"]);
    assert!(local_merge_preview_inner(repo.path(), "tagged").is_err());
    repo.git(&["checkout", "--detach"]);
    assert!(local_merge_preview_inner(repo.path(), "feature").unwrap_err().contains("分离"));
}

#[test]
fn terminal_origin_merge_state_is_reconstructed_and_ordinary_commit_is_blocked() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    assert!(run_git(repo.path(), &["merge", "feature", "--no-edit"]).is_err());
    let first = repo.state();
    assert_eq!(first.kind, "merge");
    assert!(first.message.contains("feature"));
    assert_eq!(repo.state().revision, first.revision);
    assert!(local_merge_preview_inner(repo.path(), "feature").unwrap_err().contains("当前 Git 操作"));
    repo.resolve("file.txt", "resolved\n");
    assert!(commit_index_inner(repo.path(), "ordinary", &staging_revision(repo.path()).unwrap(), None, None)
        .unwrap_err().contains("继续合并"));
    merge_continue_inner(repo.path(), &repo.state().revision, "from terminal", None, None).unwrap();
    assert!(operation_state_inner(repo.path()).unwrap().is_none());
}

#[cfg(unix)]
#[test]
fn hooks_run_and_failed_commit_leaves_recoverable_merge_state() {
    use std::os::unix::fs::PermissionsExt;
    let repo = Repo::new();
    repo.diverged_source();
    let hooks = repo.0.join(".git/custom-hooks");
    std::fs::create_dir(&hooks).unwrap();
    repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    let pre_merge = hooks.join("pre-merge-commit");
    std::fs::write(&pre_merge, "#!/bin/sh\necho merge-hook-rejected >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&pre_merge, std::fs::Permissions::from_mode(0o755)).unwrap();
    let preview = repo.preview();
    assert!(repo.merge(&preview).unwrap_err().contains("merge-hook-rejected"));
    let state = repo.state();
    assert!(state.conflicts.is_empty());
    assert!(state.can_continue);
    let pre_commit = hooks.join("pre-commit");
    std::fs::write(&pre_commit, "#!/bin/sh\necho commit-hook-rejected >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&pre_commit, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(merge_continue_inner(repo.path(), &state.revision, "merge after hook", None, None)
        .unwrap_err().contains("commit-hook-rejected"));
    assert!(repo.state().can_continue);
    std::fs::remove_file(&pre_commit).unwrap();
    merge_continue_inner(repo.path(), &repo.state().revision, "merge after hook", None, None).unwrap();
    assert!(operation_state_inner(repo.path()).unwrap().is_none());
}

#[test]
fn cherry_pick_recovery_and_unsupported_rebase_do_not_enable_merge_actions() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    assert!(run_git(repo.path(), &["cherry-pick", "feature"]).is_err());
    let state = repo.state();
    assert_eq!(state.kind, "cherry-pick");
    assert!(!state.can_continue && state.can_abort);
    assert!(merge_abort_inner(repo.path(), &state.revision).unwrap_err().contains("不是合并"));
    assert!(local_merge_preview_inner(repo.path(), "feature").is_err());
    repo.git(&["cherry-pick", "--abort"]);
    assert!(run_git(repo.path(), &["rebase", "feature"]).is_err());
    let state = repo.state();
    assert_eq!(state.kind, "rebase");
    assert!(!state.can_continue && !state.can_abort);
    repo.git(&["rebase", "--abort"]);
}

#[test]
fn linked_worktree_state_and_metadata_watch_are_isolated_from_main_checkout() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    std::fs::write(repo.0.join(".git/info/exclude"), "linked/\n").unwrap();
    let linked = repo.0.join("linked");
    repo.git(&["worktree", "add", "-b", "linked", linked.to_str().unwrap(), "main"]);
    let path = linked.to_str().unwrap();
    let preview = local_merge_preview_inner(path, "feature").unwrap();
    local_merge_inner(path, "feature", &preview.branch, &preview.head, &preview.source_head, None, None).unwrap();
    let state = operation_state_inner(path).unwrap().unwrap();
    assert_eq!(state.kind, "merge");
    assert!(operation_state_inner(repo.path()).unwrap().is_none());
    let roots = WatchGitRoots::resolve(path).unwrap();
    for name in ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "ORIG_HEAD", "CHERRY_PICK_HEAD", "rebase-merge/message", "sequencer/todo"] {
        let metadata = git_path(path, name).unwrap();
        assert!(roots.is_metadata(&metadata));
        assert!(roots.triggers_status(&metadata));
    }
    assert!(!roots.triggers_status(&roots.common_dir.join("worktrees/other/MERGE_HEAD")));
    merge_abort_inner(path, &state.revision).unwrap();
    assert!(operation_state_inner(path).unwrap().is_none());
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), preview.head);
}

#[test]
fn resolved_operation_paths_match_git_for_primary_and_linked_worktrees() {
    let repo = Repo::new();
    std::fs::write(repo.0.join(".git/info/exclude"), "linked/\n").unwrap();
    let linked = repo.0.join("linked");
    repo.git(&["worktree", "add", "-b", "linked", linked.to_str().unwrap(), "main"]);
    for path in [repo.path(), linked.to_str().unwrap()] {
        let paths = OperationPaths::resolve(path).unwrap();
        for name in OPERATION_PATHS.iter().copied().chain(["sequencer/opts", "sequencer/todo", "rebase-merge/message"]) {
            // Use Git itself as the oracle, independent of the new resolver.
            let expected = run_git(path, &["rev-parse", "--git-path", name]).unwrap();
            let expected = PathBuf::from(expected.trim());
            let expected = if expected.is_absolute() { expected }
                else { Path::new(path).canonicalize().unwrap().join(expected) };
            assert_eq!(paths.get(name), expected, "{name} in {path}");
        }
        assert_eq!(operation_kind_at(&paths).unwrap(), None);
    }
    let linked_paths = OperationPaths::resolve(linked.to_str().unwrap()).unwrap();
    assert_ne!(linked_paths.git_dir, OperationPaths::resolve(repo.path()).unwrap().git_dir);
    std::fs::write(linked_paths.get("CHERRY_PICK_HEAD"), repo.git(&["rev-parse", "HEAD"])).unwrap();
    assert_eq!(active_operation_kind(linked.to_str().unwrap()).unwrap(), Some("cherry-pick"));
    assert_eq!(active_operation_kind(repo.path()).unwrap(), None);
    std::fs::remove_file(linked_paths.get("CHERRY_PICK_HEAD")).unwrap();
    std::fs::create_dir(linked_paths.get("sequencer")).unwrap();
    std::fs::write(linked_paths.get("sequencer/todo"), "revert HEAD external operation\n").unwrap();
    assert_eq!(active_operation_kind(linked.to_str().unwrap()).unwrap(), Some("revert"));
    assert_eq!(active_operation_kind(repo.path()).unwrap(), None);
}

#[test]
fn metadata_message_and_index_changes_invalidate_recovery_snapshot() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    repo.merge(&repo.preview()).unwrap();
    let state = repo.state();
    std::fs::write(git_path(repo.path(), "MERGE_MSG").unwrap(), "external message\n").unwrap();
    assert!(merge_abort_inner(repo.path(), &state.revision).is_err());
    let state = repo.state();
    repo.resolve("file.txt", "resolved\n");
    assert!(merge_continue_inner(repo.path(), &state.revision, "merge", None, None).is_err());
    let state = repo.state();
    assert_eq!(state.message, "external message\n");
    assert!(merge_continue_inner(repo.path(), &state.revision, " ", None, None).is_err());
    merge_abort_inner(repo.path(), &state.revision).unwrap();
}

#[test]
fn initial_message_uses_configured_comment_char_and_submitted_comments_remain_literal() {
    let repo = Repo::new();
    repo.git(&["config", "core.commentChar", ";"]);
    repo.conflict_source("file.txt");
    repo.merge(&repo.preview()).unwrap();
    let state = repo.state();
    assert!(!state.message.contains("Conflicts:"));
    assert!(!state.message.contains("file.txt"));
    repo.resolve("file.txt", "resolved\n");
    merge_continue_inner(repo.path(), &repo.state().revision, "User merge\n\n; retain my comment", None, None).unwrap();
    assert!(repo.git(&["log", "-1", "--format=%B"]).contains("; retain my comment"));
}

#[test]
fn branch_merge_strategy_options_do_not_override_reviewed_result() {
    let repo = Repo::new();
    repo.diverged_source();
    repo.git(&["config", "branch.main.mergeoptions", "--strategy=ours --no-verify"]);
    let preview = repo.preview();
    assert_eq!(preview.files, vec!["feature.txt"]);
    repo.merge(&preview).unwrap();
    assert_eq!(repo.git(&["show", "HEAD:feature.txt"]), "source\n");
    assert_eq!(repo.git(&["config", "branch.main.mergeoptions"]).trim(), "--strategy=ours --no-verify");
}

#[test]
fn untracked_unborn_nested_repo_does_not_block_recovery_and_changes_invalidate_snapshot() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    repo.merge(&repo.preview()).unwrap();
    let nested = repo.0.join("nested");
    std::fs::create_dir(&nested).unwrap();
    run_git(nested.to_str().unwrap(), &["init"]).unwrap();
    std::fs::write(nested.join("new.txt"), "first\n").unwrap();
    let state = repo.state();
    std::fs::write(nested.join("new.txt"), "second\n").unwrap();
    assert!(merge_abort_inner(repo.path(), &state.revision).is_err());
    merge_abort_inner(repo.path(), &repo.state().revision).unwrap();
    assert_eq!(std::fs::read_to_string(nested.join("new.txt")).unwrap(), "second\n");
}

#[test]
fn branch_switch_and_stash_actions_do_not_destroy_a_resolved_pending_merge() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    let preview = repo.preview();
    repo.git(&["branch", "same-head"]);
    repo.merge(&preview).unwrap();
    repo.resolve("file.txt", "resolved\n");
    let revision = repo.state().revision;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    assert!(runtime.block_on(crate::git::git_checkout(repo.path().into(), "same-head".into())).is_err());
    assert!(runtime.block_on(crate::git::git_checkout_sync(repo.path().into(), "same-head".into(), preview.head.clone())).is_err());
    assert!(runtime.block_on(crate::git::git_create_branch(repo.path().into(), "new".into(), "HEAD".into(), true)).is_err());
    assert!(runtime.block_on(crate::git::git_stash_push(repo.path().into(), "stash".into(), None, None)).is_err());
    assert!(runtime.block_on(crate::git::git_stash_apply(repo.path().into(), 0)).is_err());
    assert!(runtime.block_on(crate::git::git_cherry_pick(repo.path().into(), preview.source_head.clone(), Some("same-head".into()), false)).is_err());
    assert_eq!(repo.state().revision, revision);
    assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "main");
    assert!(run_git(repo.path(), &["show-ref", "--verify", "refs/heads/new"]).is_err());
    // Creating an unselected branch is harmless and remains available.
    runtime.block_on(crate::git::git_create_branch(repo.path().into(), "new".into(), "HEAD".into(), false)).unwrap();
    assert_eq!(repo.state().revision, revision);
}

#[test]
fn cherry_pick_execution_retains_clean_and_conflict_results_under_shared_lock() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let clean = Repo::new();
    clean.ff_source();
    let result = runtime.block_on(crate::git::git_cherry_pick(clean.path().into(),
        "feature".into(), Some("main".into()), false)).unwrap();
    assert_eq!(result.status, "clean");
    assert!(result.conflicts.is_empty());
    assert_eq!(clean.git(&["show", "HEAD:feature.txt"]), "source\n");
    assert!(operation_state_inner(clean.path()).unwrap().is_none());

    let conflicted = Repo::new();
    conflicted.conflict_source("file.txt");
    let result = runtime.block_on(crate::git::git_cherry_pick(conflicted.path().into(),
        "feature".into(), None, false)).unwrap();
    assert_eq!(result.status, "conflict");
    assert_eq!(result.conflicts, vec!["file.txt"]);
    assert_eq!(conflicted.state().kind, "cherry-pick");
    conflicted.git(&["cherry-pick", "--abort"]);
}

#[test]
fn external_cherry_pick_continue_retains_author_message_and_later_working_edits() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    repo.git(&["checkout", "feature"]);
    repo.git(&["commit", "--amend", "--author=Original Author <author@example.invalid>",
        "-m", "Original subject\n\nOriginal body."]);
    let original = repo.git(&["show", "-s", "--format=%an <%ae>|%aI|%B", "feature"]);
    repo.git(&["checkout", "main"]);
    assert!(run_git(repo.path(), &["cherry-pick", "feature"]).is_err());
    let unresolved = repo.state();
    assert!(!unresolved.can_continue && unresolved.can_abort);
    assert!(cherry_pick_continue_inner(repo.path(), &unresolved.revision, None, None)
        .unwrap_err().contains("未解决"));
    assert_eq!(merge_tool_state(repo.path(), &unresolved.revision).unwrap().kind, "cherry-pick");
    repo.resolve("file.txt", "resolved\n");
    let resolved = repo.state();
    assert!(resolved.can_continue);
    assert_eq!(repo.state().revision, resolved.revision); // Re-read after an app restart needs no session state.
    assert!(merge_tool_state(repo.path(), &resolved.revision).unwrap_err().contains("没有未解决"));
    repo.write("file.txt", "later working edit\n");
    assert!(cherry_pick_continue_inner(repo.path(), &resolved.revision, None, None).is_err());
    let fresh = repo.state();
    assert_eq!(fresh.unstaged_files, vec!["file.txt"]);
    assert!(cherry_pick_continue_inner(repo.path(), &fresh.revision,
        Some("Chosen Committer"), Some("committer@example.invalid")).unwrap().is_none());
    assert_eq!(repo.git(&["show", "-s", "--format=%an <%ae>|%aI|%B"]), original);
    assert_eq!(repo.git(&["show", "-s", "--format=%cn <%ce>"]).trim(),
        "Chosen Committer <committer@example.invalid>");
    assert_eq!(repo.git(&["config", "user.name"]).trim(), "Fixture");
    assert_eq!(repo.git(&["config", "user.email"]).trim(), "fixture@example.invalid");
    assert_eq!(repo.git(&["show", "HEAD:file.txt"]), "resolved\n");
    assert_eq!(std::fs::read_to_string(repo.0.join("file.txt")).unwrap(), "later working edit\n");
    assert!(operation_state_inner(repo.path()).unwrap().is_none());
}

#[test]
fn cherry_pick_continue_preserves_original_comment_lines_and_trailing_whitespace_verbatim() {
    for comment_char in ["#", ";"] {
        let repo = Repo::new();
        repo.conflict_source("file.txt");
        repo.git(&["config", "core.commentChar", comment_char]);
        repo.git(&["checkout", "feature"]);
        repo.git(&["commit", "--amend", "--cleanup=verbatim",
            "--author=Original Author <author@example.invalid>", "-m",
            "Original subject\n\n# original author note\n; another original note\nbody with spaces  \n\n\n"]);
        let original_author = repo.git(&["show", "-s", "--format=%an <%ae>|%aI"]);
        repo.git(&["checkout", "main"]);
        assert!(run_git(repo.path(), &["cherry-pick", "feature"]).is_err());
        let original_message = cherry_pick_message(repo.path()).unwrap().unwrap();
        let conflict = repo.state();
        assert_eq!(conflict.message.as_bytes(), original_message);
        assert!(conflict.message.contains("# original author note"));
        assert!(conflict.message.ends_with("spaces  \n\n\n"));
        assert!(!conflict.message.contains("Conflicts:"));
        repo.resolve("file.txt", "resolved\n");
        assert!(cherry_pick_continue_inner(repo.path(), &repo.state().revision,
            Some("Chosen Committer"), Some("committer@example.invalid")).unwrap().is_none());
        let committed = git_auth_command(repo.path(), &["cat-file", "commit", "HEAD"], None).output().unwrap();
        let body_start = committed.stdout.windows(2).position(|bytes| bytes == b"\n\n").unwrap() + 2;
        assert_eq!(&committed.stdout[body_start..], original_message);
        assert_eq!(repo.git(&["show", "-s", "--format=%an <%ae>|%aI"]), original_author);
        assert_eq!(repo.git(&["show", "-s", "--format=%cn <%ce>"]).trim(),
            "Chosen Committer <committer@example.invalid>");
    }
}

#[test]
fn cherry_pick_empty_resolution_requires_explicit_terminal_decision_and_can_abort() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    let head = repo.git(&["rev-parse", "HEAD"]);
    assert!(run_git(repo.path(), &["cherry-pick", "feature"]).is_err());
    repo.resolve("file.txt", "ours\n");
    let state = repo.state();
    assert!(state.conflicts.is_empty());
    assert!(!state.can_continue && state.can_abort);
    assert!(cherry_pick_continue_inner(repo.path(), &state.revision, None, None)
        .unwrap_err().contains("空提交"));
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), head);
    cherry_pick_abort_inner(repo.path(), &state.revision).unwrap();
    assert!(operation_state_inner(repo.path()).unwrap().is_none());
}

#[test]
fn cherry_pick_originally_empty_message_is_safely_rejected_without_mutation() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    repo.git(&["checkout", "feature"]);
    repo.git(&["commit", "--amend", "--allow-empty-message", "-m", ""]);
    let source = repo.git(&["rev-parse", "HEAD"]);
    let author = repo.git(&["show", "-s", "--format=%an <%ae>|%aI"]);
    repo.git(&["checkout", "main"]);
    let head = repo.git(&["rev-parse", "HEAD"]);
    assert!(run_git(repo.path(), &["cherry-pick", "feature"]).is_err());
    repo.resolve("file.txt", "resolved\n");
    let state = repo.state();
    let index = repo.git(&["write-tree"]);
    assert!(!state.can_continue && state.can_abort);
    assert!(cherry_pick_continue_inner(repo.path(), &state.revision, None, None)
        .unwrap_err().contains("原提交说明为空"));
    assert_eq!(repo.state().revision, state.revision);
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), head);
    assert_eq!(repo.git(&["write-tree"]), index);
    assert_eq!(cherry_pick_head(repo.path()).unwrap(), Some(source.trim().to_string()));
    assert_eq!(repo.git(&["show", "-s", "--format=%an <%ae>|%aI", "feature"]), author);
    cherry_pick_abort_inner(repo.path(), &state.revision).unwrap();
    assert!(operation_state_inner(repo.path()).unwrap().is_none());
}

#[test]
fn cherry_pick_stale_content_metadata_and_wrong_operation_are_rejected() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    let head = repo.git(&["rev-parse", "HEAD"]);
    assert!(run_git(repo.path(), &["cherry-pick", "feature"]).is_err());
    let state = repo.state();
    repo.write("file.txt", "edited resolution\n");
    assert!(cherry_pick_abort_inner(repo.path(), &state.revision).unwrap_err().contains("已变化"));
    assert!(merge_tool_state(repo.path(), &state.revision).is_err());
    repo.resolve("file.txt", "resolved\n");
    let state = repo.state();
    std::fs::write(git_path(repo.path(), "MERGE_MSG").unwrap(), "externally edited message\n").unwrap();
    assert!(cherry_pick_continue_inner(repo.path(), &state.revision, None, None).is_err());
    let edited = repo.state();
    assert!(!edited.can_continue && edited.can_abort);
    assert!(edited.continue_blocked_reason.as_ref().unwrap().contains("外部修改"));
    assert!(cherry_pick_continue_inner(repo.path(), &edited.revision, None, None)
        .unwrap_err().contains("外部修改"));
    assert!(cherry_pick_abort_inner(repo.path(), "").is_err());
    cherry_pick_abort_inner(repo.path(), &repo.state().revision).unwrap();
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), head);
    repo.merge(&repo.preview()).unwrap();
    let merge = repo.state();
    assert!(cherry_pick_continue_inner(repo.path(), &merge.revision, None, None)
        .unwrap_err().contains("不是 Cherry-pick"));
    assert!(cherry_pick_abort_inner(repo.path(), &merge.revision).unwrap_err().contains("不是 Cherry-pick"));
    merge_abort_inner(repo.path(), &merge.revision).unwrap();
    assert!(run_git(repo.path(), &["rebase", "feature"]).is_err());
    let rebase = repo.state();
    assert!(merge_tool_state(repo.path(), &rebase.revision).is_err());
    assert!(cherry_pick_continue_inner(repo.path(), &rebase.revision, None, None).is_err());
    assert!(cherry_pick_abort_inner(repo.path(), &rebase.revision).is_err());
    repo.git(&["rebase", "--abort"]);
}

fn conflicted_cherry_pick_sequence(repo: &Repo) -> (String, String) {
    repo.write("second.txt", "base\n");
    repo.commit("second base");
    repo.git(&["checkout", "-b", "feature"]);
    repo.write("file.txt", "theirs first\n");
    repo.commit("first source");
    let first = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.write("second.txt", "theirs second\n");
    repo.commit("second source");
    let second = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.git(&["checkout", "main"]);
    repo.write("file.txt", "ours first\n");
    repo.write("second.txt", "ours second\n");
    repo.commit("main changes");
    assert!(run_git(repo.path(), &["cherry-pick", &first, &second]).is_err());
    (first, second)
}

#[test]
fn external_sequence_continue_returns_next_conflict_and_abort_restores_sequence_start() {
    let repo = Repo::new();
    let (_, second) = conflicted_cherry_pick_sequence(&repo);
    let sequence_start = repo.git(&["rev-parse", "HEAD"]);
    assert_eq!(repo.state().conflicts, vec!["file.txt"]);
    repo.resolve("file.txt", "first resolved\n");
    let reviewed = repo.state();
    let next = cherry_pick_continue_inner(repo.path(), &reviewed.revision,
        Some("Resolver"), Some("resolver@example.invalid")).unwrap().unwrap();
    assert_eq!(next.kind, "cherry-pick");
    assert_eq!(next.conflicts, vec!["second.txt"]);
    assert_ne!(next.head, reviewed.head);
    assert_eq!(cherry_pick_head(repo.path()).unwrap(), Some(second));
    assert_eq!(repo.git(&["show", "-s", "--format=%s|%an|%cn"]).trim(), "first source|Fixture|Resolver");
    assert!(cherry_pick_abort_inner(repo.path(), &reviewed.revision).is_err());
    cherry_pick_abort_inner(repo.path(), &next.revision).unwrap();
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), sequence_start);
    assert_eq!(std::fs::read_to_string(repo.0.join("file.txt")).unwrap(), "ours first\n");
    assert_eq!(std::fs::read_to_string(repo.0.join("second.txt")).unwrap(), "ours second\n");
    assert!(operation_state_inner(repo.path()).unwrap().is_none());
}

#[test]
fn external_sequence_can_finish_multiple_conflicted_commits() {
    let repo = Repo::new();
    conflicted_cherry_pick_sequence(&repo);
    repo.resolve("file.txt", "first resolved\n");
    let next = cherry_pick_continue_inner(repo.path(), &repo.state().revision, None, None).unwrap().unwrap();
    assert_eq!(next.conflicts, vec!["second.txt"]);
    repo.resolve("second.txt", "second resolved\n");
    assert!(cherry_pick_continue_inner(repo.path(), &repo.state().revision, None, None).unwrap().is_none());
    assert_eq!(repo.git(&["log", "-2", "--format=%s"]), "second source\nfirst source\n");
    assert_eq!(repo.git(&["show", "HEAD:file.txt"]), "first resolved\n");
    assert_eq!(repo.git(&["show", "HEAD:second.txt"]), "second resolved\n");
}

#[test]
fn sequence_recovery_preserves_verbatim_messages_on_each_conflicted_pick() {
    let repo = Repo::new();
    let (first, _) = conflicted_cherry_pick_sequence(&repo);
    // Give both source commits deliberately significant comment/whitespace text.
    repo.git(&["cherry-pick", "--abort"]);
    repo.git(&["checkout", "feature"]);
    repo.git(&["commit", "--amend", "--cleanup=verbatim", "-m", "Second source\n\n# second author note\nspaces  \n\n"]);
    let second_text = repo.git(&["cat-file", "commit", "HEAD"]);
    let second = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.git(&["checkout", "--detach", &first]);
    repo.git(&["commit", "--amend", "--cleanup=verbatim", "-m", "First source\n\n# first author note\nspaces  \n\n"]);
    let first_text = repo.git(&["cat-file", "commit", "HEAD"]);
    let first = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.git(&["checkout", "main"]);
    assert!(run_git(repo.path(), &["cherry-pick", &first, &second]).is_err());
    repo.resolve("file.txt", "first resolved\n");
    let next = cherry_pick_continue_inner(repo.path(), &repo.state().revision, None, None).unwrap().unwrap();
    assert_eq!(next.conflicts, vec!["second.txt"]);
    let first_commit = repo.git(&["cat-file", "commit", "HEAD"]);
    assert_eq!(first_commit.split_once("\n\n").unwrap().1, first_text.split_once("\n\n").unwrap().1);
    assert_eq!(next.message, second_text.split_once("\n\n").unwrap().1);
    repo.resolve("second.txt", "second resolved\n");
    assert!(cherry_pick_continue_inner(repo.path(), &repo.state().revision, None, None).unwrap().is_none());
    let second_commit = repo.git(&["cat-file", "commit", "HEAD"]);
    assert_eq!(second_commit.split_once("\n\n").unwrap().1, second_text.split_once("\n\n").unwrap().1);
}

#[test]
fn external_record_origin_and_signoff_footers_survive_sequence_recovery() {
    let repo = Repo::new();
    let (first, second) = conflicted_cherry_pick_sequence(&repo);
    repo.git(&["cherry-pick", "--abort"]);
    assert!(run_git(repo.path(), &["cherry-pick", "-x", "-s", &first, &second]).is_err());
    let original = cherry_pick_message(repo.path()).unwrap().unwrap();
    let expected_first = cherry_pick_commit_message(repo.path(), &original).unwrap().unwrap();
    assert!(String::from_utf8_lossy(&expected_first).contains(&format!("(cherry picked from commit {first})")));
    assert!(String::from_utf8_lossy(&expected_first).contains("Signed-off-by: Fixture <fixture@example.invalid>"));
    assert!(!String::from_utf8_lossy(&expected_first).contains("Conflicts:"));
    assert_eq!(repo.state().message.as_bytes(), expected_first);
    repo.resolve("file.txt", "first resolved\n");
    let next = cherry_pick_continue_inner(repo.path(), &repo.state().revision, None, None).unwrap().unwrap();
    assert_eq!(next.conflicts, vec!["second.txt"]);
    assert_eq!(repo.git(&["cat-file", "commit", "HEAD"]).split_once("\n\n").unwrap().1.as_bytes(), expected_first);
    let original = cherry_pick_message(repo.path()).unwrap().unwrap();
    let expected_second = cherry_pick_commit_message(repo.path(), &original).unwrap().unwrap();
    assert!(String::from_utf8_lossy(&expected_second).contains(&format!("(cherry picked from commit {second})")));
    assert!(String::from_utf8_lossy(&expected_second).contains("Signed-off-by: Fixture <fixture@example.invalid>"));
    assert_eq!(next.message.as_bytes(), expected_second);
    repo.resolve("second.txt", "second resolved\n");
    assert!(cherry_pick_continue_inner(repo.path(), &repo.state().revision, None, None).unwrap().is_none());
    assert_eq!(repo.git(&["cat-file", "commit", "HEAD"]).split_once("\n\n").unwrap().1.as_bytes(), expected_second);
}

#[test]
fn external_no_commit_sequence_stays_readable_and_abortable_without_inventing_a_commit() {
    let repo = Repo::new();
    let (first, second) = conflicted_cherry_pick_sequence(&repo);
    repo.git(&["cherry-pick", "--abort"]);
    let head = repo.git(&["rev-parse", "HEAD"]);
    assert!(run_git(repo.path(), &["cherry-pick", "--no-commit", &first, &second]).is_err());
    repo.resolve("file.txt", "resolved\n");
    let state = repo.state();
    assert_eq!(state.kind, "cherry-pick");
    assert!(!state.can_continue && state.can_abort);
    assert!(state.continue_blocked_reason.as_ref().unwrap().contains("没有可恢复的原提交"));
    assert!(cherry_pick_continue_inner(repo.path(), &state.revision, None, None)
        .unwrap_err().contains("没有可恢复的原提交"));
    assert_eq!(repo.state().revision, state.revision);
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), head);
    cherry_pick_abort_inner(repo.path(), &state.revision).unwrap();
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), head);
    assert!(operation_state_inner(repo.path()).unwrap().is_none());
}

#[test]
fn linked_worktree_cherry_pick_continue_and_abort_leave_main_checkout_unchanged() {
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    std::fs::write(repo.0.join(".git/info/exclude"), "linked/\n").unwrap();
    let main_head = repo.git(&["rev-parse", "HEAD"]);
    let linked = repo.0.join("linked");
    repo.git(&["worktree", "add", "-b", "linked", linked.to_str().unwrap(), "main"]);
    let path = linked.to_str().unwrap();
    assert!(run_git(path, &["cherry-pick", "feature"]).is_err());
    let conflict = operation_state_inner(path).unwrap().unwrap();
    assert!(merge_tool_state(path, &conflict.revision).is_ok());
    assert!(operation_state_inner(repo.path()).unwrap().is_none());
    cherry_pick_abort_inner(path, &conflict.revision).unwrap();
    assert!(run_git(path, &["cherry-pick", "feature"]).is_err());
    std::fs::write(linked.join("file.txt"), "linked resolved\n").unwrap();
    stage_files_inner(path, &["file.txt".into()], false).unwrap();
    let resolved = operation_state_inner(path).unwrap().unwrap();
    assert!(cherry_pick_continue_inner(path, &resolved.revision, None, None).unwrap().is_none());
    assert_eq!(run_git(path, &["show", "HEAD:file.txt"]).unwrap(), "linked resolved\n");
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), main_head);
    assert_eq!(std::fs::read_to_string(repo.0.join("file.txt")).unwrap(), "ours\n");
}

#[cfg(unix)]
#[test]
fn cherry_pick_hooks_are_honored_and_failures_remain_recoverable_errors() {
    use std::os::unix::fs::PermissionsExt;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let repo = Repo::new();
    repo.ff_source();
    let hooks = repo.0.join(".git/custom-hooks");
    std::fs::create_dir(&hooks).unwrap();
    repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    let commit_msg = hooks.join("prepare-commit-msg");
    std::fs::write(&commit_msg, "#!/bin/sh\necho initial-hook-rejected >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&commit_msg, std::fs::Permissions::from_mode(0o755)).unwrap();
    let error = runtime.block_on(crate::git::git_cherry_pick(repo.path().into(), "feature".into(), None, false)).unwrap_err();
    assert!(error.contains("initial-hook-rejected"));
    let state = repo.state();
    assert_eq!(state.kind, "cherry-pick");
    assert!(state.can_continue && state.can_abort);
    assert!(cherry_pick_continue_inner(repo.path(), &state.revision, None, None)
        .unwrap_err().contains("initial-hook-rejected"));
    assert_eq!(repo.state().head, state.head);
    std::fs::remove_file(&commit_msg).unwrap();
    let pre_commit = hooks.join("pre-commit");
    std::fs::write(&pre_commit, "#!/bin/sh\necho continue-hook-rejected >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&pre_commit, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(cherry_pick_continue_inner(repo.path(), &repo.state().revision, None, None)
        .unwrap_err().contains("continue-hook-rejected"));
    assert!(repo.state().can_continue);
    std::fs::remove_file(&pre_commit).unwrap();
    assert!(cherry_pick_continue_inner(repo.path(), &repo.state().revision, None, None).unwrap().is_none());
}

#[cfg(unix)]
#[test]
fn next_sequence_commit_hook_failure_is_not_reported_as_success() {
    use std::os::unix::fs::PermissionsExt;
    let repo = Repo::new();
    repo.git(&["checkout", "-b", "feature"]);
    repo.write("file.txt", "theirs\n");
    repo.commit("first source");
    let first = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.write("next.txt", "next\n");
    repo.commit("second source");
    let second = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.git(&["checkout", "main"]);
    repo.write("file.txt", "ours\n");
    repo.commit("ours");
    assert!(run_git(repo.path(), &["cherry-pick", &first, &second]).is_err());
    repo.resolve("file.txt", "resolved\n");
    let reviewed = repo.state();
    let hooks = repo.0.join(".git/custom-hooks");
    std::fs::create_dir(&hooks).unwrap();
    repo.git(&["config", "core.hooksPath", hooks.to_str().unwrap()]);
    let hook = hooks.join("prepare-commit-msg");
    std::fs::write(&hook, "#!/bin/sh\nif grep -q '^second source' \"$1\"; then echo next-hook-rejected >&2; exit 1; fi\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(cherry_pick_continue_inner(repo.path(), &reviewed.revision, None, None)
        .unwrap_err().contains("next-hook-rejected"));
    let paused = repo.state();
    assert_ne!(paused.head, reviewed.head);
    assert!(paused.conflicts.is_empty());
    assert!(paused.can_continue && paused.can_abort);
    assert_eq!(cherry_pick_head(repo.path()).unwrap(), Some(second));
    assert_eq!(repo.git(&["show", "-s", "--format=%s"]).trim(), "first source");
    std::fs::remove_file(&hook).unwrap();
    assert!(cherry_pick_continue_inner(repo.path(), &paused.revision, None, None).unwrap().is_none());
    assert_eq!(repo.git(&["show", "-s", "--format=%s"]).trim(), "second source");
}

#[cfg(unix)]
fn rejecting_gpg_fixture(repo: &Repo) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let helper = repo.0.join(".git/fake-gpg");
    let captured = repo.0.join(".git/fake-gpg-args");
    std::fs::write(&helper, "#!/bin/sh\nprintf '%s\\n' \"$@\" > .git/fake-gpg-args\necho fake-gpg-rejected >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
    repo.git(&["config", "gpg.program", helper.to_str().unwrap()]);
    repo.git(&["config", "gpg.format", "openpgp"]);
    captured
}

#[cfg(unix)]
#[test]
fn sequence_signing_key_is_inherited_and_a_failed_signer_cannot_create_unsigned_commit() {
    for option in ["-Sfixture-explicit-key", "-S fixture key with spaces ", "-S"] {
        let repo = Repo::new();
        let (first, second) = conflicted_cherry_pick_sequence(&repo);
        repo.git(&["cherry-pick", "--abort"]);
        let head = repo.git(&["rev-parse", "HEAD"]);
        repo.git(&["config", "user.signingkey", "fixture-default-key"]);
        let captured = rejecting_gpg_fixture(&repo);
        assert!(run_git(repo.path(), &["cherry-pick", option, &first, &second]).is_err());
        assert!(!captured.exists()); // The first pick conflicted before signing.
        let saved_key = option.strip_prefix("-S").unwrap();
        let expected = if saved_key.is_empty() { "fixture-default-key" } else { saved_key };
        let saved = repo.git(&["config", "--file", git_path(repo.path(), "sequencer/opts").unwrap().to_str().unwrap(), "--get", "options.gpg-sign"]);
        assert_eq!(saved.strip_suffix('\n').unwrap_or(&saved), saved_key);
        assert_eq!(cherry_pick_signing_option(repo.path()).unwrap().as_deref(), Some(option));
        repo.resolve("file.txt", "resolved\n");
        let paused = repo.state();
        assert!(cherry_pick_continue_inner(repo.path(), &paused.revision, None, None)
            .unwrap_err().contains("fake-gpg-rejected"));
        assert!(std::fs::read_to_string(&captured).unwrap().contains(expected));
        assert_eq!(repo.git(&["rev-parse", "HEAD"]), head);
        assert_eq!(repo.state().kind, "cherry-pick");
        assert_eq!(cherry_pick_head(repo.path()).unwrap(), Some(first));
        assert!(repo.state().can_abort);
        cherry_pick_abort_inner(repo.path(), &repo.state().revision).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn unsigned_sequence_stays_unsigned_when_repository_signing_is_enabled_later() {
    for second_clean in [false, true] {
        let repo = Repo::new();
        let (first, second) = conflicted_cherry_pick_sequence(&repo);
        repo.git(&["cherry-pick", "--abort"]);
        if second_clean {
            repo.write("second.txt", "base\n");
            repo.commit("allow second source to apply cleanly");
        }
        let captured = rejecting_gpg_fixture(&repo);
        repo.git(&["config", "commit.gpgSign", "true"]);
        assert!(run_git(repo.path(), &["cherry-pick", "--no-gpg-sign", &first, &second]).is_err());
        assert!(git_path(repo.path(), "sequencer").unwrap().exists());
        assert_eq!(cherry_pick_signing_option(repo.path()).unwrap().as_deref(), Some("--no-gpg-sign"));
        repo.resolve("file.txt", "first resolved\n");
        let next = cherry_pick_continue_inner(repo.path(), &repo.state().revision, None, None).unwrap();
        if second_clean { assert!(next.is_none()); }
        else {
            assert_eq!(next.unwrap().conflicts, vec!["second.txt"]);
            assert!(!captured.exists());
            repo.resolve("second.txt", "second resolved\n");
            assert!(cherry_pick_continue_inner(repo.path(), &repo.state().revision, None, None).unwrap().is_none());
        }
        assert!(!captured.exists());
        assert!(operation_state_inner(repo.path()).unwrap().is_none());
        assert_eq!(repo.git(&["log", "-2", "--format=%s"]), "second source\nfirst source\n");
        assert!(!repo.git(&["cat-file", "commit", "HEAD"]).contains("\ngpgsig "));
        assert!(!repo.git(&["cat-file", "commit", "HEAD^"]).contains("\ngpgsig "));
    }
}

#[test]
#[ignore = "manual memory measurement with a 256 MiB generated file"]
fn operation_benchmark_large_generated_snapshot() {
    use std::io::Read;
    let repo = Repo::new();
    repo.conflict_source("file.txt");
    assert!(run_git(repo.path(), &["merge", "feature"]).is_err());
    let mut file = std::fs::File::create(repo.0.join("large-untracked.bin")).unwrap();
    std::io::copy(&mut std::io::repeat(b'x').take(256 * 1024 * 1024), &mut file).unwrap();
    drop(file);
    let started = std::time::Instant::now();
    let state = repo.state();
    assert_eq!(state.kind, "merge");
    assert!(state.unstaged_files.iter().any(|path| path == "large-untracked.bin"));
    eprintln!("256 MiB native operation snapshot: {:?}", started.elapsed());
}
