use super::{git_file_content, run_blocking, run_git};
use serde::Serialize;
use std::path::{Component, Path};

const PAGE_SIZE: usize = 60;
const BLAME_LIMIT: usize = 2000;
const MARKER: &str = "GITKIT_FILE_TRACE";
const FORMAT: &str = "%x00GITKIT_FILE_TRACE%x00%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b%x00";

#[derive(Clone, Serialize, Default)]
pub struct FileHistoryEntry {
    pub hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_date: String,
    pub subject: String,
    pub body: String,
    pub file: String,
    pub old_file: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Serialize)]
pub struct FileHistoryPage {
    pub revision: String,
    pub file: String,
    pub entries: Vec<FileHistoryEntry>,
    pub next_offset: Option<usize>,
}

#[derive(Default)]
struct Change {
    file: String,
    old_file: Option<String>,
    status: String,
    additions: u32,
    deletions: u32,
    binary: bool,
}

fn validate_hash(hash: &str) -> Result<(), String> {
    if !matches!(hash.len(), 40 | 64) || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("无效的提交哈希".into());
    }
    Ok(())
}

fn validate_file(file: &str) -> Result<(), String> {
    let path = Path::new(file);
    if file.is_empty() || file.contains('\0') || path.is_absolute()
        || path.components().any(|p| matches!(p, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err("无效的文件路径".into());
    }
    Ok(())
}

/// Both streams are NUL-delimited. Consume paths before interpreting the next
/// token, so tabs, newlines, quotes and even the marker in a filename stay data.
fn parse_changes<'a>(fields: &mut std::iter::Peekable<impl Iterator<Item = &'a str>>) -> Vec<Change> {
    let mut changes = Vec::<Change>::new();
    while let Some(&field) = fields.peek() {
        let header = field.trim_start_matches('\n');
        if header == MARKER { break; }
        fields.next();
        if header.starts_with(':') {
            let status = header.split_whitespace().last().unwrap_or("M").chars().next().unwrap_or('M');
            let first = fields.next().unwrap_or("").to_string();
            let (file, old_file) = if matches!(status, 'R' | 'C') {
                (fields.next().unwrap_or("").to_string(), Some(first))
            } else { (first, None) };
            changes.push(Change { file, old_file, status: status.to_string(), ..Default::default() });
        } else {
            let cols: Vec<_> = header.splitn(3, '\t').collect();
            if cols.len() != 3 { continue; }
            let file = if cols[2].is_empty() {
                fields.next();
                fields.next().unwrap_or("")
            } else { cols[2] };
            if let Some(change) = changes.iter_mut().find(|c| c.file == file) {
                change.additions = cols[0].parse().unwrap_or(0);
                change.deletions = cols[1].parse().unwrap_or(0);
                change.binary = cols[0] == "-" || cols[1] == "-";
            }
        }
    }
    changes
}

fn apply_change(entry: &mut FileHistoryEntry, change: Change) {
    entry.file = change.file;
    entry.old_file = change.old_file;
    entry.status = change.status;
    entry.additions = change.additions;
    entry.deletions = change.deletions;
    entry.binary = change.binary;
}

fn parse_history(out: &str) -> Result<Vec<(FileHistoryEntry, bool)>, String> {
    let mut fields = out.split('\0').peekable();
    let mut entries = Vec::new();
    while let Some(field) = fields.next() {
        if field.trim_start_matches('\n') != MARKER { continue; }
        let mut next = || fields.next().ok_or_else(|| "无法解析文件历史".to_string());
        let mut entry = FileHistoryEntry {
            hash: next()?.into(), parents: next()?.split_whitespace().map(str::to_string).collect(),
            author_name: next()?.into(), author_email: next()?.into(), author_date: next()?.into(),
            committer_name: next()?.into(), committer_email: next()?.into(), committer_date: next()?.into(),
            subject: next()?.into(), body: next()?.trim_end_matches('\n').into(), ..Default::default()
        };
        validate_hash(&entry.hash)?;
        let changes = parse_changes(&mut fields);
        let changed = !changes.is_empty();
        if let Some(change) = changes.into_iter().next() { apply_change(&mut entry, change); }
        entries.push((entry, changed));
    }
    Ok(entries)
}

