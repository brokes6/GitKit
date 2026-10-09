//! One native MR inbox scheduler. It never fetches or changes the local repository.
pub mod api;

use api::{ActionResult, ApiError, Detail, DiffCommentResult, DiffVersion, Discussion, MergeResult, Summary, User};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{Mutex as AsyncMutex, Notify};

const EVENT: &str = "merge-request-state";
const COOLDOWN: i64 = 15_000;
const BACKGROUND: i64 = 300_000;
const MAX_BACKOFF: i64 = 900_000;
const MAX_ACCOUNTS: usize = 16;
const MAX_ROWS: usize = 5_000;
const MAX_DETAILS: usize = 8;
const MAX_DIFFS: usize = 4;
const MAX_DIFF_BYTES: usize = 24 * 1024 * 1024;
const MAX_SEEN_ACCOUNTS: usize = 64;
const CACHE_BUDGET: usize = 64 * 1024 * 1024;
const SUMMARY_BUDGET: usize = 16 * 1024 * 1024;
const DETAIL_BUDGET: usize = 40 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    account_key: String,
    url: String,
    token: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Visibility {
    list_open: bool,
    detail_id: Option<u64>,
    online: bool,
}

#[derive(Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    epoch: u64,
    context_key: Option<String>,
    instance_url: Option<String>,
    user: Option<User>,
    items: Vec<Summary>,
    total: usize,
    new_count: usize,
    unseen_ids: Vec<u64>,
    last_checked_at: Option<i64>,
    refreshing: bool,
    stale: bool,
    error: Option<ApiError>,
    persistence_error: Option<String>,
    selected_detail: Option<Detail>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedDiff {
    file_name: String,
    version_id: u64,
    refs: api::DiffRefs,
}

#[derive(Clone)]
struct Active {
    config: api::Config,
    account_key: String,
    key: String,
    instance: String,
    fingerprint: String,
    identity_verified: bool,
}

#[derive(Clone)]
struct Cached<T> {
    value: T,
    at: i64,
}

