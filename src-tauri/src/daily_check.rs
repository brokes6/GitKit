//! Native daily checks: scheduling and results outlive WebView suspension.
//! Only configuration/results are persisted; credentials live in memory.
use crate::git::{self, BehindBranch, CancelState};
use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveTime};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};

const EVENT: &str = "daily-check-state";
const WAKE_GRACE_MS: i64 = 15_000;
const PROJECT_TIMEOUT_MS: i64 = 120_000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    enabled: bool,
    time: String,
    #[serde(default)]
    skip_weekends: bool,
    #[serde(default)]
    last_run: i64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            time: "09:30".into(),
            skip_weekends: false,
            last_run: 0,
        }
    }
}
#[derive(Clone, Deserialize)]
pub struct Project {
    id: String,
    name: String,
    path: String,
}
#[derive(Clone, Deserialize)]
pub struct Account {
    id: String,
    host: String,
    token: String,
}
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    github: Vec<Account>,
    gitlab_host: String,
    gitlab_token: String,
    preferences: std::collections::HashMap<String, String>,
}
impl Credentials {
    fn token_for(&self, path: &str, remote: &str) -> Option<String> {
        let host = if remote.starts_with("https://") || remote.starts_with("http://") {
            reqwest::Url::parse(remote)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_default()
        } else {
            remote
                .split_once('@')
                .and_then(|(_, rest)| rest.split([':', '/']).next())
                .unwrap_or_default()
                .to_owned()
        };
        if host.is_empty() {
            return None;
        }
        let candidates: Vec<_> = self
            .github
            .iter()
            .filter(|a| {
                if a.host.is_empty() {
                    host == "github.com" || host.ends_with(".github.com")
                } else {
                    host == a.host
                }
            })
            .collect();
        let preferred = self.preferences.get(path);
        candidates
            .iter()
            .find(|a| Some(&a.id) == preferred)
            .or_else(|| candidates.first())
            .map(|a| a.token.clone())
            .or_else(|| {
                (host == self.gitlab_host && !self.gitlab_token.is_empty())
                    .then(|| self.gitlab_token.clone())
            })
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    id: String,
    name: String,
    path: String,
    behind: Vec<BehindBranch>,
    dirty: bool,
    current_branch: String,
    error: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    id: i64,
    completed_at: i64,
    manual: bool,
    viewed: bool,
    rows: Vec<Row>,
    total: usize,
}
#[derive(Clone, Default, Deserialize, Serialize)]
struct Saved {
    config: Config,
    result: Option<ResultSet>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    current: usize,
    total: usize,
    project: String,
    paused: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    config: Config,
    progress: Option<Progress>,
    result: Option<ResultSet>,
    persistence_error: Option<String>,
}
struct Inner {
    saved: Saved,
    file: PathBuf,
    revision: u64,
    projects: Vec<Project>,
    credentials: Credentials,
    ready: bool,
    busy: bool,
    running: bool,
    progress: Option<Progress>,
    epoch: u64,
    sleeping: bool,
    resume_after: i64,
    active_op: Option<(String, i64)>,
    deferred_manual: Option<NaiveDate>,
    persistence_error: Option<String>,
}
#[derive(Clone)]
pub struct DailyCheckState(Arc<Mutex<Inner>>);
impl Inner {
    fn interrupt(&mut self, sleeping: bool, now: i64) -> Option<String> {
        self.epoch += 1;
        self.sleeping = sleeping;
        self.resume_after = now + WAKE_GRACE_MS;
        if let Some(progress) = &mut self.progress {
            progress.paused = true;
        }
        self.active_op.as_ref().map(|(id, _)| id.clone())
    }
    fn finish(
        &mut self,
        rows: Vec<Row>,
        total: usize,
        epoch: u64,
        manual: bool,
        day: NaiveDate,
        now: DateTime<Local>,
    ) -> bool {
        self.running = false;
        self.active_op = None;
        self.progress = None;
        if self.epoch != epoch || self.sleeping || now.date_naive() != day {
            if manual && now.date_naive() == day {
                self.deferred_manual = Some(day);
            }
            return false;
        }
        let completed_at = now.timestamp_millis();
        let id = completed_at.max(self.saved.result.as_ref().map_or(0, |r| r.id + 1));
        let viewed = rows.is_empty() && !manual;
        self.saved.config.last_run = completed_at;
        self.saved.result = Some(ResultSet {
            id,
            completed_at,
            manual,
            viewed,
            rows,
            total,
        });
        self.save();
        true
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            revision: self.revision,
            config: self.saved.config.clone(),
            progress: self.progress.clone(),
            result: self.saved.result.clone(),
            persistence_error: self.persistence_error.clone(),
        }
    }
    fn publish(&mut self, app: &tauri::AppHandle) {
        self.revision += 1;
        let _ = app.emit(EVENT, self.snapshot());
    }
    fn save(&mut self) {
        // Write beside the final file, then rename, so termination cannot leave partial JSON.
        let outcome = (|| -> Result<(), Box<dyn std::error::Error>> {
            if let Some(parent) = self.file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let temp = self.file.with_extension("tmp");
            std::fs::write(&temp, serde_json::to_vec(&self.saved)?)?;
            std::fs::rename(temp, &self.file)?;
            Ok(())
        })();
        self.persistence_error = outcome.err().map(|e| format!("定时检查结果保存失败：{e}"));
    }
}
fn due(config: &Config, now: DateTime<Local>) -> bool {
    if !config.enabled || (config.skip_weekends && now.weekday().number_from_monday() >= 6) {
        return false;
    }
    let Ok(time) = NaiveTime::parse_from_str(&config.time, "%H:%M") else {
        return false;
    };
    let completed_today = DateTime::from_timestamp_millis(config.last_run)
        .is_some_and(|last| last.with_timezone(&Local).date_naive() == now.date_naive());
    now.time() >= time && !completed_today
}

