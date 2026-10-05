use super::*;
use crate::git::run_git;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;

const FROM: i64 = 1_700_000_000;

struct Repo(PathBuf);
impl Repo {
    fn new(initialized: bool) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let repo = Self(std::env::temp_dir().join(format!("gitkit-activity-{}-{nonce}-{serial}", std::process::id())));
        std::fs::create_dir(&repo.0).unwrap();
        if initialized {
            repo.git(&["init", "--initial-branch=main"]);
            repo.git(&["config", "user.name", "Fixture"]);
            repo.git(&["config", "user.email", "fixture@example.invalid"]);
            repo.git(&["config", "core.hooksPath", "/dev/null"]);
            repo.git(&["config", "commit.gpgSign", "false"]);
        }
        repo
    }
    fn path(&self) -> &str { self.0.to_str().unwrap() }
    fn git(&self, args: &[&str]) -> String { run_git(self.path(), args).unwrap() }
    fn git_at(&self, args: &[&str], committed_at: i64, authored_at: i64) {
        let output = git_auth_command(self.path(), args, None)
            .env("GIT_AUTHOR_DATE", format!("{authored_at} +0000"))
            .env("GIT_COMMITTER_DATE", format!("{committed_at} +0000"))
            .output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
    fn commit(&self, message: &str, timestamp: i64) -> String {
        self.git_at(&["commit", "--allow-empty", "-m", message], timestamp, timestamp + 1000);
        self.git(&["rev-parse", "HEAD"]).trim().to_string()
    }
    fn activity(&self, from: i64, to: i64) -> ProjectActivitySummary {
        project_activity_inner(self.path(), from, to).unwrap()
    }
}
impl Drop for Repo { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

#[test]
fn activity_uses_committer_dates_and_exact_bounds_across_out_of_order_history() {
    let repo = Repo::new(true);
    let newer_ancestor = repo.commit("newer ancestor", FROM + 20);
    repo.git(&["config", "user.email", "other-author@example.invalid"]);
    let old_middle = repo.commit("old middle", FROM - 20);
    let at_start = repo.commit("inclusive start", FROM);
    let at_end = repo.commit("exclusive end", FROM + 40);
    let after_end = repo.commit("after end", FROM + 50);

    let result = repo.activity(FROM, FROM + 40);
    let dates: std::collections::HashMap<_, _> = result.commits.iter()
        .map(|commit| (commit.oid.as_str(), commit.committed_at)).collect();
    assert_eq!(dates.len(), 2);
    assert_eq!(dates.get(newer_ancestor.as_str()), Some(&(FROM + 20)));
    assert_eq!(dates.get(at_start.as_str()), Some(&FROM));
    for excluded in [old_middle, at_end, after_end] { assert!(!dates.contains_key(excluded.as_str())); }
    assert!(result.checked_at > 0);
    // The UNIX epoch is a valid range start even though Git mishandles --since=@0.
    assert_eq!(repo.activity(0, FROM + 40).commits.len(), 3);
    let serialized = serde_json::to_value(result).unwrap();
    assert!(serialized["checkedAt"].is_number());
    assert!(serialized["commits"][0]["committedAt"].is_number());
}

#[test]
fn activity_covers_local_remote_tag_and_detached_refs_without_stashes_or_duplicates() {
    let repo = Repo::new(true);
    let base = repo.commit("base", FROM);
    repo.git(&["checkout", "-b", "feature"]);
    let branch = repo.commit("branch only", FROM + 1);
    repo.git(&["checkout", "-b", "remote-side", &base]);
    let remote = repo.commit("remote only", FROM + 2);
    repo.git(&["update-ref", "refs/remotes/origin/main", &remote]);
    repo.git(&["checkout", "-b", "tag-side", &base]);
    let tagged = repo.commit("tag only", FROM + 3);
    repo.git(&["-c", "tag.gpgSign=false", "tag", "-a", "release", "-m", "release"]);
    repo.git(&["checkout", "--detach", &base]);
    repo.git(&["branch", "-D", "remote-side", "tag-side"]);
    let detached = repo.commit("detached only", FROM + 4);
    repo.git(&["tag", "duplicate", &branch]);
    repo.git(&["update-ref", "refs/tags/HEAD", &branch]);
    std::fs::write(repo.0.join("untracked.txt"), "stash work\n").unwrap();
    let blob = repo.git(&["hash-object", "-w", "untracked.txt"]);
    repo.git(&["tag", "blob-tag", blob.trim()]);
    repo.git_at(&["stash", "push", "-u", "-m", "excluded stash"], FROM + 5, FROM + 5);
    let stash_only: HashSet<String> = repo.git(&["rev-list", "refs/stash", "--not", "HEAD"])
        .lines().map(str::to_string).collect();
    assert!(!stash_only.is_empty());
    let refs = repo.git(&["show-ref"]);
    let index = std::fs::read(repo.0.join(".git/index")).unwrap();
    std::fs::write(repo.0.join(".git/FETCH_HEAD"), "previous fetch\n").unwrap();

    let result = repo.activity(FROM, FROM + 100);
    let actual: HashSet<_> = result.commits.iter().map(|commit| commit.oid.clone()).collect();
    assert_eq!(result.commits.len(), 5);
    assert_eq!(actual, HashSet::from([base, branch, remote, tagged, detached]));
    assert!(actual.is_disjoint(&stash_only));
    assert!(actual.iter().all(|oid| oid.len() == 40));
    assert_eq!(repo.git(&["show-ref"]), refs);
    assert_eq!(std::fs::read(repo.0.join(".git/index")).unwrap(), index);
    assert_eq!(std::fs::read_to_string(repo.0.join(".git/FETCH_HEAD")).unwrap(), "previous fetch\n");
}

#[test]
fn activity_is_not_limited_to_the_history_graphs_400_commits() {
    let repo = Repo::new(true);
    let mut stream = String::new();
    for index in 0..405 {
        let message = format!("commit {index}");
        stream.push_str(&format!("commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> {} +0000\ndata {}\n{}\n\n", FROM + index, message.len(), message));
    }
    let mut child = git_auth_command(repo.path(), &["fast-import", "--quiet"], None)
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(stream.as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(repo.activity(FROM, FROM + 1000).commits.len(), 405);
}

#[test]
fn activity_handles_plain_and_unborn_projects_and_rejects_corrupt_repositories() {
    let plain = Repo::new(false);
    assert!(plain.activity(FROM, FROM + 100).commits.is_empty());
    assert!(!plain.0.join(".git").exists());
    assert!(project_activity_inner(plain.0.join("missing").to_str().unwrap(), FROM, FROM + 100).is_err());
    std::fs::write(plain.0.join(".git"), "gitdir: /nonexistent/gitkit-activity-metadata\n").unwrap();
    assert!(project_activity_inner(plain.path(), FROM, FROM + 100).is_err());
    let unborn = Repo::new(true);
    assert!(unborn.activity(FROM, FROM + 100).commits.is_empty());
    assert!(project_activity_inner(unborn.path(), FROM, FROM).is_err());
    assert!(project_activity_inner(unborn.path(), FROM + 100, FROM).is_err());

    let broken = Repo::new(true);
    broken.commit("base", FROM);
    std::fs::write(broken.0.join(".git/refs/heads/broken"), "malformed ref\n").unwrap();
    assert!(project_activity_inner(broken.path(), FROM, FROM + 100).is_err());
    std::fs::write(broken.0.join(".git/refs/heads/broken"), format!("{}\n", "a".repeat(40))).unwrap();
    assert!(project_activity_inner(broken.path(), FROM, FROM + 100).is_err());
    std::fs::remove_file(broken.0.join(".git/refs/heads/broken")).unwrap();
    broken.git(&["checkout", "--detach"]);
    std::fs::write(broken.0.join(".git/HEAD"), format!("{}\n", "a".repeat(40))).unwrap();
    assert!(project_activity_inner(broken.path(), FROM, FROM + 100).is_err());
}

#[test]
fn parser_accepts_full_sha256_and_fallback_only_matches_unsupported_filter_errors() {
    let oid = "a".repeat(64);
    let result = parse_activity(&format!("{oid}\t{FROM}\n{oid}\t{FROM}\n"), FROM, FROM + 1).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].oid, oid);
    for invalid in ["short\t1700000000", "not-a-record", "a\tinvalid-time"] {
        assert!(parse_activity(invalid, FROM, FROM + 100).is_err());
    }
    assert!(unsupported_since_filter("fatal: unrecognized argument: --since-as-filter=2023-11-14T22:13:20+00:00"));
    assert!(unsupported_since_filter("error: unknown option 'since-as-filter'"));
    for error in ["fatal: bad object HEAD", "warning: ignoring broken ref refs/heads/example", "fatal: unknown option 'other'"] {
        assert!(!unsupported_since_filter(error));
    }
}