#[derive(Default)]
struct Cache {
    fingerprint: String,
    user: Option<User>,
    items: Vec<Summary>,
    seen_key: Option<String>,
    checked_at: Option<i64>,
    used_at: i64,
    error: Option<ApiError>,
    stale: bool,
    details: HashMap<u64, Cached<Detail>>,
    diffs: HashMap<(u64, u64), Cached<DiffVersion>>,
    discussions: HashMap<u64, Cached<Vec<Discussion>>>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct SeenEntry {
    initialized: bool,
    viewed: HashSet<u64>,
    used_at: i64,
}

#[derive(Default, Deserialize, Serialize)]
struct SeenStore {
    #[serde(default, alias = "projects")]
    accounts: HashMap<String, SeenEntry>,
}

struct Inner {
    epoch: u64,
    revision: u64,
    active: Option<Active>,
    caches: HashMap<String, Cache>,
    seen: SeenStore,
    file: PathBuf,
    persistence_error: Option<String>,
    visibility: Visibility,
    foreground: bool,
    sleeping: bool,
    resume_after: i64,
    retry_after: i64,
    failures: u32,
    detail_failures: u32,
    detail_retry_after: i64,
    stopped: bool,
    account_stops: HashSet<String>,
    next_list: i64,
    next_detail: i64,
    list_running: Option<u64>,
    write_generation: u64,
    data_revision: u64,
    last_emitted: Option<UiStamp>,
}

#[derive(Clone, PartialEq)]
struct UiStamp {
    epoch: u64,
    key: Option<String>,
    instance_url: Option<String>,
    data_revision: u64,
    selected_id: Option<u64>,
    refreshing: bool,
    stale: bool,
    error: Option<ApiError>,
    persistence_error: Option<String>,
}

struct Service {
    inner: Mutex<Inner>,
    changed: Notify,
    list_gate: AsyncMutex<()>,
    detail_gate: AsyncMutex<()>,
    diff_gate: AsyncMutex<()>,
    download_gate: AsyncMutex<()>,
    discussion_gate: AsyncMutex<()>,
    mutation_gate: AsyncMutex<()>,
}

#[derive(Clone)]
pub struct MrState(Arc<Service>);

#[derive(Clone)]
struct Context {
    epoch: u64,
    generation: u64,
    key: String,
    config: api::Config,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Request {
    project_id: u64,
    iid: u64,
}

impl From<&Summary> for Request {
    fn from(summary: &Summary) -> Self {
        Self {
            project_id: summary.project_id,
            iid: summary.iid,
        }
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn error(kind: &str, message: &str) -> ApiError {
    ApiError {
        kind: kind.into(),
        message: message.into(),
        retry_after: None,
    }
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn context_key(account: &str, canonical: &str) -> String {
    digest(&format!("{}:{}:{}", account.len(), account, canonical))
}
fn seen_key(active: &Active, user: u64) -> String {
    digest(&format!(
        "account-inbox-v1:{}:{}",
        context_key(&active.account_key, &active.instance),
        user
    ))
}
fn account_stop_key(active: &Active) -> String {
    digest(&format!(
        "{}:{}:{}",
        active.account_key, active.instance, active.fingerprint
    ))
}

fn reconcile_seen(entry: &mut SeenEntry, current: &HashSet<u64>, at: i64) -> bool {
    let before = entry.viewed.clone();
    let initialized = entry.initialized;
    if !entry.initialized {
        entry.viewed = current.clone();
        entry.initialized = true;
    } else {
        entry.viewed.retain(|mr_id| current.contains(mr_id));
    }
    entry.used_at = at;
    !initialized || before != entry.viewed
}

fn interval(foreground: bool, list: bool, detail: bool, ci_running: bool) -> i64 {
    if !foreground {
        BACKGROUND
    } else if detail && ci_running {
        15_000
    } else if list || detail {
        30_000
    } else {
        60_000
    }
}

fn backoff(failures: u32, retry_after: Option<u64>) -> i64 {
    let exponential = COOLDOWN.saturating_mul(1_i64 << failures.saturating_sub(1).min(6));
    exponential.min(MAX_BACKOFF).max(retry_after.map_or(0, |s| {
        i64::try_from(s)
            .unwrap_or(i64::MAX / 1000)
            .saturating_mul(1000)
    }))
}

fn ci_running(detail: Option<&Detail>) -> bool {
    matches!(
        detail.and_then(|d| d.pipeline_status.as_deref()),
        Some("created" | "waiting_for_resource" | "preparing" | "pending" | "running")
    )
}

fn user_bytes(user: &User) -> usize {
    std::mem::size_of::<User>() + user.name.len() + user.username.len()
}
fn refs_bytes(refs: &api::DiffRefs) -> usize {
    refs.base_sha.len() + refs.start_sha.len() + refs.head_sha.len()
}
fn summary_bytes(row: &Summary) -> usize {
    std::mem::size_of::<Summary>()
        + row.project_path_with_namespace.len()
        + row.title.len()
        + row.state.len()
        + row.description.as_ref().map_or(0, String::len)
        + row.source_branch.len()
        + row.target_branch.len()
        + user_bytes(&row.author)
        + row
            .roles
            .iter()
            .map(|role| std::mem::size_of::<String>() + role.len())
            .sum::<usize>()
        + row.updated_at.len()
        + row.sha.as_ref().map_or(0, String::len)
        + row.detailed_merge_status.as_ref().map_or(0, String::len)
        + row.web_url.len()
        + row.pipeline_status.as_ref().map_or(0, String::len)
}
fn validate_summaries(rows: &[Summary], budget: usize) -> Result<(), ApiError> {
    let mut ids = HashSet::new();
    let mut references = HashSet::new();
    if rows.iter().any(|row| {
        row.id == 0
            || row.project_id == 0
            || row.iid == 0
            || !ids.insert(row.id)
            || !references.insert((row.project_id, row.iid))
    }) {
        Err(error(
            "invalid_response",
            "GitLab 合并请求列表包含无效或重复身份",
        ))
    } else if rows.len() > MAX_ROWS || rows.iter().map(summary_bytes).sum::<usize>() > budget {
        Err(error(
            "invalid_response",
            "完整合并请求摘要超过本地缓存上限，保留上次完整列表，请在 GitLab 查看",
        ))
    } else {
        Ok(())
    }
}
fn detail_bytes(detail: &Detail) -> usize {
    std::mem::size_of::<Detail>()
        + summary_bytes(&detail.summary)
        + detail.description.len()
        + detail.assignees.iter().map(user_bytes).sum::<usize>()
        + detail.reviewers.iter().map(user_bytes).sum::<usize>()
        + detail
            .approvals
            .approved_by
            .iter()
            .map(user_bytes)
            .sum::<usize>()
        + detail
            .blocked_reasons
            .iter()
            .map(|reason| reason.len() + std::mem::size_of::<String>())
            .sum::<usize>()
        + detail.diff_refs.as_ref().map_or(0, refs_bytes)
        + detail
            .diff_versions
            .iter()
            .map(|version| {
                std::mem::size_of::<api::DiffVersionInfo>()
                    + version.created_at.len()
                    + version.state.len()
                    + version.real_size.as_ref().map_or(0, String::len)
                    + refs_bytes(&version.refs)
            })
            .sum::<usize>()
        + detail.squash_policy.len()
        + detail.pipeline_status.as_ref().map_or(0, String::len)
        + detail.merge_commit_message.as_ref().map_or(0, String::len)
        + detail.squash_commit_message.as_ref().map_or(0, String::len)
}
fn diff_bytes(diff: &DiffVersion) -> usize {
    std::mem::size_of::<DiffVersion>()
        + refs_bytes(&diff.refs)
        + diff.created_at.len()
        + diff.state.len()
        + diff.real_size.as_ref().map_or(0, String::len)
        + diff
            .files
            .iter()
            .map(|file| {
                std::mem::size_of::<api::DiffFile>()
                    + file.old_path.len()
                    + file.new_path.len()
                    + file.old_mode.len()
                    + file.new_mode.len()
                    + file.diff.len()
            })
            .sum::<usize>()
}
fn discussion_bytes(discussions: &[Discussion]) -> usize {
    discussions
        .iter()
        .map(|discussion| {
            std::mem::size_of::<Discussion>()
                + discussion.id.len()
                + discussion
                    .notes
                    .iter()
                    .map(|note| {
                        std::mem::size_of::<api::Note>()
                            + note.body.len()
                            + user_bytes(&note.author)
                            + note.created_at.len()
                            + note.updated_at.len()
                            + note.position.as_ref().map_or(0, |position| {
                                position.base_sha.len()
                                    + position.start_sha.len()
                                    + position.head_sha.len()
                                    + position.position_type.len()
                                    + position.old_path.len()
                                    + position.new_path.len()
                            })
                    })
                    .sum::<usize>()
        })
        .sum()
}
fn cache_bytes(cache: &Cache) -> usize {
    std::mem::size_of::<Cache>()
        + cache.fingerprint.len()
        + cache.seen_key.as_ref().map_or(0, String::len)
        + cache.user.as_ref().map_or(0, user_bytes)
        + cache.items.iter().map(summary_bytes).sum::<usize>()
        + cache
            .details
            .values()
            .map(|cached| detail_bytes(&cached.value))
            .sum::<usize>()
        + cache
            .diffs
            .values()
            .map(|cached| diff_bytes(&cached.value))
            .sum::<usize>()
        + cache
            .discussions
            .values()
            .map(|cached| discussion_bytes(&cached.value))
            .sum::<usize>()
}

enum Payload {
    Detail(u64),
    Diff((u64, u64)),
    Discussions(u64),
}

async fn read_deadline<T>(
    future: impl std::future::Future<Output = Result<T, ApiError>>,
) -> Result<T, ApiError> {
    tokio::time::timeout(Duration::from_secs(90), future)
        .await
        .map_err(|_| error("timeout", "GitLab 完整读取超时，保留上次完整结果"))?
}

fn trim_diffs(cache: &mut HashMap<(u64, u64), Cached<DiffVersion>>) {
    retain_recent(cache, MAX_DIFFS);
    while cache
        .values()
        .map(|cached| {
            cached
                .value
                .files
                .iter()
                .map(|file| file.diff.len() + file.old_path.len() + file.new_path.len())
                .sum::<usize>()
        })
        .sum::<usize>()
        > MAX_DIFF_BYTES
    {
        if let Some(key) = cache
            .iter()
            .min_by_key(|(_, value)| value.at)
            .map(|(key, _)| *key)
        {
            cache.remove(&key);
        } else {
            break;
        }
    }
}

fn retain_recent<K: Eq + std::hash::Hash + Clone, T>(map: &mut HashMap<K, Cached<T>>, cap: usize) {
    while map.len() > cap {
        if let Some(key) = map
            .iter()
            .min_by_key(|(_, value)| value.at)
            .map(|(key, _)| key.clone())
        {
            map.remove(&key);
        }
    }
}

impl Inner {
    fn cache(&self) -> Option<&Cache> {
        self.active.as_ref().and_then(|a| self.caches.get(&a.key))
    }
    fn request(&self, mr_id: u64) -> Result<Request, ApiError> {
        self.cache()
            .and_then(|cache| {
                cache
                    .items
                    .iter()
                    .find(|summary| summary.id == mr_id)
                    .or_else(|| {
                        cache
                            .details
                            .get(&mr_id)
                            .map(|cached| &cached.value.summary)
                    })
            })
            .map(Request::from)
            .ok_or_else(|| error("not_found", "此合并请求不在当前账号的列表"))
    }
    fn snapshot(&self) -> Snapshot {
        let cache = self.cache();
        let items = cache.map_or_else(Vec::new, |c| c.items.clone());
        let viewed = cache
            .and_then(|c| c.seen_key.as_ref())
            .and_then(|key| self.seen.accounts.get(key));
        let unseen_ids: Vec<_> = items
            .iter()
            .filter(|item| {
                viewed.is_some_and(|entry| entry.initialized && !entry.viewed.contains(&item.id))
            })
            .map(|item| item.id)
            .collect();
        Snapshot {
            revision: self.revision,
            epoch: self.epoch,
            context_key: self.active.as_ref().map(|a| a.key.clone()),
            instance_url: self.active.as_ref().map(|a| a.instance.clone()),
            user: cache.and_then(|c| c.user.clone()),
            total: items.len(),
            new_count: unseen_ids.len(),
            items,
            unseen_ids,
            last_checked_at: cache.and_then(|c| c.checked_at),
            refreshing: self.list_running == Some(self.epoch),
            stale: cache.is_some_and(|c| c.stale),
            error: cache.and_then(|c| c.error.clone()),
            persistence_error: self.persistence_error.clone(),
            selected_detail: self.visibility.detail_id.and_then(|mr_id| {
                cache
                    .and_then(|c| c.details.get(&mr_id))
                    .map(|d| d.value.clone())
            }),
        }
    }
    fn publish(&mut self, app: &tauri::AppHandle) {
        let cache = self.cache();
        let stamp = UiStamp {
            epoch: self.epoch,
            key: self.active.as_ref().map(|active| active.key.clone()),
            instance_url: self.active.as_ref().map(|active| active.instance.clone()),
            data_revision: self.data_revision,
            selected_id: self.visibility.detail_id,
            refreshing: self.list_running == Some(self.epoch),
            stale: cache.is_some_and(|cache| cache.stale),
            error: cache.and_then(|cache| cache.error.clone()),
            persistence_error: self.persistence_error.clone(),
        };
        // Keep only a small comparison stamp, not a second retained copy of every row/detail.
        if self.last_emitted.as_ref() == Some(&stamp) {
            return;
        }
        self.revision += 1;
        self.last_emitted = Some(stamp);
        let _ = app.emit(EVENT, self.snapshot());
    }
    fn context(&self, epoch: u64, allow_paused: bool) -> Result<Context, ApiError> {
        if epoch != self.epoch {
            return Err(error("stale", "GitLab 账号已切换，请重新打开合并请求"));
        }
        let active = self
            .active
            .as_ref()
            .ok_or_else(|| error("invalid_config", "尚未配置 GitLab 合并请求"))?;
        if !allow_paused
            && (self.stopped
                || self.sleeping
                || !self.visibility.online
                || now() < self.resume_after
                || now() < self.retry_after)
        {
            return Err(self
                .cache()
                .and_then(|c| c.error.clone())
                .unwrap_or_else(|| error("blocked", "合并请求检查暂时暂停")));
        }
        Ok(Context {
            epoch,
            generation: self.write_generation,
            key: active.key.clone(),
            config: active.config.clone(),
        })
    }
    fn accepts(&self, context: &Context) -> bool {
        self.epoch == context.epoch
            && self.write_generation == context.generation
            && self.active.as_ref().is_some_and(|a| a.key == context.key)
    }
    fn save_seen(&mut self) {
        while self.seen.accounts.len() > MAX_SEEN_ACCOUNTS {
            let key = self
                .seen
                .accounts
                .iter()
                .min_by_key(|(_, entry)| entry.used_at)
                .map(|(key, _)| key.clone());
            if let Some(key) = key {
                self.seen.accounts.remove(&key);
            }
        }
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            if let Some(parent) = self.file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let temporary = self.file.with_extension("json.tmp");
            std::fs::write(&temporary, serde_json::to_vec(&self.seen)?)?;
            std::fs::rename(temporary, &self.file)?;
            Ok(())
        })();
        self.persistence_error = result.err().map(|e| e.to_string());
    }
    fn mark_viewed(&mut self, mr_id: u64) -> bool {
        if !self
            .cache()
            .is_some_and(|cache| cache.items.iter().any(|item| item.id == mr_id))
        {
            return false;
        }
        let key = self.cache().and_then(|cache| cache.seen_key.clone());
        if let Some(entry) = key.and_then(|key| self.seen.accounts.get_mut(&key)) {
            if entry.viewed.insert(mr_id) {
                self.data_revision += 1;
                entry.used_at = now();
                self.save_seen();
                return true;
            }
        }
        false
    }
    fn failure(&mut self, context: &Context, failure: ApiError) {
        if !self.accepts(context) {
            return;
        }
        self.failures = self.failures.saturating_add(1);
        self.retry_after = self
            .retry_after
            .max(now().saturating_add(backoff(self.failures, failure.retry_after)));
        self.stopped = matches!(failure.kind.as_str(), "unauthorized" | "forbidden");
        if let Some(active) = &self.active {
            if failure.kind == "unauthorized" {
                self.account_stops.insert(account_stop_key(active));
            }
            if failure.kind == "forbidden" {
                self.account_stops.insert(account_stop_key(active));
            }
        }
        self.next_list = self.retry_after;
        self.next_detail = self.retry_after.max(self.detail_retry_after);
        if let Some(cache) = self.caches.get_mut(&context.key) {
            cache.error = Some(failure);
            cache.stale = true;
        }
        if self.stopped {
            self.write_generation += 1;
        }
    }
    fn request_failure(&mut self, context: &Context, failure: ApiError) {
        // A project's permission/state error must not suspend the account-wide inbox.
        if matches!(
            failure.kind.as_str(),
            "forbidden" | "not_found" | "blocked" | "conflict" | "invalid_response"
        ) {
            return;
        }
        self.failure(context, failure);
    }
    fn acknowledge_list_success(&mut self, key: &str, at: i64) {
        // Another request may have received Retry-After while this list was in flight.
        if self.retry_after > at {
            return;
        }
        self.failures = 0;
        self.retry_after = 0;
        if self.detail_retry_after <= at {
            if let Some(cache) = self.caches.get_mut(key) {
                cache.stale = false;
                cache.error = None;
            }
        }
    }
    fn retained_bytes(&self) -> usize {
        self.caches
            .iter()
            .map(|(key, cache)| key.len() + cache_bytes(cache))
            .sum::<usize>()
            + self
                .seen
                .accounts
                .iter()
                .map(|(key, entry)| {
                    key.len() + std::mem::size_of::<SeenEntry>() + entry.viewed.len() * 16
                })
                .sum::<usize>()
    }
    fn trim_budget(&mut self, budget: usize) {
        while self.retained_bytes() > budget {
            let inactive = self
                .caches
                .iter()
                .filter(|(key, _)| {
                    self.active
                        .as_ref()
                        .is_none_or(|active| **key != active.key)
                })
                .min_by_key(|(_, cache)| cache.used_at)
                .map(|(key, _)| key.clone());
            if let Some(key) = inactive {
                self.caches.remove(&key);
                continue;
            }
            let selected = self.visibility.detail_id;
            let Some(key) = self.active.as_ref().map(|active| active.key.clone()) else {
                break;
            };
            let Some(cache) = self.caches.get_mut(&key) else {
                break;
            };
            let candidate = cache
                .details
                .iter()
                .filter(|(mr_id, _)| Some(**mr_id) != selected)
                .map(|(mr_id, cached)| (cached.at, Payload::Detail(*mr_id)))
                .chain(
                    cache
                        .diffs
                        .iter()
                        .map(|(id, cached)| (cached.at, Payload::Diff(*id))),
                )
                .chain(
                    cache
                        .discussions
                        .iter()
                        .map(|(mr_id, cached)| (cached.at, Payload::Discussions(*mr_id))),
                )
                .min_by_key(|(at, _)| *at);
            match candidate {
                Some((_, Payload::Detail(mr_id))) => {
                    cache.details.remove(&mr_id);
                }
                Some((_, Payload::Diff(id))) => {
                    cache.diffs.remove(&id);
                }
                Some((_, Payload::Discussions(mr_id))) => {
                    cache.discussions.remove(&mr_id);
                }
                None => {
                    if selected.is_some_and(|mr_id| cache.details.remove(&mr_id).is_some()) {
                        self.data_revision += 1;
                    } else {
                        break;
                    } // Complete active summaries are never truncated.
                }
            }
        }
    }
    fn trim_accounts(&mut self) {
        while self.caches.len() > MAX_ACCOUNTS {
            let key = self
                .caches
                .iter()
                .filter(|(key, _)| self.active.as_ref().is_none_or(|a| **key != a.key))
                .min_by_key(|(_, cache)| cache.used_at)
                .map(|(key, _)| key.clone());
            if let Some(key) = key {
                self.caches.remove(&key);
            } else {
                break;
            }
        }
    }
    fn replan(&mut self, immediate: bool) {
        let at = now();
        let last = self.cache().and_then(|c| c.checked_at).unwrap_or(0);
        let detail = self
            .visibility
            .detail_id
            .and_then(|mr_id| self.cache().and_then(|c| c.details.get(&mr_id)));
        let detail_at = detail.map_or(0, |d| d.at);
        let delay = interval(
            self.foreground,
            self.visibility.list_open,
            self.visibility.detail_id.is_some(),
            ci_running(detail.map(|d| &d.value)),
        );
        self.next_list = if immediate && self.foreground {
            at.max(last.saturating_add(COOLDOWN))
        } else {
            at.max(last.saturating_add(if self.foreground {
                if self.visibility.list_open || self.visibility.detail_id.is_some() {
                    30_000
                } else {
                    60_000
                }
            } else {
                BACKGROUND
            }))
        };
        self.next_detail = (if immediate && self.foreground {
            at.max(detail_at.saturating_add(COOLDOWN))
        } else {
            at.max(detail_at.saturating_add(delay))
        })
        .max(self.detail_retry_after);
    }
}

impl Service {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn foreground(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        window.is_focused().unwrap_or(false)
            && window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(true)
    })
}

pub fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let file = app.path().app_data_dir()?.join("merge-request-seen.json");
    let (seen, persistence_error) = match std::fs::read(&file) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(seen) => (seen, None),
            Err(e) => (SeenStore::default(), Some(e.to_string())),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (SeenStore::default(), None),
        Err(e) => (SeenStore::default(), Some(e.to_string())),
    };
    let service = Arc::new(Service {
        inner: Mutex::new(Inner {
            epoch: 0,
            revision: 0,
            active: None,
            caches: HashMap::new(),
            seen,
            file,
            persistence_error,
            visibility: Visibility {
                online: true,
                ..Visibility::default()
            },
            foreground: foreground(app),
            sleeping: false,
            resume_after: 0,
            retry_after: 0,
            failures: 0,
            detail_failures: 0,
            detail_retry_after: 0,
            stopped: false,
            account_stops: HashSet::new(),
            next_list: now(),
            next_detail: now(),
            list_running: None,
            write_generation: 0,
            data_revision: 0,
            last_emitted: None,
        }),
        changed: Notify::new(),
        list_gate: AsyncMutex::new(()),
        detail_gate: AsyncMutex::new(()),
        diff_gate: AsyncMutex::new(()),
        download_gate: AsyncMutex::new(()),
        discussion_gate: AsyncMutex::new(()),
        mutation_gate: AsyncMutex::new(()),
    });
    app.manage(MrState(service.clone()));
    if let Some(window) = app.get_webview_window("main") {
        let service = service.clone();
        window.on_window_event(move |_| {
            service.changed.notify_one();
        });
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        scheduler(app, service).await;
    });
    Ok(())
}