#[tauri::command]
pub fn daily_check_snapshot(state: tauri::State<'_, DailyCheckState>) -> Snapshot {
    state.0.lock().unwrap().snapshot()
}
#[tauri::command]
pub fn daily_check_configure(
    app: tauri::AppHandle,
    state: tauri::State<'_, DailyCheckState>,
    mut config: Config,
    projects: Vec<Project>,
    credentials: Credentials,
) -> Result<Snapshot, String> {
    if NaiveTime::parse_from_str(&config.time, "%H:%M").is_err() {
        return Err("检查时间无效".into());
    }
    let mut inner = state.0.lock().unwrap();
    // A delayed UI update must never roll back the native completion timestamp.
    config.last_run = config.last_run.max(inner.saved.config.last_run);
    inner.saved.config = config;
    inner.projects = projects;
    inner.credentials = credentials;
    inner.ready = true;
    inner.save();
    inner.publish(&app);
    Ok(inner.snapshot())
}
#[tauri::command]
pub fn daily_check_set_busy(state: tauri::State<'_, DailyCheckState>, busy: bool) {
    state.0.lock().unwrap().busy = busy;
}
#[tauri::command]
pub fn daily_check_mark_viewed(
    app: tauri::AppHandle,
    state: tauri::State<'_, DailyCheckState>,
    id: i64,
) {
    let mut inner = state.0.lock().unwrap();
    if let Some(result) = inner
        .saved
        .result
        .as_mut()
        .filter(|r| r.id == id && !r.viewed)
    {
        result.viewed = true;
        inner.save();
        inner.publish(&app);
    }
}
#[tauri::command]
pub fn daily_check_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, DailyCheckState>,
) -> Result<(), String> {
    start(&app, &state, true)
}