fn read_history(path: &str, anchor: &str, file: &str, branch: Option<&str>, offset: usize) -> Result<FileHistoryPage, String> {
    validate_hash(anchor)?;
    validate_file(file)?;
    let mut revision = anchor.to_string();
    let mut history_file = file.to_string();
    if let Some(branch) = branch {
        let reference = if branch == "HEAD" { "HEAD".to_string() } else {
            let reference = format!("refs/heads/{branch}");
            run_git(path, &["check-ref-format", &reference])?;
            reference
        };
        revision = run_git(path, &["rev-parse", "--verify", "--end-of-options", &format!("{reference}^{{commit}}")])?.trim().to_string();
        validate_hash(&revision)?;
        // Follow renames made after the anchor when switching to branch latest.
        let out = run_git(path, &["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--raw", "--numstat", "-z", "-M", anchor, &revision, "--"])?;
        if let Some(change) = parse_changes(&mut out.split('\0').peekable()).into_iter().find(|c| c.old_file.as_deref() == Some(file)) {
            history_file = change.file;
        }
    }
    // --skip prevents Git from processing skipped rename diffs. Walk from the
    // pinned tip on each page and slice afterwards, retaining the old path chain.
    let count = offset.checked_add(PAGE_SIZE + 1).ok_or("无法解析文件历史")?;
    let out = run_git(path, &["--literal-pathspecs", "log", "--follow", "--full-history", "--date-order",
        "--diff-merges=first-parent", "--no-decorate", "--no-color", "--no-notes", "--no-show-signature",
        "--no-ext-diff", "--no-textconv", &format!("--format={FORMAT}"), "--raw", "--numstat", "-z", "-M",
        &format!("--max-count={count}"), &revision, "--", &history_file])?;
    let records = parse_history(&out)?;
    let next_offset = (records.len() > offset + PAGE_SIZE).then_some(offset + PAGE_SIZE);
    let entries = records.into_iter().skip(offset).take(PAGE_SIZE).filter_map(|(entry, changed)| changed.then_some(entry)).collect();
    Ok(FileHistoryPage { revision, file: history_file, entries, next_offset })
}

#[tauri::command]
pub async fn file_history(path: String, anchor: String, file: String, branch: Option<String>, offset: usize) -> Result<FileHistoryPage, String> {
    run_blocking(move || read_history(&path, &anchor, &file, branch.as_deref(), offset)).await
}

#[derive(Serialize)]
pub struct FileTraceDiff {
    pub commit: FileHistoryEntry,
    pub diff: String,
    pub parent: Option<String>,
}

fn read_trace_diff(path: &str, hash: &str, file: &str, parent_index: usize) -> Result<FileTraceDiff, String> {
    validate_hash(hash)?;
    validate_file(file)?;
    let metadata = run_git(path, &["show", "--no-show-signature", "-s", &format!("--format={FORMAT}"), hash, "--"])?;
    let mut entry = parse_history(&metadata)?.into_iter().next().ok_or("无法解析文件历史")?.0;
    if parent_index >= entry.parents.len().max(1) { return Err("无效的父提交".into()); }
    let parent = entry.parents.get(parent_index).cloned();
    let mut args = vec!["--literal-pathspecs", if parent.is_some() { "diff" } else { "show" },
        "--no-ext-diff", "--no-textconv", "--no-color", "-M"];
    if let Some(parent) = &parent { args.push(parent); } else { args.extend(["--format=", "--root", "--no-show-signature"]); }
    args.push(hash);
    let mut stat_args = args.clone(); stat_args.extend(["--raw", "--numstat", "-z", "--"]);
    let out = run_git(path, &stat_args)?;
    let change = parse_changes(&mut out.split('\0').peekable()).into_iter().find(|c| c.file == file);
    if let Some(change) = change { apply_change(&mut entry, change); }
    else { entry.file = file.into(); entry.status = "M".into(); }
    args.extend(["--patch", "--", &entry.file]);
    if let Some(old_file) = &entry.old_file { args.push(old_file); }
    let diff = run_git(path, &args)?;
    Ok(FileTraceDiff { commit: entry, diff, parent })
}