pub fn power_changed(app: &tauri::AppHandle, sleeping: bool) {
    if let Some(state) = app.try_state::<MrState>() {
        let mut inner = state.0.lock();
        inner.write_generation += 1;
        inner.sleeping = sleeping;
        inner.resume_after = now().saturating_add(COOLDOWN);
        inner.next_list = inner.resume_after;
        inner.next_detail = inner.resume_after;
        drop(inner);
        state.0.changed.notify_one();
    }
}

async fn scheduler(app: tauri::AppHandle, service: Arc<Service>) {
    loop {
        let notified = service.changed.notified();
        let foreground = foreground(&app);
        let plan = {
            let mut inner = service.lock();
            if inner.foreground != foreground {
                inner.foreground = foreground;
                inner.replan(foreground);
            }
            if inner.active.is_none() || inner.stopped || inner.sleeping || !inner.visibility.online
            {
                None
            } else {
                let next = if inner.visibility.detail_id.is_some() {
                    inner.next_list.min(inner.next_detail)
                } else {
                    inner.next_list
                };
                Some((
                    next.max(inner.resume_after).max(inner.retry_after),
                    inner.epoch,
                    inner.next_list <= now(),
                    inner
                        .visibility
                        .detail_id
                        .filter(|_| inner.next_detail <= now()),
                ))
            }
        };
        match plan {
            None => notified.await,
            Some((due, epoch, list_due, detail_id)) if due <= now() => {
                if list_due {
                    let _ = refresh_list(&app, &service, epoch, false, false).await;
                }
                if let Some(mr_id) = detail_id {
                    let _ = load_detail(&app, &service, mr_id, epoch, true, false).await;
                }
                // A skipped/cached request or an uninitialized account cannot spin the scheduler.
                let mut inner = service.lock();
                if inner.epoch == epoch {
                    if list_due && inner.next_list <= now() {
                        inner.next_list = now().saturating_add(COOLDOWN);
                    }
                    if detail_id.is_some() && inner.next_detail <= now() {
                        inner.next_detail = now().saturating_add(COOLDOWN);
                    }
                }
            }
            Some((due, _, _, _)) => {
                let _ = tokio::time::timeout(
                    Duration::from_millis((due - now()).max(1) as u64),
                    notified,
                )
                .await;
            }
        }
    }
}

async fn refresh_list(
    app: &tauri::AppHandle,
    service: &Arc<Service>,
    epoch: u64,
    force: bool,
    visible_progress: bool,
) -> Result<Snapshot, ApiError> {
    let requested_at = now();
    let _gate = service.list_gate.lock().await;
    let context = {
        let mut inner = service.lock();
        let context = inner.context(epoch, false)?;
        let checked = inner.cache().and_then(|c| c.checked_at);
        // Calls waiting on the same flight consume its completed snapshot.
        if checked.is_some_and(|at| at >= requested_at || (!force && now() - at < COOLDOWN)) {
            return Ok(inner.snapshot());
        }
        inner.list_running = Some(epoch);
        if visible_progress || checked.is_none() {
            inner.publish(app);
        }
        context
    };
    let identity = {
        let inner = service.lock();
        if inner.accepts(&context) && inner.active.as_ref().is_some_and(|a| a.identity_verified) {
            inner.cache().and_then(|cache| cache.user.clone())
        } else {
            None
        }
    };
    let result = match identity {
        Some(user) => read_deadline(api::list_resolved(&context.config, &user)).await,
        None => read_deadline(api::list(&context.config)).await,
    }
    .and_then(|list| {
        validate_summaries(&list.items, SUMMARY_BUDGET)?;
        Ok(list)
    });
    let mut inner = service.lock();
    if inner.list_running == Some(epoch) {
        inner.list_running = None;
    }
    if !inner.accepts(&context) {
        inner.publish(app);
        service.changed.notify_one();
        return Err(error("stale", "合并请求状态或 GitLab 账号已变化，请刷新"));
    }
    let mut failure = None;
    match result {
        Ok(list) => {
            let at = now();
            let key = seen_key(
                inner.active.as_ref().expect("checked active context"),
                list.user.id,
            );
            let current: HashSet<_> = list.items.iter().map(|item| item.id).collect();
            let entry = inner.seen.accounts.entry(key.clone()).or_default();
            let persist = reconcile_seen(entry, &current, at);
            let changed = inner.cache().is_none_or(|cache| {
                cache.user.as_ref() != Some(&list.user)
                    || cache.items != list.items
                    || cache.seen_key.as_ref() != Some(&key)
            });
            if changed {
                inner.data_revision += 1;
            }
            let cache = inner
                .caches
                .get_mut(&context.key)
                .expect("configured cache");
            cache.user = Some(list.user);
            cache.items = list.items;
            cache.seen_key = Some(key);
            cache.checked_at = Some(at);
            cache.used_at = at;
            inner.acknowledge_list_success(&context.key, at);
            if let Some(active) = inner.active.as_mut() {
                active.identity_verified = true;
            }
            if persist {
                inner.save_seen();
            }
            inner.trim_budget(CACHE_BUDGET);
            inner.next_list = at.saturating_add(if !inner.foreground {
                BACKGROUND
            } else if inner.visibility.list_open || inner.visibility.detail_id.is_some() {
                30_000
            } else {
                60_000
            });
        }
        Err(e) => {
            failure = Some(e.clone());
            inner.failure(&context, e);
        }
    }
    inner.publish(app);
    let snapshot = inner.snapshot();
    drop(inner);
    service.changed.notify_one();
    failure.map_or(Ok(snapshot), Err)
}

async fn load_detail(
    app: &tauri::AppHandle,
    service: &Arc<Service>,
    mr_id: u64,
    epoch: u64,
    force: bool,
    mark_seen: bool,
) -> Result<Detail, ApiError> {
    load_detail_with_request(app, service, mr_id, epoch, force, mark_seen, None).await
}

