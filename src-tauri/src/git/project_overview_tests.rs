use super::*;
use std::path::PathBuf;

struct Repo(PathBuf);
impl Repo {
    fn new(initialized: bool, committed: bool) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let repo = Self(std::env::temp_dir().join(format!("gitkit-overview-{}-{nonce}-{serial}", std::process::id())));
        std::fs::create_dir(&repo.0).unwrap();
        if initialized {
            repo.git(&["init", "--initial-branch=main"]);
            repo.git(&["config", "user.name", "Fixture"]);
            repo.git(&["config", "user.email", "fixture@example.invalid"]);
            repo.git(&["config", "core.hooksPath", "/dev/null"]);
            repo.git(&["config", "commit.gpgSign", "false"]);
            if committed { repo.write("file.txt", "base\n"); repo.commit("base"); }
        }
        repo
    }
    fn path(&self) -> &str { self.0.to_str().unwrap() }
    fn git(&self, args: &[&str]) -> String { run_git(self.path(), args).unwrap() }
    fn write(&self, file: &str, text: &str) { std::fs::write(self.0.join(file), text).unwrap(); }
    fn commit(&self, message: &str) { self.git(&["add", "--all"]); self.git(&["commit", "-m", message]); }
    fn overview(&self) -> ProjectOverviewSummary { project_overview_inner(self.path()).unwrap() }
    fn track(&self, revision: &str) {
        self.git(&["remote", "add", "origin", "/nonexistent/gitkit-overview-remote"]);
        self.git(&["update-ref", "refs/remotes/origin/main", revision]);
        self.git(&["branch", "--set-upstream-to=origin/main", "main"]);
    }
}
impl Drop for Repo { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

#[test]
fn overview_counts_unique_paths_and_does_not_write_index_refs_or_fetch() {
    let repo = Repo::new(true, true);
    repo.git(&["checkout", "-b", "local-feature"]);
    repo.git(&["branch", "--set-upstream-to=main"]);
    repo.write("local.txt", "local commit\n"); repo.commit("local commit");
    let local = repo.overview();
    assert!(!local.upstream_remote);
    assert!(!local.has_remotes);
    assert_eq!(local.upstream.as_deref(), Some("main"));
    assert_eq!(local.ahead, Some(1));
    repo.git(&["checkout", "main"]);
    let head = repo.git(&["rev-parse", "HEAD"]);
    repo.track(head.trim());
    repo.write("file.txt", "staged\n");
    repo.git(&["add", "file.txt"]);
    repo.write("file.txt", "later work\n");
    repo.write("untracked.txt", "new\n");
    let index = std::fs::read(repo.0.join(".git/index")).unwrap();
    let index_modified = std::fs::metadata(repo.0.join(".git/index")).unwrap().modified().unwrap();
    let refs = repo.git(&["show-ref"]);
    let overview = repo.overview();
    assert_eq!((overview.changed_files, overview.staged_files, overview.unstaged_files), (2, 1, 2));
    assert_eq!((overview.ahead, overview.behind), (Some(0), Some(0)));
    assert_eq!(overview.conflict_files, 0);
    assert!(overview.checked_at > 0);
    assert_eq!(std::fs::read(repo.0.join(".git/index")).unwrap(), index);
    assert_eq!(std::fs::metadata(repo.0.join(".git/index")).unwrap().modified().unwrap(), index_modified);
    assert_eq!(repo.git(&["show-ref"]), refs);
    assert!(!repo.0.join(".git/FETCH_HEAD").exists());
    std::fs::write(repo.0.join(".git/FETCH_HEAD"), "previous fetch snapshot\n").unwrap();
    repo.overview();
    assert_eq!(std::fs::read_to_string(repo.0.join(".git/FETCH_HEAD")).unwrap(), "previous fetch snapshot\n");
    assert_eq!(std::fs::read_to_string(repo.0.join("file.txt")).unwrap(), "later work\n");
}

#[test]
fn overview_compares_ahead_behind_and_diverged_without_fetching() {
    let repo = Repo::new(true, true);
    let base = repo.git(&["rev-parse", "HEAD"]);
    repo.track(base.trim());
    repo.write("local.txt", "local\n"); repo.commit("local");
    let local = repo.git(&["rev-parse", "HEAD"]);
    let ahead = repo.overview();
    assert_eq!((ahead.ahead, ahead.behind), (Some(1), Some(0)));
    assert!(ahead.behind_branches.is_empty());
    repo.git(&["checkout", "-b", "remote-side", base.trim()]);
    repo.write("remote.txt", "remote\n"); repo.commit("remote");
    let remote = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["update-ref", "refs/remotes/origin/main", remote.trim()]);
    repo.git(&["checkout", "main"]);
    let diverged = repo.overview();
    assert_eq!((diverged.ahead, diverged.behind), (Some(1), Some(1)));
    assert_eq!(diverged.behind_branches.len(), 1);
    assert!(diverged.behind_branches[0].current);
    assert_eq!(diverged.behind_branches[0].upstream, "origin/main");
    repo.git(&["reset", "--hard", base.trim()]);
    let behind = repo.overview();
    assert_eq!((behind.ahead, behind.behind), (Some(0), Some(1)));
    repo.git(&["update-ref", "refs/heads/local-only", local.trim()]);
    repo.git(&["branch", "--set-upstream-to=origin/main", "local-only"]);
    assert_eq!(repo.overview().behind_branches.len(), 2);
}

