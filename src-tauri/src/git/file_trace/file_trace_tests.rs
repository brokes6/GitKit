use super::*;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct Repo(PathBuf);
impl Repo {
    fn new() -> Self {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("gitkit-file-trace-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let repo = Self(root);
        repo.git(&["init", "--initial-branch=main"]);
        repo.git(&["config", "user.name", "Committer"]);
        repo.git(&["config", "user.email", "committer@example.invalid"]);
        repo.git(&["config", "core.hooksPath", "/dev/null"]);
        repo.git(&["config", "commit.gpgSign", "false"]);
        repo
    }
    fn path(&self) -> &str { self.0.to_str().unwrap() }
    fn git(&self, args: &[&str]) -> String { run_git(self.path(), args).unwrap().trim().into() }
    fn write(&self, file: &str, content: &str) { std::fs::write(self.0.join(file), content).unwrap(); }
    fn commit(&self, subject: &str) -> String {
        self.git(&["add", "--all"]); self.git(&["commit", "-m", subject]); self.git(&["rev-parse", "HEAD"])
    }
}
impl Drop for Repo { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

#[test]
fn history_respects_anchor_and_literal_paths_and_keeps_both_identities() {
    let repo = Repo::new();
    let file = "城市 [1]\".txt";
    repo.write(file, "first\n"); repo.git(&["add", "--all"]);
    let output = super::super::git_auth_command(repo.path(), &["commit", "-m", "authored change"], None)
        .env("GIT_AUTHOR_NAME", "Author").env("GIT_AUTHOR_EMAIL", "author@example.invalid")
        .env("GIT_AUTHOR_DATE", "2020-01-02T03:04:05+08:00").env("GIT_COMMITTER_DATE", "2020-02-03T04:05:06+08:00")
        .output().unwrap();
    assert!(output.status.success());
    let anchor = repo.git(&["rev-parse", "HEAD"]);
    repo.write("城市 1\".txt", "other\n"); repo.commit("other path");
    repo.write(file, "first\nsecond\n"); let latest = repo.commit("later change");
    let history = read_history(repo.path(), &anchor, file, None, 0).unwrap();
    assert_eq!(history.entries.len(), 1);
    let entry = &history.entries[0];
    assert_eq!(entry.hash, anchor); assert_eq!(entry.status, "A"); assert_eq!(entry.additions, 1);
    assert_eq!(entry.author_name, "Author"); assert_eq!(entry.committer_name, "Committer");
    assert_ne!(entry.author_date, entry.committer_date);
    let page = read_history(repo.path(), &anchor, file, Some("main"), 0).unwrap();
    assert_eq!(page.revision, latest); assert_eq!(page.entries.len(), 2);
    assert!(!page.entries.iter().any(|entry| entry.subject == "other path"));
    let original = read_trace_diff(repo.path(), &anchor, file, 0).unwrap();
    assert!(original.diff.contains("+first")); assert!(original.parent.is_none());
    assert!(read_trace_diff(repo.path(), &anchor, "../outside", 0).is_err());
    assert!(read_history(repo.path(), "--all", file, None, 0).is_err());
}

#[test]
fn paging_walks_renames_and_pins_branch_tip() {
    let repo = Repo::new();
    let old = "old [中文].txt"; let new = "new [中文].txt";
    repo.write(old, "one\ntwo\nthree\nfour\n"); let first = repo.commit("create");
    for n in 0..65 { repo.write(old, &format!("one\ntwo\nthree\nfour\n{n}\n")); repo.commit(&format!("edit {n}")); }
    let anchor = repo.git(&["rev-parse", "HEAD"]);
    repo.git(&["mv", old, new]); let renamed = repo.commit("rename");
    let page = read_history(repo.path(), &anchor, old, Some("main"), 0).unwrap();
    assert_eq!(page.revision, renamed); assert_eq!(page.file, new);
    assert_eq!(page.entries.len(), PAGE_SIZE); assert_eq!(page.next_offset, Some(PAGE_SIZE));
    assert_eq!(page.entries[0].old_file.as_deref(), Some(old));
    let tail = read_history(repo.path(), &page.revision, &page.file, None, page.next_offset.unwrap()).unwrap();
    assert!(tail.entries.iter().any(|entry| entry.hash == first && entry.file == old));
    assert_eq!(tail.next_offset, None);
    let diff = read_trace_diff(repo.path(), &renamed, new, 0).unwrap();
    assert_eq!(diff.commit.status, "R"); assert_eq!(diff.commit.old_file.as_deref(), Some(old));
    assert!(diff.diff.contains("rename from")); assert!(!diff.diff.contains("@@"));
    repo.write(new, "after pagination\n"); repo.commit("new tip");
    let pinned = read_history(repo.path(), &page.revision, &page.file, None, PAGE_SIZE).unwrap();
    assert_eq!(pinned.entries[0].hash, tail.entries[0].hash);
}

#[test]
fn merge_history_keeps_source_commits_and_comparison_parent_is_explicit() {
    let repo = Repo::new();
    repo.write("tracked.txt", "base\n"); repo.commit("base");
    repo.git(&["checkout", "-b", "feature"]);
    repo.write("tracked.txt", "base\nfeature\n"); let source = repo.commit("source author change");
    repo.git(&["checkout", "main"]); repo.write("other.txt", "main\n"); repo.commit("main unrelated change");
    repo.git(&["merge", "--no-ff", "feature", "-m", "integrate feature"]);
    let merge = repo.git(&["rev-parse", "HEAD"]);
    let history = read_history(repo.path(), &merge, "tracked.txt", None, 0).unwrap();
    assert!(history.entries.iter().any(|entry| entry.hash == source));
    let first = read_trace_diff(repo.path(), &merge, "tracked.txt", 0).unwrap();
    assert_eq!(first.commit.parents.len(), 2); assert_eq!(first.commit.additions, 1);
    assert!(first.diff.contains("+feature"));
    let second = read_trace_diff(repo.path(), &merge, "tracked.txt", 1).unwrap();
    assert!(second.diff.is_empty()); assert_eq!(second.commit.additions, 0);
    assert_ne!(first.parent, second.parent);
    assert!(read_trace_diff(repo.path(), &merge, "tracked.txt", 2).is_err());
}

#[test]
fn blame_reads_the_selected_snapshot_and_handles_missing_binary_and_empty_files() {
    let repo = Repo::new(); let file = "quote \"中文\".txt";
    repo.write(file, "original\n"); let first = repo.commit("first author");
    repo.write(file, "original\nlater\n"); let latest = repo.commit("second author");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let blame = runtime.block_on(file_blame(repo.path().into(), latest.clone(), file.into())).unwrap();
    assert_eq!(blame.lines.len(), 2); assert_eq!(blame.lines[0].hash, first); assert_eq!(blame.lines[1].hash, latest);
    assert_eq!(blame.lines[0].file, file); assert_eq!(blame.lines[0].line, 1);
    repo.git(&["rm", "--", file]); let deletion = repo.commit("delete");
    assert_eq!(runtime.block_on(file_blame(repo.path().into(), deletion.clone(), file.into())).unwrap().kind, "missing");
    assert!(read_trace_diff(repo.path(), &deletion, file, 0).unwrap().diff.contains("-original"));
    std::fs::write(repo.0.join("binary.bin"), [0,1,2,3]).unwrap(); repo.write("empty.txt", "");
    let hash = repo.commit("binary and empty");
    assert_eq!(runtime.block_on(file_blame(repo.path().into(), hash.clone(), "binary.bin".into())).unwrap().kind, "binary");
    assert_eq!(runtime.block_on(file_blame(repo.path().into(), hash, "empty.txt".into())).unwrap().kind, "empty");
}