async fn load_detail_with_request(
    app: &tauri::AppHandle,
    service: &Arc<Service>,
    mr_id: u64,
    epoch: u64,
    force: bool,
    mark_seen: bool,
    trusted_request: Option<Request>,
) -> Result<Detail, ApiError> {
    let requested_at = now();
    let _gate = service.detail_gate.lock().await;
    let (context, request) = {
        let mut inner = service.lock();
        let context = inner.context(epoch, false)?;
        let request = inner
            .request(mr_id)
            .or_else(|failure| trusted_request.ok_or(failure))?;
        if let Some(cached) = inner.cache().and_then(|c| c.details.get(&mr_id)) {
            if cached.at >= requested_at || (!force && now() - cached.at < COOLDOWN) {
                let result = cached.value.clone();
                if mark_seen {
                    inner.mark_viewed(mr_id);
                    inner.publish(app);
                }
                return Ok(result);
            }
        }
        (context, request)
    };
    let known = if mark_seen {
        None
    } else {
        service
            .lock()
            .cache()
            .and_then(|cache| cache.details.get(&mr_id))
            .map(|cached| cached.value.clone())
    };
    let result = match known {
        Some(known) => {
            read_deadline(api::detail_status(
                &context.config,
                request.project_id,
                request.iid,
                &known,
            ))
            .await
        }
        None => {
            read_deadline(api::detail(
                &context.config,
                request.project_id,
                request.iid,
            ))
            .await
        }
    }
    .and_then(|detail| {
        if detail.summary.id != mr_id || Request::from(&detail.summary) != request {
            Err(error("invalid_response", "GitLab 详情与所选合并请求不一致"))
        } else if detail_bytes(&detail) > DETAIL_BUDGET {
            Err(error(
                "invalid_response",
                "完整详情超过本地缓存预算，请在 GitLab 查看",
            ))
        } else {
            Ok(detail)
        }
    });
    let mut inner = service.lock();
    if !inner.accepts(&context) {
        return Err(error("stale", "合并请求状态或 GitLab 账号已变化，请刷新"));
    }
    match result {
        Ok(detail) => {
            let at = now();
            let selected = inner.visibility.detail_id;
            let cache = inner
                .caches
                .get_mut(&context.key)
                .expect("configured cache");
            let changed = update_summary(cache, detail.summary.clone())
                || (selected == Some(mr_id)
                    && cache
                        .details
                        .get(&mr_id)
                        .is_none_or(|cached| cached.value != detail));
            cache.details.insert(
                mr_id,
                Cached {
                    value: detail.clone(),
                    at,
                },
            );
            retain_recent(&mut cache.details, MAX_DETAILS);
            if changed {
                inner.data_revision += 1;
            }
            if mark_seen {
                inner.mark_viewed(mr_id);
            }
            inner.detail_failures = 0;
            inner.detail_retry_after = 0;
            inner.next_detail = at.saturating_add(interval(
                inner.foreground,
                inner.visibility.list_open,
                inner.visibility.detail_id.is_some(),
                ci_running(Some(&detail)),
            ));
            inner.trim_budget(CACHE_BUDGET);
            inner.publish(app);
            drop(inner);
            service.changed.notify_one();
            Ok(detail)
        }
        Err(e) => {
            inner.detail_failures = inner.detail_failures.saturating_add(1);
            inner.detail_retry_after = inner
                .detail_retry_after
                .max(now().saturating_add(backoff(inner.detail_failures, e.retry_after)));
            inner.request_failure(&context, e.clone());
            inner.publish(app);
            drop(inner);
            service.changed.notify_one();
            Err(e)
        }
    }
}

fn update_summary(cache: &mut Cache, mut summary: Summary) -> bool {
    // Descriptions belong to the on-demand detail, never the lightweight inbox rows.
    summary.description = None;
    if let Some(index) = cache.items.iter().position(|row| row.id == summary.id) {
        if Request::from(&cache.items[index]) != Request::from(&summary) {
            return false;
        }
        if cache.items[index] == summary {
            return false;
        }
        if summary.state == "opened" && !summary.roles.is_empty() {
            cache.items[index] = summary;
        } else {
            cache.items.remove(index);
        }
        return true;
    }
    false
}

#[tauri::command]
pub fn mr_snapshot(state: tauri::State<'_, MrState>) -> Snapshot {
    state.0.lock().snapshot()
}

#[tauri::command]
pub fn mr_configure(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    config: Option<Config>,
) -> Result<Snapshot, ApiError> {
    let active = match config {
        Some(config) => {
            let api_config = api::Config {
                url: config.url,
                token: config.token,
            };
            let canonical = match api::validate_config(&api_config) {
                Ok(canonical) => canonical,
                Err(failure) => {
                    let mut inner = state.0.lock();
                    inner.epoch += 1;
                    inner.write_generation += 1;
                    inner.active = None;
                    inner.visibility.detail_id = None;
                    inner.visibility.list_open = false;
                    inner.publish(&app);
                    drop(inner);
                    state.0.changed.notify_one();
                    return Err(failure);
                }
            };
            let key = context_key(&config.account_key, &canonical);
            let instance = canonical;
            let fingerprint = digest(&api_config.token);
            Some(Active {
                config: api_config,
                account_key: config.account_key,
                key,
                instance,
                fingerprint,
                identity_verified: false,
            })
        }
        None => None,
    };
    let mut inner = state.0.lock();
    let same = match (&inner.active, &active) {
        (Some(old), Some(new)) => {
            old.key == new.key && old.fingerprint == new.fingerprint && old.config == new.config
        }
        (None, None) => true,
        _ => false,
    };
    if same {
        if let (Some(old), Some(mut active)) = (&inner.active, active) {
            active.identity_verified = old.identity_verified;
            inner.active = Some(active);
        }
        inner.publish(&app);
        return Ok(inner.snapshot());
    }
    inner.epoch += 1;
    inner.write_generation += 1;
    inner.active = active;
    inner.visibility.detail_id = None;
    inner.visibility.list_open = false;
    inner.retry_after = 0;
    inner.failures = 0;
    inner.detail_failures = 0;
    inner.detail_retry_after = 0;
    inner.stopped = false;
    if let Some(active) = inner.active.clone() {
        let cache = inner.caches.entry(active.key.clone()).or_default();
        // A replacement token must prove its provider identity before showing old data.
        if cache.fingerprint != active.fingerprint {
            *cache = Cache::default();
        }
        cache.fingerprint = active.fingerprint.clone();
        cache.used_at = now();
        inner.stopped = inner.account_stops.contains(&account_stop_key(&active));
        if inner.stopped {
            let forbidden = inner
                .caches
                .get(&active.key)
                .and_then(|cache| cache.error.as_ref())
                .is_some_and(|failure| failure.kind == "forbidden");
            let kind = if forbidden {
                "forbidden"
            } else {
                "unauthorized"
            };
            if let Some(cache) = inner.caches.get_mut(&active.key) {
                cache.error = Some(error(
                    kind,
                    if kind == "unauthorized" {
                        "该 GitLab 账号认证已失效，请更新凭据"
                    } else {
                        "GitLab 合并请求读取权限不足，请检查账号权限"
                    },
                ));
                cache.stale = true;
            }
        }
    }
    // Account summaries survive switching; large on-demand payloads do not accumulate across accounts.
    let active_key = inner.active.as_ref().map(|a| a.key.clone());
    for (key, cache) in &mut inner.caches {
        if Some(key) != active_key.as_ref() {
            cache.details.clear();
            cache.diffs.clear();
            cache.discussions.clear();
        }
    }
    inner.trim_accounts();
    inner.trim_budget(CACHE_BUDGET);
    inner.replan(true);
    inner.publish(&app);
    let snapshot = inner.snapshot();
    drop(inner);
    state.0.changed.notify_one();
    Ok(snapshot)
}

#[tauri::command]
pub fn mr_visibility(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mut visibility: Visibility,
) -> Snapshot {
    let mut inner = state.0.lock();
    visibility.detail_id = visibility
        .detail_id
        .filter(|mr_id| inner.request(*mr_id).is_ok());
    let wake = !inner.visibility.online && visibility.online;
    let opened = (!inner.visibility.list_open && visibility.list_open)
        || (visibility.detail_id.is_some() && inner.visibility.detail_id != visibility.detail_id);
    inner.visibility = visibility;
    if wake {
        inner.resume_after = now().saturating_add(COOLDOWN);
    }
    inner.replan(opened || wake);
    inner.publish(&app);
    let snapshot = inner.snapshot();
    drop(inner);
    state.0.changed.notify_one();
    snapshot
}

#[tauri::command]
pub async fn mr_refresh(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    force: Option<bool>,
) -> Result<Snapshot, ApiError> {
    let service = state.0.clone();
    let epoch = service.lock().epoch;
    refresh_list(&app, &service, epoch, force.unwrap_or(false), true).await
}

#[tauri::command]
pub fn mr_mark_viewed(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mr_id: u64,
    epoch: u64,
) -> Result<Snapshot, ApiError> {
    let mut inner = state.0.lock();
    inner.context(epoch, true)?;
    if !inner.cache().is_some_and(|cache| {
        cache.items.iter().any(|row| row.id == mr_id) || cache.details.contains_key(&mr_id)
    }) {
        return Err(error("not_found", "此合并请求不在当前列表"));
    }
    inner.mark_viewed(mr_id);
    inner.publish(&app);
    Ok(inner.snapshot())
}

#[tauri::command]
pub async fn mr_detail(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mr_id: u64,
    epoch: u64,
    force: Option<bool>,
) -> Result<Detail, ApiError> {
    load_detail(
        &app,
        &state.0.clone(),
        mr_id,
        epoch,
        force.unwrap_or(false),
        true,
    )
    .await
}

#[tauri::command]
pub async fn mr_commit_messages(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mr_id: u64,
    epoch: u64,
) -> Result<api::CommitMessages, ApiError> {
    let service = state.0.clone();
    let _gate = service.detail_gate.lock().await;
    let (context, known, user_id) = {
        let inner = service.lock();
        let context = inner.context(epoch, false)?;
        if inner.visibility.detail_id != Some(mr_id) {
            return Err(error("stale", "合并请求详情已切换，请重新打开消息编辑"));
        }
        let cache = inner
            .cache()
            .ok_or_else(|| error("not_found", "尚未加载合并请求"))?;
        let known = cache
            .details
            .get(&mr_id)
            .ok_or_else(|| error("blocked", "请先加载合并请求详情"))?
            .value
            .summary
            .clone();
        let user_id = cache
            .user
            .as_ref()
            .ok_or_else(|| error("stale", "GitLab 当前账号身份尚未确认，请刷新列表"))?
            .id;
        (context, known, user_id)
    };
    let result = read_deadline(api::commit_messages(&context.config, &known, user_id)).await;
    let mut inner = service.lock();
    if !inner.accepts(&context)
        || inner.visibility.detail_id != Some(mr_id)
        || inner
            .cache()
            .and_then(|cache| cache.user.as_ref())
            .is_none_or(|user| user.id != user_id)
        || inner
            .cache()
            .and_then(|cache| cache.details.get(&mr_id))
            .is_none_or(|detail| !api::same_message_revision(&known, &detail.value.summary))
    {
        return Err(error(
            "stale",
            "合并请求或账号已变化，请重新加载默认提交消息",
        ));
    }
    if let Err(failure) = &result {
        // An older GraphQL schema affects only this editor, not ordinary MR reads.
        if failure.kind != "unsupported" {
            inner.request_failure(&context, failure.clone());
            inner.publish(&app);
            service.changed.notify_one();
        }
    }
    result
}