#[test]
fn plain_unborn_detached_and_missing_upstream_never_claim_synchronization() {
    let plain = Repo::new(false, false);
    let overview = plain.overview();
    assert!(!overview.initialized); assert!(!overview.has_head); assert!(!overview.detached);
    assert_eq!((overview.ahead, overview.behind), (None, None));
    assert!(!plain.0.join(".git").exists());
    let unborn = Repo::new(true, false);
    unborn.write("new.txt", "new\n");
    let overview = unborn.overview();
    assert!(overview.initialized); assert!(!overview.has_head); assert_eq!(overview.current_branch, "main");
    assert_eq!(overview.changed_files, 1); assert_eq!(overview.ahead, None);
    let repo = Repo::new(true, true);
    assert_eq!((repo.overview().ahead, repo.overview().behind), (None, None));
    let head = repo.git(&["rev-parse", "HEAD"]); repo.track(head.trim());
    repo.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
    let missing = repo.overview();
    assert!(missing.has_remotes); assert!(missing.upstream_missing);
    assert_eq!(missing.upstream.as_deref(), Some("origin/main"));
    assert_eq!((missing.ahead, missing.behind), (None, None));
    repo.git(&["checkout", "--detach"]);
    let detached = repo.overview();
    assert!(detached.detached); assert!(detached.has_head);
    assert_eq!((detached.ahead, detached.behind, detached.upstream), (None, None, None));
}

#[test]
fn resolved_and_staged_merge_is_still_an_unfinished_operation() {
    let repo = Repo::new(true, true);
    repo.git(&["checkout", "-b", "feature"]);
    repo.write("file.txt", "feature\n"); repo.commit("feature");
    repo.git(&["checkout", "main"]);
    repo.write("file.txt", "main\n"); repo.commit("main");
    assert!(run_git(repo.path(), &["merge", "feature"]).is_err());
    let conflict = repo.overview();
    assert_eq!(conflict.operation.as_deref(), Some("merge"));
    assert_eq!((conflict.changed_files, conflict.conflict_files, conflict.staged_files, conflict.unstaged_files), (1, 1, 0, 1));
    repo.write("file.txt", "resolved\n"); repo.git(&["add", "file.txt"]);
    let resolved = repo.overview();
    assert_eq!(resolved.operation.as_deref(), Some("merge"));
    assert_eq!((resolved.conflict_files, resolved.staged_files, resolved.unstaged_files), (0, 1, 0));
    assert!(repo.0.join(".git/MERGE_HEAD").exists());
    repo.write("file.txt", "main\n"); repo.git(&["add", "file.txt"]);
    let same_tree = repo.overview();
    assert_eq!(same_tree.changed_files, 0);
    assert_eq!(same_tree.operation.as_deref(), Some("merge"));
}