fn start(app: &tauri::AppHandle, state: &DailyCheckState, manual: bool) -> Result<(), String> {
    let now = Local::now();
    let (projects, credentials, epoch) = {
        let mut inner = state.0.lock().unwrap();
        if !inner.ready {
            return Err("定时检查正在准备，请稍后重试".into());
        }
        if inner.running {
            return Err("检查正在进行中".into());
        }
        if inner.sleeping
            || (now.timestamp_millis() < inner.resume_after && (!manual || inner.epoch > 0))
        {
            return Err("正在等待休眠后的网络恢复，请稍后重试".into());
        }
        if inner.busy || app.state::<CancelState>().has_foreground_operation() {
            return Err("请等待当前 Git 操作完成".into());
        }
        if inner.projects.is_empty() {
            return Err("还没有打开任何项目".into());
        }
        if !manual && !due(&inner.saved.config, now) {
            return Ok(());
        }
        inner.running = true;
        inner.deferred_manual = None;
        inner.progress = Some(Progress {
            current: 0,
            total: inner.projects.len(),
            project: inner.projects[0].name.clone(),
            paused: false,
        });
        inner.publish(app);
        (
            inner.projects.clone(),
            inner.credentials.clone(),
            inner.epoch,
        )
    };
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        run(
            app,
            state,
            projects,
            credentials,
            epoch,
            manual,
            now.date_naive(),
        )
        .await;
    });
    Ok(())
}
fn interrupted(inner: &Inner, epoch: u64, day: NaiveDate) -> bool {
    inner.epoch != epoch || inner.sleeping || Local::now().date_naive() != day
}
async fn run(
    app: tauri::AppHandle,
    state: DailyCheckState,
    projects: Vec<Project>,
    credentials: Credentials,
    epoch: u64,
    manual: bool,
    day: NaiveDate,
) {
    let mut rows = Vec::new();
    let mut aborted = false;
    for (index, project) in projects.iter().enumerate() {
        // Foreground Git operations take priority between projects.
        loop {
            let (cancelled, busy) = {
                let inner = state.0.lock().unwrap();
                (
                    interrupted(&inner, epoch, day),
                    inner.busy || app.state::<CancelState>().has_foreground_operation(),
                )
            };
            if cancelled {
                aborted = true;
                break;
            }
            if !busy {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        if aborted {
            break;
        }
        let op_id = format!("daily-check-{epoch}-{index}");
        {
            let mut inner = state.0.lock().unwrap();
            if interrupted(&inner, epoch, day) {
                break;
            }
            inner.progress = Some(Progress {
                current: index,
                total: projects.len(),
                project: project.name.clone(),
                paused: false,
            });
            inner.active_op = Some((op_id.clone(), Local::now().timestamp_millis()));
            inner.publish(&app);
        }
        let outcome = async {
            let remotes = git::git_remotes(project.path.clone()).await?;
            let Some(remote) = remotes
                .iter()
                .find(|r| r.name == "origin")
                .or_else(|| remotes.first())
            else {
                return Ok(None);
            };
            let token = credentials.token_for(&project.path, &remote.url);
            let result = git::check_updates(
                project.path.clone(),
                token.clone(),
                Some((app.state::<CancelState>().inner().clone(), op_id)),
            )
            .await;
            // Do not persist a credential if a helper included it in an error.
            result.map(Some).map_err(|e| {
                token
                    .filter(|t| !t.is_empty())
                    .map_or(e.clone(), |t| e.replace(&t, "[redacted]"))
            })
        }
        .await;
        let mut inner = state.0.lock().unwrap();
        inner.active_op = None;
        if interrupted(&inner, epoch, day) {
            break;
        }
        match outcome {
            Ok(Some(result)) if !result.behind.is_empty() => rows.push(Row {
                id: project.id.clone(),
                name: project.name.clone(),
                path: project.path.clone(),
                behind: result.behind,
                dirty: result.dirty,
                current_branch: result.current_branch,
                error: None,
            }),
            Err(error) => rows.push(Row {
                id: project.id.clone(),
                name: project.name.clone(),
                path: project.path.clone(),
                behind: vec![],
                dirty: false,
                current_branch: String::new(),
                error: Some(if error.contains("__cancelled__") {
                    "检查超时，请稍后重试".into()
                } else {
                    error
                }),
            }),
            _ => {}
        }
    }
    let actionable;
    {
        let mut inner = state.0.lock().unwrap();
        let has_findings = !rows.is_empty();
        actionable =
            inner.finish(rows, projects.len(), epoch, manual, day, Local::now()) && has_findings;
        inner.publish(&app);
    }
    // Native attention works even while the WebView is suspended. Never focus
    // or unminimize the window on behalf of a scheduled background task.
    if actionable {
        if let Some(window) = app.get_webview_window("main") {
            if !window.is_focused().unwrap_or(false) {
                if let Err(error) =
                    window.request_user_attention(Some(tauri::UserAttentionType::Informational))
                {
                    eprintln!("daily check attention failed: {error}");
                }
            }
        }
    }
}

fn power_changed(app: &tauri::AppHandle, sleeping: bool) {
    let state = app.state::<DailyCheckState>();
    let op = {
        let mut inner = state.0.lock().unwrap();
        let op = inner.interrupt(sleeping, Local::now().timestamp_millis());
        inner.publish(app);
        op
    };
    if let Some(id) = op {
        app.state::<CancelState>().cancel_background(&id);
    }
}

pub fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let file = app.path().app_data_dir()?.join("daily-check.json");
    let (saved, error) = match std::fs::read(&file) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(saved) => (saved, None),
            Err(e) => (Saved::default(), Some(format!("无法读取上次检查记录：{e}"))),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Saved::default(), None),
        Err(e) => (Saved::default(), Some(format!("无法读取上次检查记录：{e}"))),
    };
    let state = DailyCheckState(Arc::new(Mutex::new(Inner {
        saved,
        file,
        revision: 0,
        projects: vec![],
        credentials: Credentials::default(),
        ready: false,
        busy: false,
        running: false,
        progress: None,
        epoch: 0,
        sleeping: false,
        resume_after: Local::now().timestamp_millis() + WAKE_GRACE_MS,
        active_op: None,
        deferred_manual: None,
        persistence_error: error,
    })));
    app.manage(state.clone());
    #[cfg(target_os = "macos")]
    observe_power(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut previous = Local::now().timestamp_millis();
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let now = Local::now();
            // Fallback for platforms without a native power observer. Also handles
            // a process paused long enough that its timers need reconciliation.
            if now.timestamp_millis() - previous > 30_000 && !state.0.lock().unwrap().sleeping {
                power_changed(&app, false);
            }
            previous = now.timestamp_millis();
            let (cancel, manual) = {
                let inner = state.0.lock().unwrap();
                let cancel = inner
                    .active_op
                    .as_ref()
                    .filter(|(_, began)| {
                        inner.sleeping
                            || inner.progress.as_ref().is_some_and(|p| p.paused)
                            || now.timestamp_millis() - began > PROJECT_TIMEOUT_MS
                    })
                    .map(|(id, _)| id.clone());
                (cancel, inner.deferred_manual == Some(now.date_naive()))
            };
            if let Some(id) = cancel {
                app.state::<CancelState>().cancel_background(&id);
            }
            let _ = start(&app, &state, manual);
        }
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn observe_power(app: &tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification,
    };
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    // NSNotificationCenter retains each observer/block for this process's lifetime.
    for (name, sleeping) in unsafe {
        [
            (NSWorkspaceWillSleepNotification, true),
            (NSWorkspaceDidWakeNotification, false),
        ]
    } {
        let app = app.clone();
        let block = RcBlock::new(
            move |_: std::ptr::NonNull<objc2_foundation::NSNotification>| {
                power_changed(&app, sleeping);
            },
        );
        unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    fn at(day: u32, hour: u32, minute: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(2026, 9, day, hour, minute, 0)
            .unwrap()
    }
    fn test_inner() -> Inner {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Inner {
            saved: Saved {
                config: Config {
                    enabled: true,
                    time: "10:30".into(),
                    ..Config::default()
                },
                result: None,
            },
            file: std::env::temp_dir()
                .join(format!("gitkit-daily-{}-{nonce}.json", std::process::id())),
            revision: 0,
            projects: vec![],
            credentials: Credentials::default(),
            ready: true,
            busy: false,
            running: true,
            progress: None,
            epoch: 0,
            sleeping: false,
            resume_after: 0,
            active_op: None,
            deferred_manual: None,
            persistence_error: None,
        }
    }
    #[test]
    fn sleep_discards_partial_results_and_wake_leaves_today_due() {
        let mut inner = test_inner();
        let day = at(18, 10, 30).date_naive();
        inner.active_op = Some(("daily-check-0-0".into(), at(18, 10, 30).timestamp_millis()));
        assert_eq!(
            inner
                .interrupt(true, at(18, 10, 31).timestamp_millis())
                .as_deref(),
            Some("daily-check-0-0")
        );
        inner.interrupt(false, at(18, 11, 0).timestamp_millis());
        assert!(!inner.finish(vec![], 16, 0, false, day, at(18, 11, 0)));
        assert_eq!(inner.saved.config.last_run, 0);
        assert!(inner.saved.result.is_none());
        assert!(!inner.running);
        assert_eq!(
            inner.resume_after,
            at(18, 11, 0).timestamp_millis() + WAKE_GRACE_MS
        );
        assert!(due(&inner.saved.config, at(18, 11, 1)));
    }
    #[test]
    fn overnight_interruption_does_not_complete_or_replay_yesterdays_manual_run() {
        let mut inner = test_inner();
        inner.interrupt(false, at(19, 9, 0).timestamp_millis());
        assert!(!inner.finish(
            vec![],
            16,
            0,
            true,
            at(18, 10, 30).date_naive(),
            at(19, 9, 0)
        ));
        assert!(inner.deferred_manual.is_none());
        assert_eq!(inner.saved.config.last_run, 0);
        assert!(!due(&inner.saved.config, at(19, 9, 0)));
    }
    #[test]
    fn completed_results_survive_restart_and_sleep_without_duplicate_checks_or_credentials() {
        let mut inner = test_inner();
        inner.credentials.gitlab_token = "never-persist-this-secret".into();
        let rows = vec![Row {
            id: "one".into(),
            name: "One".into(),
            path: "/test/one".into(),
            behind: vec![],
            dirty: false,
            current_branch: "main".into(),
            error: Some("offline".into()),
        }];
        assert!(inner.finish(
            rows,
            16,
            0,
            false,
            at(18, 10, 30).date_naive(),
            at(18, 11, 0)
        ));
        assert!(inner.persistence_error.is_none());
        let bytes = std::fs::read(&inner.file).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("never-persist-this-secret"));
        let restored: Saved = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(restored.result.as_ref().unwrap().rows.len(), 1);
        assert!(!restored.result.as_ref().unwrap().viewed);
        assert!(!due(&restored.config, at(18, 15, 0)));
        inner.interrupt(true, at(18, 12, 0).timestamp_millis());
        inner.interrupt(false, at(18, 13, 0).timestamp_millis());
        assert!(!due(&inner.saved.config, at(18, 13, 0)));
        inner.saved.result.as_mut().unwrap().viewed = true;
        inner.save();
        let restored: Saved = serde_json::from_slice(&std::fs::read(&inner.file).unwrap()).unwrap();
        assert!(restored.result.unwrap().viewed);
        std::fs::remove_file(&inner.file).unwrap();
    }
    #[test]
    fn catches_up_only_today_and_never_repeats_completed_day() {
        let mut c = Config {
            enabled: true,
            time: "10:30".into(),
            ..Config::default()
        };
        assert!(!due(&c, at(18, 10, 29)));
        assert!(due(&c, at(18, 11, 0)));
        c.last_run = at(18, 11, 1).timestamp_millis();
        assert!(!due(&c, at(18, 15, 0)));
        assert!(!due(&c, at(19, 9, 0)));
        assert!(due(&c, at(19, 11, 0)));
        c.time = "14:30".into();
        assert!(!due(&c, at(18, 15, 0)));
    }
    #[test]
    fn weekends_and_disabled_schedule_are_skipped() {
        let mut c = Config {
            enabled: true,
            time: "10:30".into(),
            skip_weekends: true,
            last_run: 0,
        };
        assert!(!due(&c, at(19, 11, 0)));
        assert!(!due(&c, at(20, 11, 0)));
        assert!(due(&c, at(21, 11, 0)));
        c.enabled = false;
        assert!(!due(&c, at(21, 11, 0)));
    }
    #[test]
    fn credentials_are_host_scoped_and_respect_project_preference() {
        let credentials = Credentials {
            github: vec![
                Account {
                    id: "a".into(),
                    host: String::new(),
                    token: "first".into(),
                },
                Account {
                    id: "b".into(),
                    host: String::new(),
                    token: "preferred".into(),
                },
            ],
            preferences: [("repo".into(), "b".into())].into(),
            ..Credentials::default()
        };
        assert_eq!(
            credentials
                .token_for("repo", "git@github.com:org/repo.git")
                .as_deref(),
            Some("preferred")
        );
        assert_eq!(
            credentials
                .token_for("other", "https://github.com/org/repo")
                .as_deref(),
            Some("first")
        );
        assert_eq!(
            credentials.token_for("repo", "https://unrelated.example/repo"),
            None
        );
    }
}