#[tauri::command]
pub async fn mr_diffs(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mr_id: u64,
    version_id: u64,
    epoch: u64,
) -> Result<DiffVersion, ApiError> {
    let service = state.0.clone();
    let _gate = service.diff_gate.lock().await;
    let (context, request) = {
        let inner = service.lock();
        let context = inner.context(epoch, false)?;
        let request = inner.request(mr_id)?;
        if let Some(cached) = inner
            .cache()
            .and_then(|c| c.diffs.get(&(mr_id, version_id)))
        {
            return Ok(cached.value.clone());
        }
        (context, request)
    };
    let result = read_deadline(api::diffs(
        &context.config,
        request.project_id,
        request.iid,
        version_id,
    ))
    .await;
    let mut inner = service.lock();
    if !inner.accepts(&context) {
        return Err(error("stale", "合并请求状态或 GitLab 账号已变化，请刷新"));
    }
    let result = match result {
        Ok(result) => result,
        Err(failure) => {
            inner.request_failure(&context, failure.clone());
            inner.publish(&app);
            service.changed.notify_one();
            return Err(failure);
        }
    };
    let cache = inner
        .caches
        .get_mut(&context.key)
        .expect("configured cache");
    cache.diffs.insert(
        (mr_id, version_id),
        Cached {
            value: result.clone(),
            at: now(),
        },
    );
    trim_diffs(&mut cache.diffs);
    inner.trim_budget(CACHE_BUDGET);
    Ok(result)
}