#[test]
fn inaccessible_or_invalid_git_metadata_is_reported_as_an_error() {
    let repo = Repo::new(false, false);
    assert!(project_overview_inner(repo.0.join("missing").to_str().unwrap()).is_err());
    repo.write(".git", "gitdir: /nonexistent/gitkit-overview-metadata\n");
    assert!(project_overview_inner(repo.path()).is_err());
}

#[test]
fn batch_tracking_counts_use_full_refs_and_keep_local_upstreams_distinct() {
    let repo = Repo::new(true, true);
    let base = repo.git(&["rev-parse", "HEAD"]);
    repo.track(base.trim());
    repo.git(&["tag", "main"]);
    repo.git(&["tag", "origin/main"]);
    repo.git(&["checkout", "-b", "remote-side"]);
    for index in 0..3 {
        repo.write("remote.txt", &format!("remote {index}\n")); repo.commit("remote change");
    }
    let remote = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["update-ref", "refs/remotes/origin/main", remote.trim()]);
    repo.git(&["checkout", "refs/heads/main"]);
    // Explicit symbolic HEAD keeps the fixture on the local branch despite
    // deliberately ambiguous short tag/branch names.
    repo.git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
    for index in 0..2 {
        repo.write("local.txt", &format!("local {index}\n")); repo.commit("local change");
    }
    let overview = repo.overview();
    assert_eq!((overview.ahead, overview.behind), (Some(2), Some(3)));
    assert!(overview.upstream_remote);
    assert_eq!(overview.behind_branches.len(), 1);
    assert_eq!((overview.behind_branches[0].ahead, overview.behind_branches[0].behind), (2, 3));
    repo.git(&["checkout", "-b", "local-feature"]);
    repo.git(&["config", "branch.local-feature.remote", "."]);
    repo.git(&["config", "branch.local-feature.merge", "refs/heads/main"]);
    repo.write("feature.txt", "local feature\n"); repo.commit("feature");
    let local = repo.overview();
    assert!(local.has_remotes);
    assert!(!local.upstream_remote);
    assert_eq!(local.upstream.as_deref(), Some("main"));
    assert_eq!((local.ahead, local.behind), (Some(1), Some(0)));
}

#[test]
fn gone_upstream_is_distinguished_from_matching_children_and_corrupt_objects() {
    let repo = Repo::new(true, true);
    let head = repo.git(&["rev-parse", "HEAD"]);
    repo.track(head.trim());
    repo.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
    repo.git(&["update-ref", "refs/remotes/origin/main/child", head.trim()]);
    let missing = repo.overview();
    assert!(missing.upstream_missing);
    assert_eq!((missing.ahead, missing.behind), (None, None));
    assert!(missing.behind_branches.is_empty());
    repo.git(&["update-ref", "-d", "refs/remotes/origin/main/child"]);
    let reference = repo.0.join(".git/refs/remotes/origin/main");
    std::fs::create_dir_all(reference.parent().unwrap()).unwrap();
    std::fs::write(&reference, format!("{}\n", "a".repeat(40))).unwrap();
    assert!(project_overview_inner(repo.path()).is_err());
    std::fs::write(&reference, "malformed ref\n").unwrap();
    assert!(project_overview_inner(repo.path()).is_err());
    std::fs::remove_file(&reference).unwrap();
    let blob = repo.git(&["hash-object", "-w", "file.txt"]);
    repo.git(&["update-ref", "refs/remotes/origin/main", blob.trim()]);
    assert!(project_overview_inner(repo.path()).is_err());
}