#[tauri::command]
pub async fn file_trace_diff(path: String, hash: String, file: String, parent_index: usize) -> Result<FileTraceDiff, String> {
    run_blocking(move || read_trace_diff(&path, &hash, &file, parent_index)).await
}

#[derive(Serialize, Default)]
pub struct BlameLine {
    pub hash: String,
    pub file: String,
    pub line: usize,
    pub original_line: usize,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub summary: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct FileBlame {
    pub kind: String,
    pub lines: Vec<BlameLine>,
    pub truncated: bool,
}

fn unquote_path(value: &str) -> String {
    if !value.starts_with('"') || !value.ends_with('"') { return value.into(); }
    let mut bytes = value.as_bytes()[1..value.len()-1].iter().copied().peekable();
    let mut decoded = Vec::new();
    while let Some(byte) = bytes.next() {
        if byte != b'\\' { decoded.push(byte); continue; }
        match bytes.next() {
            Some(b'n') => decoded.push(b'\n'), Some(b't') => decoded.push(b'\t'), Some(b'r') => decoded.push(b'\r'),
            Some(b'a') => decoded.push(7), Some(b'b') => decoded.push(8), Some(b'f') => decoded.push(12), Some(b'v') => decoded.push(11),
            Some(octal @ b'0'..=b'7') => {
                let mut value = (octal - b'0') as u16;
                for _ in 0..2 { if let Some(digit @ b'0'..=b'7') = bytes.peek().copied() { bytes.next(); value = value * 8 + (digit-b'0') as u16; } else { break; } }
                decoded.push(value as u8);
            },
            Some(other) => decoded.push(other), None => decoded.push(b'\\'),
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn parse_blame(out: &str) -> Result<Vec<BlameLine>, String> {
    let mut rows = Vec::new();
    let mut current = BlameLine::default();
    for line in out.lines() {
        if let Some(content) = line.strip_prefix('\t') {
            if current.hash.is_empty() || current.file.is_empty() { return Err("无法解析逐行归属".into()); }
            current.content = content.into(); rows.push(std::mem::take(&mut current)); continue;
        }
        if let Some(value) = line.strip_prefix("author ") { current.author_name = value.into(); }
        else if let Some(value) = line.strip_prefix("author-mail ") { current.author_email = value.trim_start_matches('<').trim_end_matches('>').into(); }
        else if let Some(value) = line.strip_prefix("author-time ") {
            current.author_date = value.parse::<i64>().ok().and_then(|n| chrono::DateTime::from_timestamp(n,0)).map(|d| d.to_rfc3339()).unwrap_or_default();
        }
        else if let Some(value) = line.strip_prefix("summary ") { current.summary = value.into(); }
        else if let Some(value) = line.strip_prefix("filename ") { current.file = unquote_path(value); }
        else {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() >= 3 && validate_hash(fields[0]).is_ok() {
                current.hash = fields[0].into();
                current.original_line = fields[1].parse().map_err(|_| "无法解析逐行归属")?;
                current.line = fields[2].parse().map_err(|_| "无法解析逐行归属")?;
            }
        }
    }
    Ok(rows)
}

#[tauri::command]
pub async fn file_blame(path: String, hash: String, file: String) -> Result<FileBlame, String> {
    validate_hash(&hash)?; validate_file(&file)?;
    let content = git_file_content(path.clone(), file.clone(), Some(hash.clone()), None, false).await?;
    if content.kind != "text" { return Ok(FileBlame { kind: content.kind, lines: vec![], truncated: false }); }
    run_blocking(move || {
        let end = content.lines.min(BLAME_LIMIT);
        let out = run_git(&path, &["--literal-pathspecs", "-c", "core.quotePath=false", "-c", "blame.ignoreRevsFile=",
            "blame", "--line-porcelain", "--encoding=UTF-8", "-L", &format!("1,{end}"), &hash, "--", &file])?;
        Ok(FileBlame { kind: "text".into(), lines: parse_blame(&out)?, truncated: content.lines > BLAME_LIMIT })
    }).await
}

#[cfg(test)]
#[path = "file_trace/file_trace_tests.rs"]
mod tests;