/// Write beside the destination and replace it only after the account guard
/// succeeds. A failed transfer/write leaves an existing destination intact.
fn save_diff_file<Guard>(
    path: &std::path::Path,
    bytes: &[u8],
    before_commit: impl FnOnce() -> Result<Guard, ApiError>,
) -> Result<(), ApiError> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let temporary = path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(format!(
            ".gitkit-mr-diff-{}-{}-{}.tmp",
            std::process::id(),
            now(),
            SERIAL.fetch_add(1, Ordering::Relaxed),
        ));
    let save_error = || {
        error(
            "save_failed",
            "无法保存文本差异，请检查保存位置和磁盘空间后重试",
        )
    };
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| save_error())?;
    let result = (|| {
        file.write_all(bytes).map_err(|_| save_error())?;
        file.sync_all().map_err(|_| save_error())?;
        drop(file);
        let _guard = before_commit()?;
        std::fs::rename(&temporary, path).map_err(|_| save_error())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[tauri::command]
pub async fn mr_download_diff(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mr_id: u64,
    epoch: u64,
    reviewed_version_id: u64,
    reviewed_refs: api::DiffRefs,
    expected_target_branch: String,
) -> Result<Option<DownloadedDiff>, ApiError> {
    let service = state.0.clone();
    let _gate = service
        .download_gate
        .try_lock()
        .map_err(|_| error("blocked", "已有差异下载正在进行，请等待结果"))?;
    let (context, request) = {
        let inner = service.lock();
        (inner.context(epoch, false)?, inner.request(mr_id)?)
    };
    // The native picker is the authority for the destination. The webview
    // cannot use this command to write arbitrary paths supplied through IPC.
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Diff", &["diff"])
        .set_file_name(format!(
            "project-{}-mr-{}-v{}.diff",
            request.project_id, request.iid, reviewed_version_id
        ))
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver
        .await
        .map_err(|_| error("save_failed", "无法打开文本差异保存窗口，请重试"))?
    else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|_| error("save_failed", "文本差异保存位置无效，请选择本地文件"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| error("save_failed", "文本差异保存位置无效，请选择本地文件"))?
        .to_string_lossy()
        .into_owned();
    {
        let inner = service.lock();
        inner.context(epoch, false)?;
        if !inner.accepts(&context) || inner.request(mr_id)? != request {
            return Err(error("stale", "合并请求状态或 GitLab 账号已变化，请刷新"));
        }
    }
    let result = read_deadline(api::download_diff(
        &context.config,
        mr_id,
        request.project_id,
        request.iid,
        &expected_target_branch,
        reviewed_version_id,
        &reviewed_refs,
    ))
    .await;
    let downloaded = {
        let mut inner = service.lock();
        if !inner.accepts(&context) {
            return Err(error("stale", "合并请求状态或 GitLab 账号已变化，请刷新"));
        }
        match result {
            Ok(downloaded) => downloaded,
            Err(failure) => {
                inner.request_failure(&context, failure.clone());
                inner.publish(&app);
                service.changed.notify_one();
                return Err(failure);
            }
        }
    };
    let saved = DownloadedDiff {
        file_name,
        version_id: downloaded.version_id,
        refs: downloaded.refs,
    };
    let writing_service = service.clone();
    tauri::async_runtime::spawn_blocking(move || {
        save_diff_file(&path, &downloaded.bytes, || {
            let inner = writing_service.lock();
            if !inner.accepts(&context) || inner.request(mr_id)? != request {
                return Err(error("stale", "合并请求状态或 GitLab 账号已变化，请刷新"));
            }
            Ok(inner)
        })
    })
    .await
    .map_err(|_| {
        error(
            "save_failed",
            "无法保存文本差异，请检查保存位置和磁盘空间后重试",
        )
    })??;
    Ok(Some(saved))
}

#[tauri::command]
pub async fn mr_discussions(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mr_id: u64,
    epoch: u64,
    force: Option<bool>,
) -> Result<Vec<Discussion>, ApiError> {
    let requested_at = now();
    let service = state.0.clone();
    let _gate = service.discussion_gate.lock().await;
    let (context, request) = {
        let inner = service.lock();
        let context = inner.context(epoch, false)?;
        let request = inner.request(mr_id)?;
        if let Some(cached) = inner.cache().and_then(|c| c.discussions.get(&mr_id)) {
            if cached.at >= requested_at
                || (!force.unwrap_or(false) && now() - cached.at < COOLDOWN)
            {
                return Ok(cached.value.clone());
            }
        }
        (context, request)
    };
    let result = read_deadline(api::discussions(
        &context.config,
        request.project_id,
        request.iid,
    ))
    .await;
    let mut inner = service.lock();
    if !inner.accepts(&context) {
        return Err(error("stale", "合并请求状态或 GitLab 账号已变化，请刷新"));
    }
    let result = match result {
        Ok(result) => result,
        Err(failure) => {
            inner.request_failure(&context, failure.clone());
            inner.publish(&app);
            service.changed.notify_one();
            return Err(failure);
        }
    };
    let cache = inner
        .caches
        .get_mut(&context.key)
        .expect("configured cache");
    cache.discussions.insert(
        mr_id,
        Cached {
            value: result.clone(),
            at: now(),
        },
    );
    retain_recent(&mut cache.discussions, MAX_DETAILS);
    inner.trim_budget(CACHE_BUDGET);
    Ok(result)
}

fn invalidate_comment_cache(cache: &mut Cache, mr_id: u64) {
    cache.details.remove(&mr_id);
    cache.discussions.remove(&mr_id);
}

#[tauri::command]
pub async fn mr_create_diff_comment(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mr_id: u64,
    epoch: u64,
    reviewed_version_id: u64,
    reviewed_refs: api::DiffRefs,
    expected_target_branch: String,
    position: api::DiffCommentPosition,
    body: String,
) -> Result<DiffCommentResult, ApiError> {
    use std::sync::atomic::{AtomicBool, Ordering};
    let service = state.0.clone();
    let _gate = service
        .mutation_gate
        .try_lock()
        .map_err(|_| error("blocked", "已有合并请求操作正在进行，请等待结果"))?;
    let (context, request, user_id) = {
        let mut inner = service.lock();
        let context = inner.context(epoch, false)?;
        let request = inner.request(mr_id)?;
        let user_id = inner
            .cache()
            .and_then(|cache| cache.user.as_ref())
            .map(|user| user.id)
            .filter(|id| *id > 0)
            .ok_or_else(|| error("stale", "请刷新合并请求并确认 GitLab 账号"))?;
        inner.write_generation += 1;
        (
            Context {
                generation: inner.write_generation,
                ..context
            },
            request,
            user_id,
        )
    };
    let sent = AtomicBool::new(false);
    let result = tokio::time::timeout(
        Duration::from_secs(120),
        api::create_diff_comment(
            &context.config,
            mr_id,
            request.project_id,
            request.iid,
            user_id,
            reviewed_version_id,
            &reviewed_refs,
            &expected_target_branch,
            &position,
            &body,
            || {
                let inner = service.lock();
                inner.context(epoch, false)?;
                if !inner.accepts(&context) {
                    return Err(error(
                        "stale",
                        "GitLab 账号或应用状态已变化，请刷新后重新评论",
                    ));
                }
                sent.store(true, Ordering::SeqCst);
                Ok(())
            },
        ),
    )
    .await
    .unwrap_or_else(|_| {
        if sent.load(Ordering::SeqCst) {
            Ok(api::uncertain_diff_comment())
        } else {
            Err(error("timeout", "GitLab 请求超时，请稍后重试"))
        }
    });
    let mut inner = service.lock();
    // Invalidate the original account cache even if the user switched accounts
    // after POST. Its remote discussions may have changed in either outcome.
    if sent.load(Ordering::SeqCst) {
        if let Some(cache) = inner.caches.get_mut(&context.key) {
            invalidate_comment_cache(cache, mr_id);
        }
    }
    if !inner.accepts(&context) {
        if sent.load(Ordering::SeqCst) {
            inner.data_revision += 1;
            inner.publish(&app);
            return Ok(api::uncertain_diff_comment());
        }
        return Err(error(
            "stale",
            "GitLab 账号或应用状态已变化，请刷新后重新评论",
        ));
    }
    if let Err(failure) = &result {
        if failure.kind != "invalid_input" {
            inner.request_failure(&context, failure.clone());
        }
    }
    inner.write_generation += 1;
    inner.data_revision += 1;
    inner.next_detail = now().saturating_add(COOLDOWN);
    inner.publish(&app);
    service.changed.notify_one();
    result
}

#[tauri::command]
pub async fn mr_merge(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mr_id: u64,
    epoch: u64,
    reviewed_sha: String,
    expected_target_branch: String,
    reviewed_version_id: u64,
    reviewed_refs: api::DiffRefs,
    squash: bool,
    delete_source: bool,
    merge_commit_message: Option<String>,
    squash_commit_message: Option<String>,
) -> Result<MergeResult, ApiError> {
    let service = state.0.clone();
    let _gate = service
        .mutation_gate
        .try_lock()
        .map_err(|_| error("blocked", "已有合并操作正在进行，请等待结果"))?;
    let (context, request) = {
        let mut inner = service.lock();
        let context = inner.context(epoch, false)?;
        let request = inner.request(mr_id)?;
        if reviewed_sha.is_empty() {
            return Err(error("blocked", "请先查看并确认本次提交差异"));
        }
        inner.write_generation += 1;
        (
            Context {
                generation: inner.write_generation,
                ..context
            },
            request,
        )
    };
    // API revalidates server readiness and passes the reviewed SHA to the merge endpoint.
    let result = tokio::time::timeout(
        Duration::from_secs(120),
        api::merge(
            &context.config,
            request.project_id,
            request.iid,
            &reviewed_sha,
            &expected_target_branch,
            reviewed_version_id,
            &reviewed_refs,
            squash,
            delete_source,
            merge_commit_message.as_deref(),
            squash_commit_message.as_deref(),
        ),
    )
    .await
    .unwrap_or_else(|_| {
        Err(error(
            "uncertain",
            "合并操作结果尚未确认，请到 GitLab 核实，勿重复提交",
        ))
    })
    .and_then(|result| {
        if result
            .summary
            .as_ref()
            .is_some_and(|summary| summary.id != mr_id || Request::from(summary) != request)
        {
            Err(error(
                "uncertain",
                "GitLab 返回的合并请求身份不一致，请到原项目核实操作结果，勿重复提交",
            ))
        } else {
            Ok(result)
        }
    });
    {
        let mut inner = service.lock();
        if !inner.accepts(&context) {
            return Err(error(
                if inner.epoch == epoch {
                    "uncertain"
                } else {
                    "stale"
                },
                "操作已发送，但应用状态已变化，请到原 GitLab 项目核实结果，勿重复提交",
            ));
        }
        inner.write_generation += 1;
        if let Some(cache) = inner.caches.get_mut(&context.key) {
            cache.details.remove(&mr_id);
            cache.discussions.remove(&mr_id);
            if let Ok(result) = &result {
                if let Some(summary) = &result.summary {
                    update_summary(cache, summary.clone());
                }
            }
        }
        inner.data_revision += 1;
        inner.publish(&app);
    }
    // Only this MR is re-read. A timed-out mutation is never automatically re-issued.
    let _ = load_detail_with_request(&app, &service, mr_id, epoch, true, true, Some(request)).await;
    result.map_err(|failure| {
        if matches!(failure.kind.as_str(), "timeout" | "network") {
            error(
                "uncertain",
                "合并操作结果尚未确认，请刷新状态或到 GitLab 核实，勿直接重复提交",
            )
        } else {
            failure
        }
    })
}

enum Action {
    Close,
    UpdateParticipants {
        kind: api::ParticipantKind,
        user_ids: Vec<u64>,
        expected_user_ids: Vec<u64>,
    },
    Approve {
        reviewed_sha: String,
        expected_target_branch: String,
        reviewed_version_id: u64,
        reviewed_refs: api::DiffRefs,
    },
}

fn cache_action_result(cache: &mut Cache, mr_id: u64, result: &Result<ActionResult, ApiError>) {
    cache.details.remove(&mr_id);
    cache.discussions.remove(&mr_id);
    if let Ok(ActionResult {
        detail: Some(detail),
        ..
    }) = result
    {
        update_summary(cache, detail.summary.clone());
        cache.details.insert(
            mr_id,
            Cached {
                value: detail.clone(),
                at: now(),
            },
        );
        retain_recent(&mut cache.details, MAX_DETAILS);
    }
}

async fn perform_action(
    app: &tauri::AppHandle,
    service: &Arc<Service>,
    mr_id: u64,
    epoch: u64,
    action: Action,
) -> Result<ActionResult, ApiError> {
    use std::sync::atomic::{AtomicBool, Ordering};
    let participant_update = matches!(&action, Action::UpdateParticipants { .. });
    let participant_sent = AtomicBool::new(false);
    let _gate = service
        .mutation_gate
        .try_lock()
        .map_err(|_| error("blocked", "已有合并请求操作正在进行，请等待结果"))?;
    let (context, request) = {
        let mut inner = service.lock();
        let context = inner.context(epoch, false)?;
        let request = inner.request(mr_id)?;
        inner.write_generation += 1;
        (
            Context {
                generation: inner.write_generation,
                ..context
            },
            request,
        )
    };
    let operation = async {
        match action {
            Action::Close => {
                api::close(&context.config, mr_id, request.project_id, request.iid).await
            }
            Action::UpdateParticipants {
                kind,
                user_ids,
                expected_user_ids,
            } => {
                api::update_participants(
                    &context.config,
                    mr_id,
                    request.project_id,
                    request.iid,
                    kind,
                    &user_ids,
                    &expected_user_ids,
                    || {
                        let inner = service.lock();
                        inner.context(epoch, false)?;
                        if !inner.accepts(&context) || inner.request(mr_id)? != request {
                            return Err(error("stale", "合并请求状态或 GitLab 账号已变化，请刷新"));
                        }
                        participant_sent.store(true, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .await
            }
            Action::Approve {
                reviewed_sha,
                expected_target_branch,
                reviewed_version_id,
                reviewed_refs,
            } => {
                api::approve(
                    &context.config,
                    mr_id,
                    request.project_id,
                    request.iid,
                    &reviewed_sha,
                    &expected_target_branch,
                    reviewed_version_id,
                    &reviewed_refs,
                )
                .await
            }
        }
    };
    let result = tokio::time::timeout(Duration::from_secs(120), operation)
        .await
        .unwrap_or_else(|_| {
            if participant_update && !participant_sent.load(Ordering::SeqCst) {
                Err(error("timeout", "GitLab 请求超时，请稍后重试"))
            } else {
                Err(error(
                    "uncertain",
                    "操作结果尚未确认，请到 GitLab 核实，勿重复提交",
                ))
            }
        })
        .and_then(|result| {
            if result.detail.as_ref().is_some_and(|detail| {
                detail.summary.id != mr_id || Request::from(&detail.summary) != request
            }) {
                Err(error(
                    "uncertain",
                    "GitLab 返回的合并请求身份不一致，请到原项目核实操作结果，勿重复提交",
                ))
            } else if result
                .detail
                .as_ref()
                .is_some_and(|detail| detail_bytes(detail) > DETAIL_BUDGET)
            {
                Ok(ActionResult {
                    detail: None,
                    ..result
                })
            } else {
                Ok(result)
            }
        });
    {
        let mut inner = service.lock();
        if !inner.accepts(&context) {
            if participant_update && !participant_sent.load(Ordering::SeqCst) {
                return Err(result.err().unwrap_or_else(|| {
                    error("stale", "合并请求状态或 GitLab 账号已变化，请刷新")
                }));
            }
            return Err(error(
                if inner.epoch == epoch {
                    "uncertain"
                } else {
                    "stale"
                },
                "操作已发送，但应用状态已变化，请到原 GitLab 项目核实结果，勿重复提交",
            ));
        }
        // Drop any reads begun during the write before publishing the fresh result.
        inner.write_generation += 1;
        if let Some(cache) = inner.caches.get_mut(&context.key) {
            cache_action_result(cache, mr_id, &result);
        }
        inner.data_revision += 1;
        inner.next_detail = now().saturating_add(COOLDOWN);
        inner.trim_budget(CACHE_BUDGET);
        inner.publish(app);
    }
    service.changed.notify_one();
    result.map_err(|failure| {
        if matches!(failure.kind.as_str(), "timeout" | "network")
            && (!participant_update || participant_sent.load(Ordering::SeqCst))
        {
            error(
                "uncertain",
                "操作结果尚未确认，请刷新状态或到 GitLab 核实，勿直接重复提交",
            )
        } else {
            failure
        }
    })
}

#[tauri::command]
pub async fn mr_participant_candidates(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mr_id: u64,
    epoch: u64,
    query: String,
    page: u64,
) -> Result<api::ParticipantCandidates, ApiError> {
    let service = state.0.clone();
    let (context, request) = {
        let inner = service.lock();
        (inner.context(epoch, false)?, inner.request(mr_id)?)
    };
    let result = read_deadline(api::participant_candidates(
        &context.config,
        mr_id,
        request.project_id,
        request.iid,
        &query,
        page,
    ))
    .await;
    let mut inner = service.lock();
    if !inner.accepts(&context) || inner.request(mr_id)? != request {
        return Err(error("stale", "合并请求状态或 GitLab 账号已变化，请刷新"));
    }
    if let Err(failure) = &result {
        if failure.kind != "invalid_input" {
            inner.request_failure(&context, failure.clone());
            inner.publish(&app);
            service.changed.notify_one();
        }
    }
    result
}

#[tauri::command]
pub async fn mr_update_participants(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mr_id: u64,
    epoch: u64,
    kind: api::ParticipantKind,
    user_ids: Vec<u64>,
    expected_user_ids: Vec<u64>,
) -> Result<ActionResult, ApiError> {
    perform_action(
        &app,
        &state.0.clone(),
        mr_id,
        epoch,
        Action::UpdateParticipants {
            kind,
            user_ids,
            expected_user_ids,
        },
    )
    .await
}

#[tauri::command]
pub async fn mr_close(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mr_id: u64,
    epoch: u64,
) -> Result<ActionResult, ApiError> {
    perform_action(&app, &state.0.clone(), mr_id, epoch, Action::Close).await
}

#[tauri::command]
pub async fn mr_approve(
    app: tauri::AppHandle,
    state: tauri::State<'_, MrState>,
    mr_id: u64,
    epoch: u64,
    reviewed_sha: String,
    expected_target_branch: String,
    reviewed_version_id: u64,
    reviewed_refs: api::DiffRefs,
) -> Result<ActionResult, ApiError> {
    perform_action(
        &app,
        &state.0.clone(),
        mr_id,
        epoch,
        Action::Approve {
            reviewed_sha,
            expected_target_branch,
            reviewed_version_id,
            reviewed_refs,
        },
    )
    .await
}

#[tauri::command]
pub fn mr_open(state: tauri::State<'_, MrState>, mr_id: u64, epoch: u64) -> Result<(), ApiError> {
    let inner = state.0.lock();
    let context = inner.context(epoch, true)?;
    let cache = inner
        .cache()
        .ok_or_else(|| error("not_found", "尚未加载合并请求"))?;
    let summary = cache
        .items
        .iter()
        .find(|row| row.id == mr_id)
        .or_else(|| cache.details.get(&mr_id).map(|d| &d.value.summary))
        .ok_or_else(|| error("not_found", "此合并请求不在当前列表"))?;
    let url = api::validated_web_url(
        &context.config,
        summary.project_id,
        summary.iid,
        &summary.web_url,
    )?;
    crate::git::open_in_browser(&url).map_err(|message| error("blocked", &message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_save_is_atomic_and_stale_context_preserves_existing_file() {
        let directory = std::env::temp_dir().join(format!("gitkit-diff-save-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("review.diff");
        std::fs::write(&path, b"previous download").unwrap();
        let failure = save_diff_file(&path, b"new download", || Err::<(), _>(error("stale", "changed"))).unwrap_err();
        assert_eq!(failure.kind, "stale");
        assert_eq!(std::fs::read(&path).unwrap(), b"previous download");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        save_diff_file(&path, b"new download", || Ok(())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new download");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    fn fixture() -> Inner {
        let config = api::Config {
            url: "https://gitlab.example".into(),
            token: "fixture-only".into(),
        };
        let key = context_key("gitlab", "https://gitlab.example");
        let active = Active {
            fingerprint: digest(&config.token),
            config,
            account_key: "gitlab".into(),
            key: key.clone(),
            instance: "https://gitlab.example".into(),
            identity_verified: false,
        };
        let mut caches = HashMap::new();
        caches.insert(key, Cache::default());
        Inner {
            epoch: 4,
            revision: 0,
            active: Some(active),
            caches,
            seen: SeenStore::default(),
            file: PathBuf::new(),
            persistence_error: None,
            visibility: Visibility {
                online: true,
                ..Visibility::default()
            },
            foreground: true,
            sleeping: false,
            resume_after: 0,
            retry_after: 0,
            failures: 0,
            detail_failures: 0,
            detail_retry_after: 0,
            stopped: false,
            account_stops: HashSet::new(),
            next_list: 0,
            next_detail: 0,
            list_running: None,
            write_generation: 2,
            data_revision: 0,
            last_emitted: None,
        }
    }

    fn row(mr_id: u64, title_bytes: usize) -> Summary {
        Summary {
            id: mr_id,
            project_id: 9,
            project_path_with_namespace: "team/project".into(),
            iid: mr_id,
            title: "x".repeat(title_bytes),
            state: "opened".into(),
            description: None,
            source_branch: "source".into(),
            target_branch: "main".into(),
            author: User {
                id: 7,
                name: "Fixture".into(),
                username: "fixture".into(),
            },
            roles: vec!["author".into()],
            draft: false,
            updated_at: "2026-10-06".into(),
            sha: None,
            detailed_merge_status: None,
            web_url: "https://gitlab.example/team/project/-/merge_requests/1".into(),
            pipeline_status: None,
        }
    }

    fn detail(summary: Summary) -> Detail {
        Detail {
            summary,
            assignees: vec![],
            reviewers: vec![],
            can_manage_participants: false,
            description: "reviewed".into(),
            pipeline_status: None,
            approvals: api::ApprovalState {
                readable: true,
                approved: None,
                approvals_required: None,
                approvals_left: None,
                approved_by: vec![],
            },
            blocking_discussions_resolved: None,
            can_merge: false,
            can_close: false,
            can_approve: false,
            blocked_reasons: vec![],
            diff_refs: None,
            diff_versions: vec![],
            squash_policy: "default_off".into(),
            squash: false,
            delete_source_default: false,
            delete_source_required: false,
            delete_source_allowed: None,
            merge_commit_message: None,
            squash_commit_message: None,
        }
    }

    #[test]
    fn account_config_needs_no_repository_or_remote() {
        let config: Config = serde_json::from_value(serde_json::json!({
            "accountKey": "gitlab", "url": "https://gitlab.example", "token": "fixture"
        }))
        .unwrap();
        assert_eq!(config.account_key, "gitlab");
        assert_eq!(config.url, "https://gitlab.example");
        assert_eq!(
            fixture().snapshot().instance_url.as_deref(),
            Some("https://gitlab.example")
        );
    }

    #[test]
    fn legacy_project_seen_records_load_without_reusing_their_iids_as_global_ids() {
        let mut store: SeenStore = serde_json::from_value(serde_json::json!({
            "projects": { "old-project": { "initialized": true, "viewed": [7], "used_at": 1 } }
        }))
        .unwrap();
        assert!(store
            .accounts
            .get("old-project")
            .unwrap()
            .viewed
            .contains(&7));
        let active = fixture().active.unwrap();
        let account = store.accounts.entry(seen_key(&active, 7)).or_default();
        assert!(reconcile_seen(account, &HashSet::from([101, 202]), 2));
        assert_eq!(account.viewed, HashSet::from([101, 202]));
        let persisted = serde_json::to_value(&store).unwrap();
        assert!(persisted.get("accounts").is_some());
        assert!(persisted.get("projects").is_none());
    }

    #[test]
    fn same_iid_across_projects_keeps_selection_unread_and_updates_independent() {
        let mut inner = fixture();
        inner.file = std::env::temp_dir().join(format!(
            "gitkit-global-mr-seen-{}-{}.json",
            std::process::id(),
            now()
        ));
        let key = inner.active.as_ref().unwrap().key.clone();
        let viewed_key = seen_key(inner.active.as_ref().unwrap(), 7);
        let mut first = row(101, 8);
        first.iid = 7;
        let mut second = row(202, 8);
        second.project_id = 10;
        second.project_path_with_namespace = "team/other".into();
        second.iid = 7;
        let cache = inner.caches.get_mut(&key).unwrap();
        cache.items = vec![first.clone(), second.clone()];
        cache.seen_key = Some(viewed_key.clone());
        cache.details.insert(
            101,
            Cached {
                value: detail(first.clone()),
                at: 10,
            },
        );
        cache.details.insert(
            202,
            Cached {
                value: detail(second.clone()),
                at: 20,
            },
        );
        inner.seen.accounts.insert(
            viewed_key,
            SeenEntry {
                initialized: true,
                viewed: HashSet::from([101]),
                used_at: 0,
            },
        );
        inner.visibility.detail_id = Some(202);
        assert_eq!(
            inner.request(101).unwrap(),
            Request {
                project_id: 9,
                iid: 7
            }
        );
        assert_eq!(
            inner.request(202).unwrap(),
            Request {
                project_id: 10,
                iid: 7
            }
        );
        assert_eq!(inner.request(7).unwrap_err().kind, "not_found");
        assert_eq!(inner.snapshot().selected_detail.unwrap().summary, second);
        assert_eq!(inner.snapshot().unseen_ids, vec![202]);
        assert!(!inner.mark_viewed(7));
        assert!(inner.mark_viewed(202));
        assert_eq!(inner.snapshot().new_count, 0);
        let cache = inner.caches.get_mut(&key).unwrap();
        second.state = "merged".into();
        assert!(update_summary(cache, second));
        assert_eq!(cache.items, vec![first.clone()]);
        assert_eq!(inner.request(202).unwrap().project_id, 10); // A viewed/closed detail remains trusted.
        let mut mismatched = first.clone();
        mismatched.project_id = 10;
        assert!(!update_summary(
            inner.caches.get_mut(&key).unwrap(),
            mismatched
        ));
        assert_eq!(inner.cache().unwrap().items, vec![first]);
        let _ = std::fs::remove_file(&inner.file);
    }

    #[test]
    fn project_permission_failures_do_not_pause_the_account_inbox() {
        let mut inner = fixture();
        let context = inner.context(4, false).unwrap();
        inner.request_failure(&context, error("forbidden", "project unavailable"));
        inner.request_failure(&context, error("not_found", "project removed"));
        assert!(!inner.stopped);
        assert_eq!(inner.retry_after, 0);
        assert!(inner.context(4, false).is_ok());
        inner.request_failure(&context, error("unauthorized", "expired"));
        assert!(inner.stopped);
        assert_eq!(inner.context(4, false).err().unwrap().kind, "unauthorized");
    }

    #[test]
    fn complete_inbox_accepts_more_than_the_account_cache_limit_of_projects() {
        let rows: Vec<_> = (1..=32)
            .map(|id| {
                let mut item = row(id, 8);
                item.project_id = id;
                item.iid = 1;
                item
            })
            .collect();
        assert!(validate_summaries(&rows, SUMMARY_BUDGET).is_ok());
        let mut duplicated = rows.clone();
        duplicated.push(rows[0].clone());
        assert_eq!(
            validate_summaries(&duplicated, SUMMARY_BUDGET)
                .unwrap_err()
                .kind,
            "invalid_response"
        );
    }

    #[test]
    fn cache_budget_evicts_inactive_lru_without_truncating_active_summary() {
        let mut inner = fixture();
        let active = inner.active.as_ref().unwrap().key.clone();
        let active_rows = vec![row(1, 64)];
        inner.caches.get_mut(&active).unwrap().items = active_rows.clone();
        inner.caches.insert(
            "old".into(),
            Cache {
                items: vec![row(2, 8_000)],
                used_at: 1,
                ..Cache::default()
            },
        );
        inner.caches.insert(
            "new".into(),
            Cache {
                items: vec![row(3, 8_000)],
                used_at: 2,
                ..Cache::default()
            },
        );
        let old_bytes = cache_bytes(inner.caches.get("old").unwrap()) + "old".len();
        let budget = inner.retained_bytes() - old_bytes;
        inner.trim_budget(budget);
        assert!(inner.retained_bytes() <= budget);
        assert!(!inner.caches.contains_key("old"));
        assert!(inner.caches.contains_key("new"));
        assert_eq!(inner.caches.get(&active).unwrap().items, active_rows);
    }

    #[test]
    fn payload_budget_preserves_selected_detail_and_rejects_oversized_summary_before_replacement() {
        let mut inner = fixture();
        let key = inner.active.as_ref().unwrap().key.clone();
        inner.visibility.detail_id = Some(1);
        let original = vec![row(1, 32)];
        let detail = Detail {
            summary: original[0].clone(),
            assignees: vec![],
            reviewers: vec![],
            can_manage_participants: false,
            description: "reviewed".into(),
            pipeline_status: None,
            approvals: api::ApprovalState {
                readable: true,
                approved: None,
                approvals_required: None,
                approvals_left: None,
                approved_by: vec![],
            },
            blocking_discussions_resolved: None,
            can_merge: false,
            can_close: false,
            can_approve: false,
            blocked_reasons: vec![],
            diff_refs: None,
            diff_versions: vec![],
            squash_policy: "default_off".into(),
            squash: false,
            delete_source_default: false,
            delete_source_required: false,
            delete_source_allowed: None,
            merge_commit_message: None,
            squash_commit_message: None,
        };
        let cache = inner.caches.get_mut(&key).unwrap();
        cache.items = original.clone();
        cache.details.insert(
            1,
            Cached {
                value: detail.clone(),
                at: 0,
            },
        );
        let discussion = vec![Discussion {
            id: "notes".repeat(1_000),
            individual_note: true,
            notes: vec![],
        }];
        cache.discussions.insert(
            1,
            Cached {
                value: discussion.clone(),
                at: 1,
            },
        );
        cache.discussions.insert(
            2,
            Cached {
                value: discussion.clone(),
                at: 2,
            },
        );
        let budget = inner.retained_bytes() - discussion_bytes(&discussion);
        inner.trim_budget(budget);
        assert!(inner.retained_bytes() <= budget);
        let cache = inner.caches.get(&key).unwrap();
        assert!(!cache.discussions.contains_key(&1));
        assert!(cache.discussions.contains_key(&2));
        assert_eq!(cache.details.get(&1).unwrap().value, detail);
        assert!(validate_summaries(&[row(2, 4_000)], 1_000).is_err());
        assert_eq!(cache.items, original);
    }

    #[test]
    fn baseline_never_notifies_existing_requests_and_unchanged_checks_do_not_persist() {
        let mut entry = SeenEntry::default();
        let initial = HashSet::from([10, 20]);
        assert!(reconcile_seen(&mut entry, &initial, 100));
        assert_eq!(entry.viewed, initial);
        assert!(!reconcile_seen(&mut entry, &initial, 200));
        let changed = HashSet::from([10, 20, 30]);
        assert!(!reconcile_seen(&mut entry, &changed, 300));
        assert_eq!(
            changed
                .difference(&entry.viewed)
                .copied()
                .collect::<HashSet<_>>(),
            HashSet::from([30])
        );
        entry.viewed.insert(30);
        assert!(reconcile_seen(&mut entry, &HashSet::from([10, 30]), 400));
        assert_eq!(entry.viewed, HashSet::from([10, 30]));
    }

    #[test]
    fn epoch_and_read_generation_reject_late_credentials_sleep_and_mutation_results() {
        let mut inner = fixture();
        let context = inner.context(4, false).unwrap();
        assert!(inner.accepts(&context));
        inner.write_generation += 1;
        assert!(!inner.accepts(&context));
        let new_context = inner.context(4, false).unwrap();
        inner.epoch += 1;
        assert!(!inner.accepts(&new_context));
        assert_eq!(inner.context(4, false).err().unwrap().kind, "stale");
    }

    #[test]
    fn offline_sleep_and_wake_grace_block_reads_but_keep_snapshot_available() {
        let mut inner = fixture();
        inner.visibility.online = false;
        assert!(inner.context(4, false).is_err());
        assert!(inner.context(4, true).is_ok());
        inner.visibility.online = true;
        inner.sleeping = true;
        assert!(inner.context(4, false).is_err());
        inner.sleeping = false;
        inner.resume_after = now() + COOLDOWN;
        assert!(inner.context(4, false).is_err());
        assert_eq!(inner.snapshot().epoch, 4);
    }

    #[test]
    fn authorization_failure_stops_account_and_preserves_existing_complete_check() {
        let mut inner = fixture();
        let key = inner.active.as_ref().unwrap().key.clone();
        inner.caches.get_mut(&key).unwrap().checked_at = Some(42);
        let context = inner.context(4, false).unwrap();
        inner.failure(&context, error("unauthorized", "expired"));
        assert!(inner.stopped);
        assert!(inner
            .account_stops
            .contains(&account_stop_key(inner.active.as_ref().unwrap())));
        assert_eq!(inner.snapshot().last_checked_at, Some(42));
        assert!(inner.snapshot().stale);
        assert_eq!(inner.context(4, false).err().unwrap().kind, "unauthorized");
    }

    #[test]
    fn concurrent_success_never_clears_an_unexpired_retry_after_or_detail_backoff() {
        let mut inner = fixture();
        let key = inner.active.as_ref().unwrap().key.clone();
        let context = inner.context(4, false).unwrap();
        let at = now();
        inner.failure(
            &context,
            ApiError {
                kind: "rate_limit".into(),
                message: "wait".into(),
                retry_after: Some(3600),
            },
        );
        let deadline = inner.retry_after;
        inner.acknowledge_list_success(&key, at);
        assert_eq!(inner.retry_after, deadline);
        assert!(inner.snapshot().error.is_some());
        inner.detail_retry_after = deadline + MAX_BACKOFF;
        inner.acknowledge_list_success(&key, deadline);
        assert_eq!(inner.retry_after, 0);
        assert!(inner.snapshot().error.is_some());
        inner.acknowledge_list_success(&key, inner.detail_retry_after);
        assert!(inner.snapshot().error.is_none());
    }

    #[test]
    fn background_dominates_open_list_and_running_ci() {
        assert_eq!(interval(false, true, true, true), 300_000);
        assert_eq!(interval(true, false, false, true), 60_000);
        assert_eq!(interval(true, true, false, true), 30_000);
        assert_eq!(interval(true, false, true, true), 15_000);
        assert_eq!(interval(true, false, true, false), 30_000);
    }

    #[test]
    fn retry_after_is_not_shortened_by_backoff_limit() {
        assert_eq!(backoff(1, None), 15_000);
        assert_eq!(backoff(30, None), 900_000);
        assert_eq!(backoff(30, Some(3600)), 3_600_000);
    }

    #[test]
    fn keys_isolate_accounts_instances_and_provider_identity() {
        let key = context_key("gitlab", "https://gitlab.example");
        assert_eq!(key, context_key("gitlab", "https://gitlab.example"));
        assert_ne!(key, context_key("other", "https://gitlab.example"));
        assert_ne!(key, context_key("gitlab", "https://other.example"));
        let active = Active {
            config: api::Config {
                url: "https://gitlab.example".into(),
                token: "private".into(),
            },
            account_key: "gitlab".into(),
            key,
            instance: "https://gitlab.example".into(),
            fingerprint: "x".into(),
            identity_verified: false,
        };
        assert_ne!(seen_key(&active, 1), seen_key(&active, 2));
        let old_project_key = digest(&format!(
            "{}:{}:{}",
            context_key("gitlab", "https://gitlab.example"),
            1,
            10
        ));
        assert_ne!(seen_key(&active, 1), old_project_key);
        let mut other_instance = active.clone();
        other_instance.instance = "https://other.example".into();
        assert_ne!(seen_key(&active, 1), seen_key(&other_instance, 1));
        assert!(!serde_json::to_string(&SeenStore::default())
            .unwrap()
            .contains("private"));
    }

    #[test]
    fn detail_cache_has_a_fixed_bound() {
        let mut cache = HashMap::new();
        for id in 0..20 {
            cache.insert(
                id,
                Cached {
                    value: id,
                    at: id as i64,
                },
            );
        }
        retain_recent(&mut cache, MAX_DETAILS);
        assert_eq!(cache.len(), MAX_DETAILS);
        assert!(cache.contains_key(&19));
        assert!(!cache.contains_key(&0));
    }

    #[test]
    fn action_cache_replaces_confirmed_detail_and_removes_closed_requests_from_inbox() {
        let mut cache = Cache::default();
        let initial = row(101, 8);
        cache.items = vec![initial.clone()];
        cache.details.insert(
            101,
            Cached {
                value: detail(initial.clone()),
                at: 0,
            },
        );
        cache.discussions.insert(
            101,
            Cached {
                value: vec![],
                at: 0,
            },
        );
        let mut current = detail(initial);
        current.summary.state = "closed".into();
        let result = Ok(ActionResult {
            state: "closed".into(),
            message: "confirmed".into(),
            detail: Some(current.clone()),
        });
        cache_action_result(&mut cache, 101, &result);
        assert!(cache.items.is_empty());
        assert_eq!(cache.details.get(&101).unwrap().value, current);
        assert!(!cache.discussions.contains_key(&101));
    }

    #[test]
    fn uncertain_action_without_detail_invalidates_personal_approval_and_discussion_cache() {
        let initial = row(101, 8);
        let mut cache = Cache {
            items: vec![initial.clone()],
            ..Cache::default()
        };
        cache.details.insert(
            101,
            Cached {
                value: detail(initial),
                at: 0,
            },
        );
        cache.discussions.insert(
            101,
            Cached {
                value: vec![],
                at: 0,
            },
        );
        cache_action_result(
            &mut cache,
            101,
            &Ok(ActionResult {
                state: "uncertain".into(),
                message: "not confirmed".into(),
                detail: None,
            }),
        );
        assert_eq!(cache.items.len(), 1);
        assert!(!cache.details.contains_key(&101));
        assert!(!cache.discussions.contains_key(&101));
    }

    #[test]
    fn diff_comment_invalidates_only_the_commented_mr_details_and_discussions() {
        let mut cache = Cache::default();
        for mr_id in [101, 102] {
            cache.items.push(row(mr_id, 8));
            cache.details.insert(mr_id, Cached {
                value: detail(row(mr_id, 8)),
                at: 0,
            });
            cache.discussions.insert(mr_id, Cached {
                value: vec![],
                at: 0,
            });
        }
        invalidate_comment_cache(&mut cache, 101);
        assert!(!cache.details.contains_key(&101));
        assert!(!cache.discussions.contains_key(&101));
        assert!(cache.details.contains_key(&102));
        assert!(cache.discussions.contains_key(&102));
        assert_eq!(cache.items.len(), 2);
    }
}