#[test]
fn tracking_counts_reject_unexpected_or_partial_output() {
    assert_eq!(parse_tracking_counts("").unwrap(), Some((0, 0)));
    assert_eq!(parse_tracking_counts("ahead 12").unwrap(), Some((12, 0)));
    assert_eq!(parse_tracking_counts("behind 34").unwrap(), Some((0, 34)));
    assert_eq!(parse_tracking_counts("ahead 12, behind 34").unwrap(), Some((12, 34)));
    assert_eq!(parse_tracking_counts("gone").unwrap(), None);
    for invalid in ["ahead", "ahead x", "ahead 1, ahead 2", "unknown 1", "ahead 1, ", "behind 4294967296"] {
        assert!(parse_tracking_counts(invalid).is_err(), "{invalid}");
    }
}

#[test]
#[ignore = "manual performance measurement; run with --ignored --nocapture"]
fn overview_benchmark_100_tracking_branches() {
    use std::io::Write;
    use std::process::Stdio;
    use std::time::Instant;

    let repo = Repo::new(true, true);
    let base = repo.git(&["rev-parse", "HEAD"]);
    repo.track(base.trim());
    let mut refs = String::new();
    let mut config = String::new();
    for index in 0..99 {
        let name = format!("tracking-{index}");
        refs.push_str(&format!("create refs/heads/{name} {}\n", base.trim()));
        config.push_str(&format!("\n[branch \"{name}\"]\n\tremote = origin\n\tmerge = refs/heads/main\n"));
    }
    let mut child = git_auth_command(repo.path(), &["update-ref", "--stdin"], None)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(refs.as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    std::fs::OpenOptions::new().append(true).open(repo.0.join(".git/config")).unwrap()
        .write_all(config.as_bytes()).unwrap();
    repo.git(&["checkout", "-b", "remote-side"]);
    repo.write("remote.txt", "remote\n"); repo.commit("remote");
    let remote = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["update-ref", "refs/remotes/origin/main", remote.trim()]);
    repo.git(&["checkout", "main"]);
    repo.overview();
    let mut measurements = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        let overview = repo.overview();
        measurements.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(overview.behind_branches.len(), 100);
        assert!(overview.behind_branches.iter().all(|branch| branch.ahead == 0 && branch.behind == 1));
    }
    let average = measurements.iter().sum::<f64>() / measurements.len() as f64;
    println!("100 tracking branches, full overview scan: {measurements:?} ms; mean {average:.2} ms");
}

#[test]
fn local_sync_rejects_an_unfinished_merge_even_when_the_working_tree_is_clean() {
    let repo = Repo::new(true, true);
    repo.git(&["checkout", "-b", "feature"]);
    repo.write("file.txt", "feature\n"); repo.commit("feature");
    repo.git(&["checkout", "main"]);
    repo.write("file.txt", "main\n"); repo.commit("main");
    repo.git(&["checkout", "-b", "remote-side"]);
    repo.write("remote.txt", "remote\n"); repo.commit("remote");
    let remote = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["checkout", "main"]);
    repo.track(remote.trim());
    repo.git(&["branch", "spare"]);
    repo.git(&["branch", "--set-upstream-to=origin/main", "spare"]);
    assert!(run_git(repo.path(), &["merge", "feature"]).is_err());
    // Resolving the conflict back to HEAD makes porcelain empty while Git's
    // merge operation still needs an explicit continue or abort.
    repo.write("file.txt", "main\n"); repo.git(&["add", "file.txt"]);
    assert!(repo.git(&["status", "--porcelain"]).trim().is_empty());
    let refs = repo.git(&["show-ref"]);
    let index = std::fs::read(repo.0.join(".git/index")).unwrap();
    let error = super::super::sync_local_inner(repo.path()).err().unwrap();
    assert!(error.contains("请先完成或中止当前 Git 操作"), "{error}");
    assert_eq!(repo.git(&["show-ref"]), refs);
    assert_eq!(std::fs::read(repo.0.join(".git/index")).unwrap(), index);
    assert!(repo.0.join(".git/MERGE_HEAD").exists());
    assert_eq!(repo.overview().behind_branches.len(), 2);
}
