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
    fn commit_as(&self, message: &str, timestamp: i64, author: (&str, &str), committer: (&str, &str)) -> String {
        let output = git_auth_command(self.path(), &["commit", "--allow-empty", "-m", message], None)
            .env("GIT_AUTHOR_DATE", format!("{timestamp} +0000"))
            .env("GIT_COMMITTER_DATE", format!("{timestamp} +0000"))
            .env("GIT_AUTHOR_NAME", author.0).env("GIT_AUTHOR_EMAIL", author.1)
            .env("GIT_COMMITTER_NAME", committer.0).env("GIT_COMMITTER_EMAIL", committer.1)
            .output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        self.git(&["rev-parse", "HEAD"]).trim().to_string()
    }
    fn activity(&self, from: i64, to: i64) -> ProjectActivitySummary {
        self.activity_for(from, to, &["fixture@example.invalid"])
    }
    fn activity_for(&self, from: i64, to: i64, author_emails: &[&str]) -> ProjectActivitySummary {
        let author_emails: Vec<_> = author_emails.iter().map(|email| email.to_string()).collect();
        project_activity_inner(self.path(), from, to, &author_emails).unwrap()
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

    let emails = ["fixture@example.invalid", "other-author@example.invalid"];
    let result = repo.activity_for(FROM, FROM + 40, &emails);
    let dates: std::collections::HashMap<_, _> = result.commits.iter()
        .map(|commit| (commit.oid.as_str(), commit.committed_at)).collect();
    assert_eq!(dates.len(), 2);
    assert_eq!(dates.get(newer_ancestor.as_str()), Some(&(FROM + 20)));
    assert_eq!(dates.get(at_start.as_str()), Some(&FROM));
    for excluded in [old_middle, at_end, after_end] { assert!(!dates.contains_key(excluded.as_str())); }
    assert!(result.checked_at > 0);
    // The UNIX epoch is a valid range start even though Git mishandles --since=@0.
    assert_eq!(repo.activity_for(0, FROM + 40, &emails).commits.len(), 3);
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
fn activity_matches_all_configured_author_emails_without_counting_other_authors_or_committers() {
    let repo = Repo::new(true);
    let first_identity = ("Original Name", "first@example.invalid");
    let second_identity = ("Second Name", "second@example.invalid");
    let first = repo.commit_as("first identity", FROM, first_identity, first_identity);
    let second = repo.commit_as("second identity", FROM + 1, second_identity, second_identity);
    let renamed = repo.commit_as("renamed author", FROM + 2, ("New Name", "FIRST@EXAMPLE.INVALID"), first_identity);
    let same_name = repo.commit_as("same name, other email", FROM + 3,
        ("Original Name", "unconfigured@example.invalid"), ("Other", "other@example.invalid"));
    let recommitted = repo.commit_as("other author committed by me", FROM + 4,
        ("Other", "other@example.invalid"), first_identity);
    let authored_only = repo.commit_as("my author, other committer", FROM + 5,
        first_identity, ("Other", "other@example.invalid"));

    let result = repo.activity_for(FROM, FROM + 100,
        &[" first@example.invalid ", "SECOND@EXAMPLE.INVALID", "first@example.invalid", " "]);
    let actual: HashSet<_> = result.commits.iter().map(|commit| commit.oid.clone()).collect();
    assert_eq!(result.commits.len(), 4);
    assert_eq!(actual, HashSet::from([first, second, renamed, authored_only]));
    assert!(!actual.contains(&same_name));
    assert!(!actual.contains(&recommitted));
    assert!(repo.activity_for(FROM, FROM + 100, &[]).commits.is_empty());
    assert!(repo.activity_for(FROM, FROM + 100, &["", " \t "]).commits.is_empty());
}

#[test]
fn activity_uses_original_author_emails_without_mailmap_aliases_or_pattern_matching() {
    let repo = Repo::new(true);
    let canonical = ("Canonical Name", "canonical@example.invalid");
    let canonical_commit = repo.commit_as("canonical email", FROM, canonical, canonical);
    let alias = repo.commit_as("mailmap alias", FROM + 1,
        ("Old Name", "alias@example.invalid"), canonical);
    std::fs::write(repo.0.join(".mailmap"), "Canonical Name <canonical@example.invalid> Old Name <alias@example.invalid>\n").unwrap();
    repo.git(&["config", "log.mailmap", "true"]);
    let literal = "literal+[own].(x)@example.invalid";
    let special = repo.commit_as("literal special email", FROM + 2, ("Special", literal), canonical);
    let substring = repo.commit_as("email substring", FROM + 3,
        ("Canonical Name", "prefixcanonical@example.invalid"), canonical);
    let pattern_like = repo.commit_as("similar special email", FROM + 4,
        ("Special", "literalownx@exampleXinvalid"), canonical);

    let canonical_result = repo.activity_for(FROM, FROM + 100, &[canonical.1]);
    assert_eq!(canonical_result.commits.len(), 1);
    assert_eq!(canonical_result.commits[0].oid, canonical_commit);
    assert_eq!(repo.activity_for(FROM, FROM + 100, &["alias@example.invalid"]).commits[0].oid, alias);
    let special_result = repo.activity_for(FROM, FROM + 100, &[literal]);
    assert_eq!(special_result.commits.len(), 1);
    assert_eq!(special_result.commits[0].oid, special);
    assert!(!canonical_result.commits.iter().any(|commit| commit.oid == substring));
    assert!(!special_result.commits.iter().any(|commit| commit.oid == pattern_like));
}

#[test]
fn activity_handles_plain_and_unborn_projects_and_rejects_corrupt_repositories() {
    let plain = Repo::new(false);
    assert!(plain.activity(FROM, FROM + 100).commits.is_empty());
    assert!(!plain.0.join(".git").exists());
    assert!(project_activity_inner(plain.0.join("missing").to_str().unwrap(), FROM, FROM + 100, &[]).is_err());
    std::fs::write(plain.0.join(".git"), "gitdir: /nonexistent/gitkit-activity-metadata\n").unwrap();
    assert!(project_activity_inner(plain.path(), FROM, FROM + 100, &[]).is_err());
    let unborn = Repo::new(true);
    assert!(unborn.activity(FROM, FROM + 100).commits.is_empty());
    assert!(project_activity_inner(unborn.path(), FROM, FROM, &[]).is_err());
    assert!(project_activity_inner(unborn.path(), FROM + 100, FROM, &[]).is_err());

    let broken = Repo::new(true);
    broken.commit("base", FROM);
    std::fs::write(broken.0.join(".git/refs/heads/broken"), "malformed ref\n").unwrap();
    let emails = ["fixture@example.invalid".to_string()];
    assert!(project_activity_inner(broken.path(), FROM, FROM + 100, &emails).is_err());
    std::fs::write(broken.0.join(".git/refs/heads/broken"), format!("{}\n", "a".repeat(40))).unwrap();
    assert!(project_activity_inner(broken.path(), FROM, FROM + 100, &emails).is_err());
    std::fs::remove_file(broken.0.join(".git/refs/heads/broken")).unwrap();
    broken.git(&["checkout", "--detach"]);
    std::fs::write(broken.0.join(".git/HEAD"), format!("{}\n", "a".repeat(40))).unwrap();
    assert!(project_activity_inner(broken.path(), FROM, FROM + 100, &emails).is_err());
    assert!(project_activity_inner(broken.path(), FROM, FROM + 100, &[]).is_err());
}

#[test]
fn parser_accepts_full_sha256_and_fallback_only_matches_unsupported_filter_errors() {
    let oid = "a".repeat(64);
    let emails = HashSet::from(["fixture@example.invalid".to_string()]);
    let record = format!("{oid}\0{FROM}\0fixture@example.invalid\0");
    let result = parse_activity(&record.repeat(2), FROM, FROM + 1, &emails).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].oid, oid);
    for invalid in [format!("short\0{FROM}\0fixture@example.invalid\0"), "not-a-record".into(),
        format!("{oid}\0invalid-time\0fixture@example.invalid\0"), format!("{oid}\0{FROM}\0")] {
        assert!(parse_activity(&invalid, FROM, FROM + 100, &emails).is_err());
    }
    assert!(unsupported_since_filter("fatal: unrecognized argument: --since-as-filter=2023-11-14T22:13:20+00:00"));
    assert!(unsupported_since_filter("error: unknown option 'since-as-filter'"));
    for error in ["fatal: bad object HEAD", "warning: ignoring broken ref refs/heads/example", "fatal: unknown option 'other'"] {
        assert!(!unsupported_since_filter(error));
    }
}
