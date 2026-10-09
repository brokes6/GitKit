//! GitLab REST transport for the MR inbox. Credentials never enter public DTOs.
use reqwest::{header, Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
#[cfg(not(test))]
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Clone, Deserialize, PartialEq)]
pub struct Config {
    pub url: String,
    pub token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub message: String,
    pub kind: String,
    pub retry_after: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: u64,
    pub name: String,
    pub username: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default, alias = "public_email")]
    pub public_email: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: u64,
    pub project_id: u64,
    pub project_path_with_namespace: String,
    pub iid: u64,
    pub title: String,
    pub state: String,
    pub description: Option<String>,
    pub source_branch: String,
    pub target_branch: String,
    pub author: User,
    pub roles: Vec<String>,
    pub draft: bool,
    pub updated_at: String,
    pub sha: Option<String>,
    pub detailed_merge_status: Option<String>,
    pub web_url: String,
    pub pipeline_status: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub user: User,
    pub items: Vec<Summary>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffRefs {
    pub base_sha: String,
    pub start_sha: String,
    pub head_sha: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffVersionInfo {
    pub id: u64,
    pub created_at: String,
    pub state: String,
    pub real_size: Option<String>,
    pub refs: DiffRefs,
    // Older servers omit this documented field. A present null value means the
    // diff is still processing; retain that distinction only inside the service.
    #[serde(skip)]
    patch_id_ready: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalState {
    pub readable: bool,
    pub approved: Option<bool>,
    pub approvals_required: Option<u64>,
    pub approvals_left: Option<u64>,
    pub approved_by: Vec<User>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub summary: Summary,
    pub assignees: Vec<User>,
    pub reviewers: Vec<User>,
    pub can_manage_participants: bool,
    pub description: String,
    pub pipeline_status: Option<String>,
    pub approvals: ApprovalState,
    pub blocking_discussions_resolved: Option<bool>,
    pub can_merge: bool,
    pub can_close: bool,
    pub can_approve: bool,
    pub blocked_reasons: Vec<String>,
    pub diff_refs: Option<DiffRefs>,
    pub diff_versions: Vec<DiffVersionInfo>,
    pub squash_policy: String,
    pub squash: bool,
    pub delete_source_default: bool,
    pub delete_source_required: bool,
    pub delete_source_allowed: Option<bool>,
    pub merge_commit_message: Option<String>,
    pub squash_commit_message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub old_path: String,
    pub new_path: String,
    pub old_mode: String,
    pub new_mode: String,
    pub diff: String,
    pub new_file: bool,
    pub renamed_file: bool,
    pub deleted_file: bool,
    pub too_large: Option<bool>,
    pub collapsed: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffVersion {
    pub id: u64,
    pub created_at: String,
    pub state: String,
    pub real_size: Option<String>,
    pub refs: DiffRefs,
    pub files: Vec<DiffFile>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: u64,
    pub body: String,
    pub author: User,
    pub created_at: String,
    pub updated_at: String,
    pub system: bool,
    pub resolvable: bool,
    pub resolved: Option<bool>,
    #[serde(default)]
    pub position: Option<DiffNotePosition>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffCommentPosition {
    pub old_path: String,
    pub new_path: String,
    pub old_line: Option<u64>,
    pub new_line: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffNotePosition {
    pub base_sha: String,
    pub start_sha: String,
    pub head_sha: String,
    pub position_type: String,
    pub old_path: String,
    pub new_path: String,
    pub old_line: Option<u64>,
    pub new_line: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffCommentResult {
    /// A transport failure never authorizes replaying the non-idempotent POST.
    pub state: String,
    pub message: String,
    pub discussion: Option<Discussion>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Discussion {
    pub id: String,
    pub individual_note: bool,
    pub notes: Vec<Note>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    /// merged, pending, or uncertain; a successful HTTP status alone is not merged.
    pub state: String,
    pub message: String,
    pub summary: Option<Summary>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    /// closed, approved, updated, or uncertain; confirmed by a fresh read after the write.
    pub state: String,
    pub message: String,
    pub detail: Option<Detail>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ParticipantKind {
    Assignee,
    Reviewer,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantCandidates {
    pub users: Vec<User>,
    pub next_page: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessages {
    pub mr_id: u64,
    pub project_id: u64,
    pub iid: u64,
    pub sha: String,
    pub target_branch: String,
    pub merge_commit_message: String,
    pub squash_commit_message: String,
}

const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = 200;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_COLLECTION_BYTES: usize = 64 * 1024 * 1024;
const MAX_DIFF_FILES: usize = 10_000;
const MAX_LIST_ITEMS: usize = 5_000;
const MAX_RAW_DIFF_BYTES: usize = 64 * 1024 * 1024;

/// Kept in native code; the webview receives only the saved file's metadata.
pub struct RawDiffDownload {
    pub bytes: Vec<u8>,
    pub version_id: u64,
    pub refs: DiffRefs,
}
const MAX_COMMIT_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_PARTICIPANTS: usize = 100;
const MAX_PARTICIPANT_QUERY_BYTES: usize = 256;

const COMMIT_MESSAGES_QUERY: &str = r#"
query GitKitCommitMessages($projectPath: ID!, $iid: String!) {
  currentUser { id }
  project(fullPath: $projectPath) {
    id
    fullPath
    mergeRequest(iid: $iid) {
      id
      iid
      diffHeadSha
      sourceBranch
      targetBranch
      title
      description
      updatedAt
      defaultMergeCommitMessage
      defaultSquashCommitMessage
    }
  }
}"#;

impl ApiError {
    fn new(kind: &str, message: &str) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
            retry_after: None,
        }
    }
}

fn invalid_config() -> ApiError {
    ApiError::new(
        "invalid_config",
        "GitLab 地址配置无效，请检查账号的实例地址",
    )
}

fn invalid_response() -> ApiError {
    ApiError::new(
        "invalid_response",
        "GitLab 返回的数据不完整或格式不受支持，请刷新或在 GitLab 查看",
    )
}

fn network_error(error: reqwest::Error) -> ApiError {
    // reqwest errors may contain URLs, credentials, or server response bodies.
    if error.is_timeout() {
        ApiError::new("timeout", "GitLab 请求超时，请稍后重试")
    } else {
        ApiError::new("network", "无法连接 GitLab，请检查网络与实例地址")
    }
}

async fn response_json(
    mut response: reqwest::Response,
    is_merge: bool,
    is_approval: bool,
) -> Result<(Value, header::HeaderMap, usize), ApiError> {
    let headers = response.headers().clone();
    if !response.status().is_success() {
        return Err(status_error(
            response.status().as_u16(),
            &headers,
            is_merge,
            is_approval,
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ApiError::new(
            "invalid_response",
            "GitLab 响应超过读取上限，本次数据未完成同步",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(ApiError::new(
                "invalid_response",
                "GitLab 响应超过读取上限，本次数据未完成同步",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((
        serde_json::from_slice(&bytes).map_err(|_| invalid_response())?,
        headers,
        bytes.len(),
    ))
}

fn retry_after(value: Option<&str>) -> Option<u64> {
    let value = value?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds);
    }
    let at = chrono::DateTime::parse_from_rfc2822(value)
        .ok()?
        .timestamp();
    Some(at.saturating_sub(chrono::Utc::now().timestamp()).max(0) as u64)
}

fn status_error(
    status: u16,
    headers: &header::HeaderMap,
    is_merge: bool,
    is_approval: bool,
) -> ApiError {
    let mut error = match status {
        // GitLab's merge endpoint uses 401 for an authenticated user's missing
        // accept permission. It must not invalidate an otherwise valid account.
        401 if is_merge => ApiError::new("forbidden", "当前账号无权合并此请求，请检查目标分支权限"),
        401 if is_approval => {
            ApiError::new("forbidden", "GitLab 拒绝批准，请检查审批权限与重新认证要求")
        }
        401 => ApiError::new("unauthorized", "GitLab 认证失效，请重新连接账号"),
        403 => ApiError::new("forbidden", "当前账号无权访问此 GitLab 资源"),
        404 => ApiError::new(
            "not_found",
            "GitLab 资源不存在或当前账号无权访问，请核对仓库映射",
        ),
        429 => ApiError::new("rate_limit", "GitLab 请求受到限流，将按服务器要求稍后重试"),
        409 if is_merge || is_approval => {
            ApiError::new("conflict", "源分支已有新提交，请刷新差异并重新审阅")
        }
        400 | 405 | 406 | 422 if is_approval => ApiError::new(
            "blocked",
            "GitLab 拒绝批准，请检查审批规则或在 GitLab 完成重新认证",
        ),
        405 | 406 | 422 if is_merge => {
            ApiError::new("blocked", "GitLab 拒绝合并，请刷新检查结果后再操作")
        }
        300..=399 => ApiError::new(
            "invalid_config",
            "GitLab 地址发生重定向，请更新实例或仓库地址后重试",
        ),
        500..=599 => ApiError::new("server", "GitLab 服务暂时不可用，请稍后重试"),
        _ => ApiError::new(
            "invalid_response",
            "GitLab 拒绝请求，请检查实例版本、权限与参数",
        ),
    };
    if status == 429 {
        error.retry_after = retry_after(
            headers
                .get(header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
        );
    }
    error
}

fn client() -> Result<Client, ApiError> {
    // Local fixtures have independent Tokio runtimes and must never reach the
    // host proxy. Production contexts share one application-runtime pool.
    #[cfg(test)]
    {
        build_client(true)
    }
    #[cfg(not(test))]
    {
        static CLIENT: OnceLock<Result<Client, ApiError>> = OnceLock::new();
        CLIENT.get_or_init(|| build_client(false)).clone()
    }
}

fn build_client(ignore_proxy: bool) -> Result<Client, ApiError> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent("GitKit");
    if ignore_proxy {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|_| ApiError::new("network", "无法创建 GitLab 连接"))
}

fn unsafe_url_text(value: &str) -> bool {
    value.chars().any(char::is_control)
        || value.contains('\\')
        || value.chars().any(char::is_whitespace)
}

fn clean_segments(path: &str) -> Result<Vec<String>, ApiError> {
    let mut segments = Vec::new();
    for raw in path.trim_matches('/').split('/') {
        if raw.is_empty() {
            return Err(invalid_config());
        }
        let mut decoded = Vec::new();
        let mut i = 0;
        let bytes = raw.as_bytes();
        while i < bytes.len() {
            if bytes[i] == b'%' {
                let text = raw.get(i + 1..i + 3).ok_or_else(invalid_config)?;
                decoded.push(u8::from_str_radix(text, 16).map_err(|_| invalid_config())?);
                i += 3;
            } else {
                decoded.push(bytes[i]);
                i += 1;
            }
        }
        let decoded = String::from_utf8(decoded).map_err(|_| invalid_config())?;
        if decoded == "."
            || decoded == ".."
            || decoded.is_empty()
            || !decoded
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        {
            return Err(invalid_config());
        }
        segments.push(decoded);
    }
    Ok(segments)
}

struct Context {
    base: Url,
    token: header::HeaderValue,
    client: Client,
}

impl Context {
    fn new(config: &Config) -> Result<Self, ApiError> {
        let text = config.url.trim().trim_end_matches('/');
        if text.is_empty() || unsafe_url_text(&config.url) || !text.contains("://") {
            return Err(invalid_config());
        }
        // URL parsing normalizes dot segments. Validate the original instance
        // path first so a configured subpath cannot silently change scope.
        if let Some((_, path)) = text
            .split_once("://")
            .and_then(|(_, tail)| tail.split_once('/'))
        {
            clean_segments(path)?;
        }
        let base = Url::parse(text).map_err(|_| invalid_config())?;
        if !matches!(base.scheme(), "http" | "https")
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || text
                .split_once("://")
                .is_some_and(|(_, tail)| tail.split('/').next().unwrap_or("").contains('@'))
        {
            return Err(invalid_config());
        }
        if base.path() != "/" {
            clean_segments(base.path())?;
            // An encoded instance path is not forwarded to the Windows launcher.
            if base.path().contains('%') {
                return Err(invalid_config());
            }
        }
        let mut token =
            header::HeaderValue::from_str(config.token.trim()).map_err(|_| invalid_config())?;
        if token.is_empty() {
            return Err(ApiError::new("unauthorized", "请先连接 GitLab 账号"));
        }
        token.set_sensitive(true);
        Ok(Self {
            base,
            token,
            client: client()?,
        })
    }

    fn endpoint(&self, parts: &[&str], query: &[(&str, String)]) -> Result<Url, ApiError> {
        let mut url = self.base.clone();
        let mut segments = url.path_segments_mut().map_err(|_| invalid_config())?;
        segments.pop_if_empty().push("api").push("v4");
        for part in parts {
            segments.push(part);
        }
        drop(segments);
        if !query.is_empty() {
            url.query_pairs_mut()
                .extend_pairs(query.iter().map(|(k, v)| (*k, v.as_str())));
        }
        Ok(url)
    }

    fn web_url(&self, project_path: &str, iid: Option<u64>) -> String {
        let mut url = self.base.clone();
        let path = format!(
            "{}/{}{}",
            self.base.path().trim_end_matches('/'),
            project_path,
            iid.map(|id| format!("/-/merge_requests/{id}"))
                .unwrap_or_default()
        );
        url.set_path(&path);
        url.to_string()
    }

    async fn request(
        &self,
        method: Method,
        parts: &[&str],
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<(Value, header::HeaderMap, usize), ApiError> {
        let is_merge = method == Method::PUT && parts.last() == Some(&"merge");
        let is_approval = method == Method::POST && parts.last() == Some(&"approve");
        let is_diff_comment = method == Method::POST && parts.last() == Some(&"discussions");
        let is_participants = method == Method::PUT
            && body.as_ref().is_some_and(|body| {
                body.get("assignee_ids").is_some() || body.get("reviewer_ids").is_some()
            });
        let mut request = self
            .client
            .request(method, self.endpoint(parts, query)?)
            .header("PRIVATE-TOKEN", self.token.clone())
            .header(header::ACCEPT, "application/json");
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(network_error)?;
        if is_participants && matches!(response.status().as_u16(), 400 | 409 | 422) {
            return Err(ApiError::new(
                if response.status().as_u16() == 409 {
                    "conflict"
                } else {
                    "blocked"
                },
                "GitLab 拒绝更新指派人或审核者，请检查成员权限、实例版本与人数限制",
            ));
        }
        if is_diff_comment
            && matches!(response.status().as_u16(), 400 | 409 | 422)
        {
            return Err(ApiError::new(
                "conflict",
                "GitLab 拒绝代码行评论，请刷新差异并确认评论位置后重试",
            ));
        }
        response_json(response, is_merge, is_approval).await
    }

    async fn graphql(&self, query: &str, variables: Value) -> Result<Value, ApiError> {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|_| invalid_config())?
            .pop_if_empty()
            .push("api")
            .push("graphql");
        let mut authorization = header::HeaderValue::from_str(&format!(
            "Bearer {}",
            self.token.to_str().map_err(|_| invalid_config())?
        ))
        .map_err(|_| invalid_config())?;
        authorization.set_sensitive(true);
        let response = self
            .client
            .post(url)
            .header(header::AUTHORIZATION, authorization)
            .header(header::ACCEPT, "application/json")
            .json(&serde_json::json!({"query": query, "variables": variables}))
            .send()
            .await
            .map_err(network_error)?;
        response_json(response, false, false)
            .await
            .map(|(value, _, _)| value)
    }

    async fn get(&self, parts: &[&str], query: &[(&str, String)]) -> Result<Value, ApiError> {
        self.request(Method::GET, parts, query, None)
            .await
            .map(|(value, _, _)| value)
    }

    async fn raw_diff(&self, project: &str, iid: &str) -> Result<Vec<u8>, ApiError> {
        let mut response = self
            .client
            .get(self.endpoint(
                &["projects", project, "merge_requests", iid, "raw_diffs"],
                &[],
            )?)
            .header("PRIVATE-TOKEN", self.token.clone())
            .header(header::ACCEPT, "text/plain")
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            if matches!(response.status().as_u16(), 404 | 405 | 501) {
                return Err(ApiError::new(
                    "invalid_response",
                    "此 GitLab 实例不支持文本差异下载或当前账号无权访问，请在 GitLab 下载",
                ));
            }
            return Err(status_error(
                response.status().as_u16(),
                response.headers(),
                false,
                false,
            ));
        }
        let too_large = || {
            ApiError::new(
                "invalid_response",
                "文本差异超过 64 MiB 下载上限，请在 GitLab 下载",
            )
        };
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RAW_DIFF_BYTES as u64)
        {
            return Err(too_large());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if bytes.len().saturating_add(chunk.len()) > MAX_RAW_DIFF_BYTES {
                return Err(too_large());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    async fn pages<F>(
        &self,
        parts: &[&str],
        filters: &[(&str, String)],
        mut consume: F,
    ) -> Result<(), ApiError>
    where
        F: FnMut(Vec<Value>) -> Result<(), ApiError>,
    {
        let mut page = 1u64;
        let mut total_bytes = 0usize;
        for _ in 0..MAX_PAGES {
            let mut query = filters.to_vec();
            query.extend([
                ("per_page", PAGE_SIZE.to_string()),
                ("page", page.to_string()),
            ]);
            let endpoint = self.endpoint(parts, &query)?;
            let (value, headers, byte_count) =
                self.request(Method::GET, parts, &query, None).await?;
            total_bytes = total_bytes.saturating_add(byte_count);
            if total_bytes > MAX_COLLECTION_BYTES {
                return Err(ApiError::new(
                    "invalid_response",
                    "GitLab 分页数据超过读取上限，本次同步未完成，请在 GitLab 查看",
                ));
            }
            let Value::Array(values) = value else {
                return Err(invalid_response());
            };
            let length = values.len();
            consume(values)?;
            let next = next_page(&endpoint, &headers, page, length)?;
            match next {
                Some(next) if next > page => page = next,
                Some(_) => return Err(invalid_response()),
                None => return Ok(()),
            }
        }
        Err(ApiError::new(
            "invalid_response",
            "GitLab 列表超过分页上限，本次统计未完成；请在 GitLab 查看完整列表",
        ))
    }

    async fn user(&self) -> Result<User, ApiError> {
        let user: User = decode(self.get(&["user"], &[]).await?)?;
        if user.id == 0 || user.username.is_empty() {
            return Err(invalid_response());
        }
        Ok(user)
    }

    async fn project(&self, expected_id: u64) -> Result<RawProject, ApiError> {
        if expected_id == 0 {
            return Err(invalid_config());
        }
        let project: RawProject = decode(
            self.get(&["projects", &expected_id.to_string()], &[])
                .await?,
        )?;
        if project.id == 0
            || project.id != expected_id
            || !valid_project_path(&project.path_with_namespace)
        {
            return Err(ApiError::new(
                "invalid_config",
                "GitLab 返回的项目与请求不一致，请刷新合并请求列表",
            ));
        }
        Ok(project)
    }
}

fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, ApiError> {
    serde_json::from_value(value).map_err(|_| invalid_response())
}

fn next_page(
    endpoint: &Url,
    headers: &header::HeaderMap,
    current: u64,
    length: usize,
) -> Result<Option<u64>, ApiError> {
    if let Some(value) = headers.get("x-next-page") {
        let text = value.to_str().map_err(|_| invalid_response())?.trim();
        return if text.is_empty() {
            Ok(None)
        } else {
            let page = text.parse().map_err(|_| invalid_response())?;
            if page != current + 1 {
                return Err(invalid_response());
            }
            Ok(Some(page))
        };
    }
    if let Some(value) = headers.get(header::LINK) {
        let text = value.to_str().map_err(|_| invalid_response())?;
        for part in text.split(',') {
            let mut sections = part.split(';');
            let target = sections.next().unwrap_or("").trim();
            if !sections.any(|s| matches!(s.trim(), "rel=\"next\"" | "rel=next")) {
                continue;
            }
            let target = target
                .strip_prefix('<')
                .and_then(|s| s.strip_suffix('>'))
                .ok_or_else(invalid_response)?;
            let url = endpoint.join(target).map_err(|_| invalid_response())?;
            if url.origin() != endpoint.origin()
                || url.path() != endpoint.path()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err(invalid_response());
            }
            // Rebuild requests ourselves; never forward credentials to a Link URL.
            let expected: BTreeMap<_, _> = endpoint
                .query_pairs()
                .filter(|(k, _)| k != "page")
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            let actual: BTreeMap<_, _> = url
                .query_pairs()
                .filter(|(k, _)| k != "page")
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            if expected != actual {
                return Err(invalid_response());
            }
            let mut pages = url.query_pairs().filter(|(key, _)| key == "page");
            let page = pages
                .next()
                .and_then(|(_, value)| value.parse::<u64>().ok())
                .ok_or_else(invalid_response)?;
            if pages.next().is_some() || page != current + 1 {
                return Err(invalid_response());
            }
            return Ok(Some(page));
        }
        return Ok(None);
    }
    // Some installations strip pagination headers. A full page is not the end.
    Ok((length == PAGE_SIZE).then_some(current + 1))
}

pub fn validate_config(config: &Config) -> Result<String, ApiError> {
    let context = Context::new(config)?;
    Ok(context.base.as_str().trim_end_matches('/').to_owned())
}

fn valid_project_path(path: &str) -> bool {
    clean_segments(path).is_ok_and(|segments| segments.len() >= 2 && segments.join("/") == path)
}

/// Parse only canonical MR URLs on this configured GitLab instance. The
/// service separately binds project_id and iid to a trusted inbox record.
fn web_project_path(context: &Context, iid: u64, web_url: &str) -> Result<String, ApiError> {
    if iid == 0
        || unsafe_url_text(web_url)
        || web_url.bytes().any(|b| {
            matches!(
                b,
                b'%' | b'&' | b'|' | b'^' | b'<' | b'>' | b'"' | b'!' | b'(' | b')'
            )
        })
    {
        return Err(invalid_config());
    }
    let parsed = Url::parse(web_url).map_err(|_| invalid_config())?;
    if parsed.origin() != context.base.origin()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(invalid_config());
    }
    let prefix = format!("{}/", context.base.path().trim_end_matches('/'));
    let namespace = parsed
        .path()
        .strip_prefix(&prefix)
        .and_then(|path| path.strip_suffix(&format!("/-/merge_requests/{iid}")))
        .filter(|path| valid_project_path(path))
        .ok_or_else(invalid_config)?;
    if context.web_url(namespace, Some(iid)) != web_url {
        return Err(invalid_config());
    }
    Ok(namespace.to_owned())
}

/// Only canonical URLs on the account's configured instance reach the opener.
pub fn validated_web_url(
    config: &Config,
    project_id: u64,
    iid: u64,
    web_url: &str,
) -> Result<String, ApiError> {
    if project_id == 0 || iid == 0 || unsafe_url_text(web_url) {
        return Err(invalid_config());
    }
    let context = Context::new(config)?;
    let namespace = web_project_path(&context, iid, web_url)?;
    Ok(context.web_url(&namespace, Some(iid)))
}

#[derive(Deserialize)]
struct RawProject {
    id: u64,
    path_with_namespace: String,
    squash_option: Option<String>,
    remove_source_branch_after_merge: Option<bool>,
}

#[derive(Deserialize)]
struct RawPipeline {
    status: String,
}

#[derive(Deserialize)]
struct RawPermissions {
    can_merge: Option<bool>,
}

#[derive(Deserialize)]
struct RawRefs {
    base_sha: String,
    start_sha: String,
    head_sha: String,
}

#[derive(Deserialize)]
struct RawReferences {
    full: String,
}

#[derive(Deserialize)]
struct RawMergeRequest {
    id: u64,
    iid: u64,
    project_id: u64,
    references: Option<RawReferences>,
    web_url: Option<String>,
    title: String,
    state: String,
    description: Option<String>,
    source_branch: String,
    target_branch: String,
    author: User,
    assignees: Option<Vec<User>>,
    reviewers: Option<Vec<User>>,
    draft: Option<bool>,
    work_in_progress: Option<bool>,
    updated_at: String,
    sha: Option<String>,
    detailed_merge_status: Option<String>,
    #[serde(default)]
    head_pipeline: Option<RawPipeline>,
    user: Option<RawPermissions>,
    blocking_discussions_resolved: Option<bool>,
    has_conflicts: Option<bool>,
    diff_refs: Option<Value>,
    squash: Option<bool>,
    should_remove_source_branch: Option<bool>,
    force_remove_source_branch: Option<bool>,
    source_project_id: Option<u64>,
    merge_commit_message: Option<String>,
    squash_commit_message: Option<String>,
}

fn valid_sha(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

impl RawMergeRequest {
    fn summary(
        &self,
        context: &Context,
        user: &User,
        project: Option<&RawProject>,
        include_description: bool,
    ) -> Result<Summary, ApiError> {
        if self.id == 0
            || self.iid == 0
            || self.project_id == 0
            || project.is_some_and(|project| self.project_id != project.id)
            || self.author.id == 0
            || self.source_branch.is_empty()
            || self.target_branch.is_empty()
        {
            return Err(invalid_response());
        }
        let referenced_path = self
            .references
            .as_ref()
            .map(|references| {
                references
                    .full
                    .strip_suffix(&format!("!{}", self.iid))
                    .filter(|path| valid_project_path(path))
                    .map(str::to_owned)
                    .ok_or_else(invalid_response)
            })
            .transpose()?;
        let returned_path = self
            .web_url
            .as_ref()
            .map(|url| web_project_path(context, self.iid, url).map_err(|_| invalid_response()))
            .transpose()?;
        let namespace = project
            .map(|project| project.path_with_namespace.clone())
            .or_else(|| referenced_path.clone())
            .or_else(|| returned_path.clone())
            .ok_or_else(invalid_response)?;
        if !valid_project_path(&namespace)
            || referenced_path
                .as_ref()
                .is_some_and(|path| path != &namespace)
            || returned_path
                .as_ref()
                .is_some_and(|path| path != &namespace)
        {
            return Err(invalid_response());
        }
        let mut roles = Vec::new();
        let assignees = self.assignees.as_ref().ok_or_else(|| {
            ApiError::new(
                "unsupported",
                "此 GitLab 实例未返回完整指派关系，无法确认相关 MR 总数",
            )
        })?;
        let reviewers = self.reviewers.as_ref().ok_or_else(|| {
            ApiError::new(
                "unsupported",
                "此 GitLab 实例未返回审核人关系，无法确认相关 MR 总数",
            )
        })?;
        if self.author.id == user.id {
            roles.push("author".into());
        }
        if assignees.iter().any(|u| u.id == user.id) {
            roles.push("assignee".into());
        }
        if reviewers.iter().any(|u| u.id == user.id) {
            roles.push("reviewer".into());
        }
        Ok(Summary {
            id: self.id,
            project_id: self.project_id,
            project_path_with_namespace: namespace.clone(),
            iid: self.iid,
            title: self.title.clone(),
            state: self.state.clone(),
            description: if include_description {
                self.description.clone()
            } else {
                None
            },
            source_branch: self.source_branch.clone(),
            target_branch: self.target_branch.clone(),
            author: self.author.clone(),
            roles,
            draft: self.draft.or(self.work_in_progress).unwrap_or(false),
            updated_at: self.updated_at.clone(),
            sha: self.sha.clone().filter(|sha| valid_sha(sha)),
            detailed_merge_status: self.detailed_merge_status.clone(),
            web_url: context.web_url(&namespace, Some(self.iid)),
            pipeline_status: self.head_pipeline.as_ref().map(|p| p.status.clone()),
        })
    }
}

pub async fn list(config: &Config) -> Result<ListResult, ApiError> {
    let context = Context::new(config)?;
    let user = context.user().await?;
    list_with_context(&context, user).await
}

/// The caller owns credential-epoch invalidation. Only reuse identities that
/// list() resolved for the same unchanged account, token and instance.
pub async fn list_resolved(config: &Config, user: &User) -> Result<ListResult, ApiError> {
    let context = Context::new(config)?;
    if user.id == 0 || user.username.is_empty() {
        return Err(invalid_config());
    }
    list_with_context(&context, user.clone()).await
}

async fn list_with_context(context: &Context, user: User) -> Result<ListResult, ApiError> {
    let mut items: BTreeMap<u64, Summary> = BTreeMap::new();
    for filter in ["author_id", "assignee_id", "reviewer_id"] {
        let filters = [
            ("state", "opened".into()),
            ("scope", "all".into()),
            ("order_by", "created_at".into()),
            ("sort", "asc".into()),
            (filter, user.id.to_string()),
        ];
        context
            .pages(&["merge_requests"], &filters, |values| {
                for value in values {
                    let raw: RawMergeRequest = decode(value)?;
                    let summary = raw.summary(context, &user, None, false)?;
                    if items.get(&summary.id).is_some_and(|known| {
                        known.project_id != summary.project_id || known.iid != summary.iid
                    }) {
                        return Err(invalid_response());
                    }
                    // Filters are a discovery optimization, not an identity boundary.
                    if summary.state != "opened" || summary.roles.is_empty() {
                        items.remove(&summary.id);
                        continue;
                    }
                    items.insert(summary.id, summary);
                    if items.len() > MAX_LIST_ITEMS {
                        return Err(ApiError::new(
                            "invalid_response",
                            "相关合并请求超过读取上限，未替换已有完整列表，请在 GitLab 查看",
                        ));
                    }
                }
                Ok(())
            })
            .await?;
    }
    let mut items: Vec<_> = items.into_values().collect();
    items.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(ListResult { user, items })
}

fn unknown_approvals() -> ApprovalState {
    ApprovalState {
        readable: false,
        approved: None,
        approvals_required: None,
        approvals_left: None,
        approved_by: Vec::new(),
    }
}

async fn approvals(context: &Context, project: &str, iid: &str) -> Result<ApprovalState, ApiError> {
    let value = match context
        .get(
            &["projects", project, "merge_requests", iid, "approvals"],
            &[],
        )
        .await
    {
        Ok(value) => value,
        Err(error)
            if matches!(
                error.kind.as_str(),
                "forbidden" | "not_found" | "unsupported"
            ) =>
        {
            return Ok(unknown_approvals())
        }
        Err(error) => return Err(error),
    };
    if !value.is_object() {
        return Err(invalid_response());
    }
    let left = value.get("approvals_left").and_then(Value::as_u64);
    let required = value.get("approvals_required").and_then(Value::as_u64);
    let mut approved_by = Vec::new();
    if let Some(users) = value.get("approved_by").and_then(Value::as_array) {
        for user in users {
            approved_by.push(decode(
                user.get("user").ok_or_else(invalid_response)?.clone(),
            )?);
        }
    }
    Ok(ApprovalState {
        readable: true,
        approved: value
            .get("approved")
            .and_then(Value::as_bool)
            .or_else(|| left.map(|left| left == 0)),
        approvals_required: required,
        approvals_left: left,
        approved_by,
    })
}

fn version_info(value: &Value) -> Result<DiffVersionInfo, ApiError> {
    let string = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(invalid_response)
    };
    let refs = DiffRefs {
        base_sha: string("base_commit_sha")?,
        start_sha: string("start_commit_sha")?,
        head_sha: string("head_commit_sha")?,
    };
    if !valid_sha(&refs.base_sha) || !valid_sha(&refs.start_sha) || !valid_sha(&refs.head_sha) {
        return Err(invalid_response());
    }
    let id = value
        .get("id")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .ok_or_else(invalid_response)?;
    Ok(DiffVersionInfo {
        id,
        created_at: string("created_at")?,
        state: string("state")?,
        real_size: value.get("real_size").and_then(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .or_else(|| value.as_u64().map(|n| n.to_string()))
        }),
        refs,
        patch_id_ready: value
            .get("patch_id_sha")
            .map(|value| value.as_str().is_some_and(valid_sha)),
    })
}

fn approval_status_ready(status: Option<&str>) -> bool {
    !matches!(status, Some("checking" | "approvals_syncing"))
}

fn approval_diff_ready(versions: &[DiffVersionInfo]) -> bool {
    versions.first().is_some_and(|version| {
        version.state == "collected" && version.patch_id_ready != Some(false)
    })
}

async fn versions(
    context: &Context,
    project: &str,
    iid: &str,
) -> Result<Vec<DiffVersionInfo>, ApiError> {
    let mut versions = BTreeMap::new();
    context
        .pages(
            &["projects", project, "merge_requests", iid, "versions"],
            &[],
            |values| {
                for value in values {
                    let version = version_info(&value)?;
                    versions.insert(version.id, version);
                }
                Ok(())
            },
        )
        .await?;
    Ok(versions.into_values().rev().collect())
}

async fn source_deletion_allowed(
    context: &Context,
    request: &RawMergeRequest,
) -> Result<Option<bool>, ApiError> {
    if request.state != "opened" {
        return Ok(None);
    }
    let Some(source_project) = request.source_project_id.filter(|id| *id > 0) else {
        return Ok(None);
    };
    let value = match context
        .get(
            &[
                "projects",
                &source_project.to_string(),
                "repository",
                "branches",
                &request.source_branch,
            ],
            &[],
        )
        .await
    {
        Ok(value) => value,
        Err(error)
            if matches!(
                error.kind.as_str(),
                "forbidden" | "not_found" | "unsupported"
            ) =>
        {
            return Ok(None)
        }
        Err(error) => return Err(error),
    };
    // A protected/default branch cannot be deleted using the normal MR option.
    // can_push is the server's permission for this account on the source branch.
    let protected = value.get("protected").and_then(Value::as_bool);
    let default = value.get("default").and_then(Value::as_bool);
    let can_push = value.get("can_push").and_then(Value::as_bool);
    Ok(match (protected, default, can_push) {
        (Some(protected), Some(default), Some(can_push)) => {
            Some(!protected && !default && can_push)
        }
        _ => None,
    })
}

fn merge_status_reason(status: Option<&str>) -> Option<&'static str> {
    match status {
        Some("mergeable") => None,
        Some("unchecked" | "checking" | "preparing" | "approvals_syncing") => {
            Some("GitLab 正在计算合并条件，请稍后刷新")
        }
        Some("ci_must_pass" | "ci_still_running" | "commits_status") => {
            Some("流水线尚未满足项目合并要求")
        }
        Some("not_approved") => Some("尚未满足 GitLab 审批要求"),
        Some("discussions_not_resolved") => Some("仍有需要解决的讨论"),
        Some("conflict") => Some("源分支与目标分支存在冲突"),
        Some("need_rebase") => Some("GitLab 要求先变基源分支"),
        Some("draft_status") => Some("草稿 MR 需要先标记为准备就绪"),
        Some("requested_changes") => Some("审核人要求修改，请先处理审核意见"),
        Some("not_open") => Some("此合并请求已关闭或已合并"),
        Some("merge_request_blocked") => Some("此请求被其他合并请求阻塞"),
        Some("merge_time") => Some("尚未到项目允许的合并时间"),
        Some(_) => Some("GitLab 合并检查尚未通过，请在 GitLab 查看具体条件"),
        None => Some("此 GitLab 实例未返回详细合并条件，请在 GitLab 核对"),
    }
}

fn merge_blockers(
    request: &RawMergeRequest,
    project: &RawProject,
    approval: &ApprovalState,
) -> Vec<String> {
    let mut reasons: Vec<String> = Vec::new();
    if request.state != "opened" {
        reasons.push("此合并请求已关闭或已合并".into());
    }
    if request.draft.or(request.work_in_progress).unwrap_or(false) {
        reasons.push("草稿 MR 需要先标记为准备就绪".into());
    }
    if request.user.as_ref().and_then(|user| user.can_merge) != Some(true) {
        reasons.push("当前账号没有已确认的合并权限".into());
    }
    if let Some(reason) = merge_status_reason(request.detailed_merge_status.as_deref()) {
        reasons.push(reason.into());
    }
    if request.has_conflicts == Some(true) {
        reasons.push("源分支与目标分支存在冲突".into());
    }
    if request.sha.as_deref().is_none_or(|sha| !valid_sha(sha)) {
        reasons.push("源提交版本尚未生成，暂时无法合并".into());
    }
    // GitLab's detailed status is authoritative. Nullable CI/discussion
    // summaries cannot be used to invent a missing server merge condition.
    if approval.approvals_left.is_some_and(|left| left > 0) {
        reasons.push("尚未满足 GitLab 审批要求".into());
    }
    if !matches!(
        project.squash_option.as_deref(),
        Some("never" | "always" | "default_on" | "default_off")
    ) {
        reasons.push("此 GitLab 实例未返回 Squash 配置，请在 GitLab 核对".into());
    }
    let mut seen = HashSet::new();
    reasons.retain(|reason| seen.insert(reason.clone()));
    reasons
}

async fn load_detail(
    context: &Context,
    project_id: u64,
    iid: u64,
    with_versions: bool,
) -> Result<(Detail, User, RawProject), ApiError> {
    if project_id == 0 || iid == 0 {
        return Err(invalid_config());
    }
    let user = context.user().await?;
    let project = context.project(project_id).await?;
    let pid = project_id.to_string();
    let iid = iid.to_string();
    let request: RawMergeRequest = decode(
        context
            .get(&["projects", &pid, "merge_requests", &iid], &[])
            .await?,
    )?;
    let summary = request.summary(context, &user, Some(&project), true)?;
    if request.iid.to_string() != iid {
        return Err(invalid_response());
    }
    let approvals = approvals(context, &pid, &iid).await?;
    let diff_versions = if with_versions {
        versions(context, &pid, &iid).await?
    } else {
        Vec::new()
    };
    let delete_source_allowed = source_deletion_allowed(context, &request).await?;
    let blocked_reasons = merge_blockers(&request, &project, &approvals);
    let delete_source_required = request.force_remove_source_branch.unwrap_or(false);
    let diff_refs = request
        .diff_refs
        .and_then(|value| decode::<RawRefs>(value).ok())
        .filter(|refs| {
            valid_sha(&refs.base_sha) && valid_sha(&refs.start_sha) && valid_sha(&refs.head_sha)
        })
        .map(|refs| DiffRefs {
            base_sha: refs.base_sha,
            start_sha: refs.start_sha,
            head_sha: refs.head_sha,
        });
    let squash_policy = project
        .squash_option
        .clone()
        .unwrap_or_else(|| "unknown".into());
    let squash = match squash_policy.as_str() {
        "always" => true,
        "never" => false,
        _ => request.squash.unwrap_or(squash_policy == "default_on"),
    };
    let detail = Detail {
        assignees: request.assignees.clone().ok_or_else(invalid_response)?,
        reviewers: request.reviewers.clone().ok_or_else(invalid_response)?,
        can_manage_participants: summary.state == "opened" && summary.author.id == user.id,
        can_close: summary.state == "opened" && summary.author.id == user.id,
        can_approve: summary.state == "opened"
            && summary.author.id != user.id
            && summary.roles.iter().any(|role| role == "reviewer")
            && approval_status_ready(summary.detailed_merge_status.as_deref())
            && (!with_versions || approval_diff_ready(&diff_versions))
            && approvals.readable
            && !approvals
                .approved_by
                .iter()
                .any(|approved| approved.id == user.id),
        pipeline_status: summary.pipeline_status.clone(),
        summary,
        description: request.description.unwrap_or_default(),
        approvals,
        blocking_discussions_resolved: request.blocking_discussions_resolved,
        can_merge: blocked_reasons.is_empty(),
        blocked_reasons,
        diff_refs,
        diff_versions,
        squash_policy,
        squash,
        delete_source_default: delete_source_required
            || request
                .should_remove_source_branch
                .unwrap_or(project.remove_source_branch_after_merge.unwrap_or(false)),
        delete_source_required,
        delete_source_allowed,
        merge_commit_message: request.merge_commit_message,
        squash_commit_message: request.squash_commit_message,
    };
    Ok((detail, user, project))
}

pub async fn detail(config: &Config, project_id: u64, iid: u64) -> Result<Detail, ApiError> {
    let context = Context::new(config)?;
    load_detail(&context, project_id, iid, true)
        .await
        .map(|(detail, _, _)| detail)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCommitMessages {
    id: String,
    iid: String,
    diff_head_sha: Option<String>,
    source_branch: String,
    target_branch: String,
    title: String,
    description: Option<String>,
    updated_at: String,
    default_merge_commit_message: Option<String>,
    default_squash_commit_message: Option<String>,
}

fn unavailable_commit_messages() -> ApiError {
    ApiError::new(
        "unsupported",
        "无法读取 GitLab 默认提交消息，请检查实例版本与权限",
    )
}

fn same_timestamp(left: &str, right: &str) -> bool {
    left == right
        || chrono::DateTime::parse_from_rfc3339(left)
            .ok()
            .zip(chrono::DateTime::parse_from_rfc3339(right).ok())
            .is_some_and(|(left, right)| left == right)
}

fn same_graphql_timestamp(graphql: &str, rest: &str) -> bool {
    // GitLab's GraphQL Time scalar uses iso8601 without fractional seconds,
    // while REST retains milliseconds. Compare only their shared precision;
    // REST-to-REST cache revision checks must keep using same_timestamp.
    chrono::DateTime::parse_from_rfc3339(graphql)
        .ok()
        .zip(chrono::DateTime::parse_from_rfc3339(rest).ok())
        .is_some_and(|(graphql, rest)| graphql.timestamp() == rest.timestamp())
}

pub fn same_message_revision(left: &Summary, right: &Summary) -> bool {
    left.id == right.id
        && left.project_id == right.project_id
        && left.iid == right.iid
        && left.project_path_with_namespace == right.project_path_with_namespace
        && left.sha == right.sha
        && left.source_branch == right.source_branch
        && left.target_branch == right.target_branch
        && left.title == right.title
        && left.description == right.description
        && same_timestamp(&left.updated_at, &right.updated_at)
}

/// Ask GitLab to expand its own project templates, including user-visible issues
/// and commit data. Never approximate this with client-side string substitution.
pub async fn commit_messages(
    config: &Config,
    known: &Summary,
    user_id: u64,
) -> Result<CommitMessages, ApiError> {
    if known.id == 0
        || known.project_id == 0
        || known.iid == 0
        || user_id == 0
        || !valid_project_path(&known.project_path_with_namespace)
    {
        return Err(invalid_config());
    }
    if known.state != "opened" || known.sha.as_deref().is_none_or(|sha| !valid_sha(sha)) {
        return Err(ApiError::new(
            "blocked",
            "请先加载开放合并请求的有效源提交版本",
        ));
    }
    let context = Context::new(config)?;
    let value = context
        .graphql(
            COMMIT_MESSAGES_QUERY,
            serde_json::json!({
                "projectPath": known.project_path_with_namespace,
                "iid": known.iid.to_string(),
            }),
        )
        .await?;
    // GraphQL may return partial data alongside HTTP 200 errors. Do not expose
    // raw errors (which can include server internals) or accept a partial editor.
    if value
        .get("errors")
        .is_some_and(|errors| errors.as_array().is_none_or(|errors| !errors.is_empty()))
    {
        return Err(unavailable_commit_messages());
    }
    let data = value
        .get("data")
        .filter(|data| data.is_object())
        .ok_or_else(unavailable_commit_messages)?;
    let current_user = data
        .get("currentUser")
        .and_then(|user| user.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(unavailable_commit_messages)?;
    if current_user != format!("gid://gitlab/User/{user_id}") {
        return Err(ApiError::new(
            "stale",
            "GitLab 当前账号身份已变化，请重新连接账号",
        ));
    }
    let project = data
        .get("project")
        .filter(|project| project.is_object())
        .ok_or_else(unavailable_commit_messages)?;
    if project.get("id").and_then(Value::as_str)
        != Some(format!("gid://gitlab/Project/{}", known.project_id).as_str())
        || project.get("fullPath").and_then(Value::as_str)
            != Some(known.project_path_with_namespace.as_str())
    {
        return Err(invalid_response());
    }
    let request: RawCommitMessages = decode(
        project
            .get("mergeRequest")
            .filter(|request| request.is_object())
            .ok_or_else(unavailable_commit_messages)?
            .clone(),
    )?;
    if request.id != format!("gid://gitlab/MergeRequest/{}", known.id)
        || request.iid != known.iid.to_string()
    {
        return Err(invalid_response());
    }
    if request.diff_head_sha != known.sha
        || request.target_branch != known.target_branch
        || request.source_branch != known.source_branch
        || request.title != known.title
        || request.description != known.description
        || !same_graphql_timestamp(&request.updated_at, &known.updated_at)
    {
        return Err(ApiError::new(
            "conflict",
            "合并请求已变化，请刷新后重新加载默认提交消息",
        ));
    }
    let message = |message: Option<String>| -> Result<String, ApiError> {
        message
            .filter(|message| {
                !message.trim().is_empty() && message.len() <= MAX_COMMIT_MESSAGE_BYTES
            })
            .ok_or_else(unavailable_commit_messages)
    };
    Ok(CommitMessages {
        mr_id: known.id,
        project_id: known.project_id,
        iid: known.iid,
        sha: request
            .diff_head_sha
            .ok_or_else(unavailable_commit_messages)?,
        target_branch: request.target_branch,
        merge_commit_message: message(request.default_merge_commit_message)?,
        squash_commit_message: message(request.default_squash_commit_message)?,
    })
}

/// Automatic status refresh skips the potentially paginated version history.
/// Reuse it only for the same MR and unchanged diff revision; a changed revision
/// must be fetched through detail() before reviewing or selecting its version.
pub async fn detail_status(
    config: &Config,
    project_id: u64,
    iid: u64,
    known: &Detail,
) -> Result<Detail, ApiError> {
    if known.summary.project_id != project_id || known.summary.iid != iid {
        return Err(invalid_config());
    }
    let context = Context::new(config)?;
    let (mut detail, _, _) = load_detail(&context, project_id, iid, false).await?;
    if detail.diff_refs.is_some()
        && detail.diff_refs == known.diff_refs
        && detail.summary.sha == known.summary.sha
    {
        detail.diff_versions = known.diff_versions.clone();
    }
    detail.can_approve &= approval_diff_ready(&detail.diff_versions);
    Ok(detail)
}

#[derive(Deserialize)]
struct RawDiffFile {
    old_path: String,
    new_path: String,
    a_mode: String,
    b_mode: String,
    #[serde(default)]
    diff: String,
    new_file: bool,
    renamed_file: bool,
    deleted_file: bool,
    too_large: Option<bool>,
    collapsed: Option<bool>,
}

pub async fn diffs(
    config: &Config,
    project_id: u64,
    iid: u64,
    version_id: u64,
) -> Result<DiffVersion, ApiError> {
    if project_id == 0 || iid == 0 || version_id == 0 {
        return Err(invalid_config());
    }
    let context = Context::new(config)?;
    context.project(project_id).await?;
    let value = context
        .get(
            &[
                "projects",
                &project_id.to_string(),
                "merge_requests",
                &iid.to_string(),
                "versions",
                &version_id.to_string(),
            ],
            &[],
        )
        .await?;
    diff_version(value, version_id)
}

fn diff_version(value: Value, version_id: u64) -> Result<DiffVersion, ApiError> {
    let info = version_info(&value)?;
    if info.id != version_id {
        return Err(invalid_response());
    }
    // This endpoint is a fixed version object. Its embedded diffs are subject to
    // GitLab's diff limits, not a paginated current-HEAD /diffs connection.
    let diffs = value
        .get("diffs")
        .and_then(Value::as_array)
        .ok_or_else(invalid_response)?;
    if diffs.len() > MAX_DIFF_FILES {
        return Err(ApiError::new(
            "invalid_response",
            "差异文件超过读取上限，请在 GitLab 查看",
        ));
    }
    let mut files = Vec::with_capacity(diffs.len());
    for value in diffs {
        let file: RawDiffFile = decode(value.clone())?;
        files.push(DiffFile {
            old_path: file.old_path,
            new_path: file.new_path,
            old_mode: file.a_mode,
            new_mode: file.b_mode,
            diff: file.diff,
            new_file: file.new_file,
            renamed_file: file.renamed_file,
            deleted_file: file.deleted_file,
            too_large: file.too_large,
            collapsed: file.collapsed,
        });
    }
    let truncated = info.state != "collected"
        || info
            .real_size
            .as_ref()
            .and_then(|size| size.parse::<usize>().ok())
            .is_some_and(|size| size > files.len())
        || files
            .iter()
            .any(|file| file.too_large == Some(true) || file.collapsed == Some(true));
    Ok(DiffVersion {
        id: info.id,
        created_at: info.created_at,
        state: info.state,
        real_size: info.real_size,
        refs: info.refs,
        files,
        truncated,
    })
}

async fn download_revision(
    context: &Context,
    user: &User,
    project: &RawProject,
    mr_id: u64,
    iid: u64,
    expected_target_branch: &str,
    reviewed_version_id: u64,
    reviewed_refs: &DiffRefs,
) -> Result<DiffVersionInfo, ApiError> {
    let pid = project.id.to_string();
    let iid_text = iid.to_string();
    let request: RawMergeRequest = decode(
        context
            .get(&["projects", &pid, "merge_requests", &iid_text], &[])
            .await?,
    )?;
    let summary = request.summary(context, user, Some(project), false)?;
    if summary.id != mr_id || summary.iid != iid {
        return Err(invalid_response());
    }
    let refs: RawRefs = request
        .diff_refs
        .and_then(|value| decode(value).ok())
        .ok_or_else(invalid_response)?;
    let refs = DiffRefs {
        base_sha: refs.base_sha,
        start_sha: refs.start_sha,
        head_sha: refs.head_sha,
    };
    let latest = versions(context, &pid, &iid_text)
        .await?
        .into_iter()
        .next()
        .ok_or_else(invalid_response)?;
    if expected_target_branch.is_empty()
        || summary.target_branch != expected_target_branch
        || summary.sha.as_deref() != Some(reviewed_refs.head_sha.as_str())
        || refs != *reviewed_refs
        || latest.id != reviewed_version_id
        || latest.refs != *reviewed_refs
    {
        return Err(ApiError::new(
            "conflict",
            "下载期间远程差异版本或比较范围已变化，请刷新后重新下载",
        ));
    }
    if latest.state != "collected" || latest.patch_id_ready == Some(false) {
        return Err(ApiError::new(
            "blocked",
            "GitLab 差异尚未准备完成或受到服务器限制，请稍后重试或在 GitLab 下载",
        ));
    }
    Ok(latest)
}

/// raw_diffs has no version parameter. Verify its current revision on both
/// sides of the download rather than exporting the UI's limited file objects.
pub async fn download_diff(
    config: &Config,
    mr_id: u64,
    project_id: u64,
    iid: u64,
    expected_target_branch: &str,
    reviewed_version_id: u64,
    reviewed_refs: &DiffRefs,
) -> Result<RawDiffDownload, ApiError> {
    if mr_id == 0
        || project_id == 0
        || iid == 0
        || reviewed_version_id == 0
        || !valid_sha(&reviewed_refs.base_sha)
        || !valid_sha(&reviewed_refs.start_sha)
        || !valid_sha(&reviewed_refs.head_sha)
    {
        return Err(ApiError::new("conflict", "请先加载有效的差异版本后再下载"));
    }
    let context = Context::new(config)?;
    let user = context.user().await?;
    let project = context.project(project_id).await?;
    let before = download_revision(
        &context,
        &user,
        &project,
        mr_id,
        iid,
        expected_target_branch,
        reviewed_version_id,
        reviewed_refs,
    )
    .await?;
    let expected_files = before
        .real_size
        .as_deref()
        .and_then(|size| size.parse::<usize>().ok())
        .ok_or_else(|| {
            ApiError::new(
                "invalid_response",
                "无法确认 GitLab 差异文件数量，请刷新后重试或在 GitLab 下载",
            )
        })?;
    let bytes = context
        .raw_diff(&project_id.to_string(), &iid.to_string())
        .await?;
    let after = download_revision(
        &context,
        &user,
        &project,
        mr_id,
        iid,
        expected_target_branch,
        reviewed_version_id,
        reviewed_refs,
    )
    .await?;
    let files = bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| line.starts_with(b"diff --git "))
        .count();
    if before.real_size != after.real_size
        || files != expected_files
        || (expected_files > 0 && !bytes.starts_with(b"diff --git "))
        || (expected_files == 0 && !bytes.is_empty())
    {
        return Err(ApiError::new(
            "invalid_response",
            "GitLab 返回的文本差异不完整或格式不受支持，请在 GitLab 下载",
        ));
    }
    // Even this original response is governed by GitLab's server diff limits.
    // Preserve it byte for byte, including rename/mode and binary-file notices.
    Ok(RawDiffDownload {
        bytes,
        version_id: after.id,
        refs: after.refs,
    })
}

#[derive(Deserialize)]
struct RawNote {
    id: u64,
    body: String,
    author: User,
    created_at: String,
    updated_at: String,
    system: bool,
    resolvable: bool,
    resolved: Option<bool>,
    position: Option<Value>,
}

#[derive(Deserialize)]
struct RawDiscussion {
    id: String,
    individual_note: bool,
    notes: Vec<RawNote>,
}

fn note_position(value: Value) -> Option<DiffNotePosition> {
    let text = |key: &str| value.get(key)?.as_str().map(str::to_owned);
    let position = DiffNotePosition {
        base_sha: text("base_sha")?,
        start_sha: text("start_sha")?,
        head_sha: text("head_sha")?,
        position_type: text("position_type")?,
        old_path: text("old_path")?,
        new_path: text("new_path")?,
        old_line: value.get("old_line").and_then(Value::as_u64),
        new_line: value.get("new_line").and_then(Value::as_u64),
    };
    (position.position_type == "text"
        && valid_sha(&position.base_sha)
        && valid_sha(&position.start_sha)
        && valid_sha(&position.head_sha))
    .then_some(position)
}

fn discussion(value: Value) -> Result<Discussion, ApiError> {
    let raw: RawDiscussion = decode(value)?;
    if raw.id.is_empty() {
        return Err(invalid_response());
    }
    Ok(Discussion {
        id: raw.id,
        individual_note: raw.individual_note,
        notes: raw
            .notes
            .into_iter()
            .map(|note| Note {
                id: note.id,
                body: note.body,
                author: note.author,
                created_at: note.created_at,
                updated_at: note.updated_at,
                system: note.system,
                resolvable: note.resolvable,
                resolved: note.resolved,
                position: note.position.and_then(note_position),
            })
            .collect(),
    })
}

pub async fn discussions(
    config: &Config,
    project_id: u64,
    iid: u64,
) -> Result<Vec<Discussion>, ApiError> {
    if project_id == 0 || iid == 0 {
        return Err(invalid_config());
    }
    let context = Context::new(config)?;
    context.project(project_id).await?;
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    context
        .pages(
            &[
                "projects",
                &project_id.to_string(),
                "merge_requests",
                &iid.to_string(),
                "discussions",
            ],
            &[],
            |values| {
                for value in values {
                    let discussion = discussion(value)?;
                    if !seen.insert(discussion.id.clone()) {
                        continue;
                    }
                    result.push(discussion);
                }
                Ok(())
            },
        )
        .await?;
    Ok(result)
}

fn diff_contains_position(file: &DiffFile, position: &DiffCommentPosition) -> bool {
    if file.too_large == Some(true) || file.collapsed == Some(true) {
        return false;
    }
    let range = |text: &str, prefix: char| -> Option<(u64, u64)> {
        let text = text.strip_prefix(prefix)?;
        let (start, count) = text.split_once(',').unwrap_or((text, "1"));
        let start: u64 = start.parse().ok()?;
        let count: u64 = count.parse().ok()?;
        (start <= u32::MAX as u64 && count <= u32::MAX as u64).then_some((start, count))
    };
    let mut cursor = None;
    for line in file.diff.lines() {
        if line.starts_with("@@ ") {
            let mut parts = line.split_whitespace();
            let parsed = (|| {
                if parts.next()? != "@@" {
                    return None;
                }
                let (old, old_left) = range(parts.next()?, '-')?;
                let (new, new_left) = range(parts.next()?, '+')?;
                if parts.next()? != "@@" {
                    return None;
                }
                Some((old, new, old_left, new_left))
            })();
            cursor = parsed;
            continue;
        }
        let Some((old, new, old_left, new_left)) = cursor.as_mut() else {
            continue;
        };
        let (old_line, new_line) = match line.as_bytes().first() {
            Some(b' ') if *old_left > 0 && *new_left > 0 => (Some(*old), Some(*new)),
            Some(b'-') if *old_left > 0 => (Some(*old), None),
            Some(b'+') if *new_left > 0 => (None, Some(*new)),
            Some(b'\\') => continue,
            _ => {
                cursor = None;
                continue;
            }
        };
        if position.old_line == old_line && position.new_line == new_line {
            return true;
        }
        if old_line.is_some() {
            *old += 1;
            *old_left -= 1;
        }
        if new_line.is_some() {
            *new += 1;
            *new_left -= 1;
        }
    }
    false
}

pub fn uncertain_diff_comment() -> DiffCommentResult {
    DiffCommentResult {
        state: "uncertain".into(),
        message: "评论是否已添加尚未确认，请到 GitLab 核实，勿重复提交".into(),
        discussion: None,
    }
}

/// Create one text diff thread against the reviewed latest version. The final
/// context check prevents a credentials/sleep change during preflight from
/// sending a comment under the previous account context.
pub async fn create_diff_comment(
    config: &Config,
    mr_id: u64,
    project_id: u64,
    iid: u64,
    expected_user_id: u64,
    reviewed_version_id: u64,
    reviewed_refs: &DiffRefs,
    expected_target_branch: &str,
    position: &DiffCommentPosition,
    body: &str,
    before_write: impl Fn() -> Result<(), ApiError>,
) -> Result<DiffCommentResult, ApiError> {
    let body = body.trim();
    if body.is_empty() || body.len() > 1024 * 1024 {
        return Err(ApiError::new(
            "invalid_input",
            "请输入评论内容，且不超过 1 MiB",
        ));
    }
    if mr_id == 0
        || project_id == 0
        || iid == 0
        || expected_user_id == 0
        || reviewed_version_id == 0
        || !valid_sha(&reviewed_refs.base_sha)
        || !valid_sha(&reviewed_refs.start_sha)
        || !valid_sha(&reviewed_refs.head_sha)
        || position.old_path.is_empty()
        || position.new_path.is_empty()
        || position.old_path.contains('\0')
        || position.new_path.contains('\0')
        || (position.old_line.is_none() && position.new_line.is_none())
        || position
            .old_line
            .is_some_and(|line| line == 0 || line > u32::MAX as u64)
        || position
            .new_line
            .is_some_and(|line| line == 0 || line > u32::MAX as u64)
    {
        return Err(ApiError::new(
            "conflict",
            "评论位置无效，请刷新差异后重新选择代码行",
        ));
    }
    let context = Context::new(config)?;
    let user = context.user().await?;
    if user.id != expected_user_id {
        return Err(ApiError::new(
            "stale",
            "GitLab 账号身份已变化，请重新连接账号",
        ));
    }
    let project = context.project(project_id).await?;
    let pid = project_id.to_string();
    let iid_text = iid.to_string();
    let request: RawMergeRequest = decode(
        context
            .get(&["projects", &pid, "merge_requests", &iid_text], &[])
            .await?,
    )?;
    let summary = request.summary(&context, &user, Some(&project), false)?;
    if summary.id != mr_id || summary.project_id != project_id || summary.iid != iid {
        return Err(invalid_response());
    }
    let current_refs = request
        .diff_refs
        .and_then(|refs| decode::<RawRefs>(refs).ok());
    if summary.sha.as_deref() != Some(reviewed_refs.head_sha.as_str())
        || expected_target_branch.is_empty()
        || summary.target_branch != expected_target_branch
        || current_refs.is_none_or(|refs| {
            refs.base_sha != reviewed_refs.base_sha
                || refs.start_sha != reviewed_refs.start_sha
                || refs.head_sha != reviewed_refs.head_sha
        })
    {
        return Err(ApiError::new(
            "conflict",
            "远程差异版本或比较范围已变化，请刷新后重新选择评论位置",
        ));
    }
    let revisions = versions(&context, &pid, &iid_text).await?;
    if revisions.first().is_none_or(|revision| {
        revision.id != reviewed_version_id || revision.refs != *reviewed_refs
    }) {
        return Err(ApiError::new(
            "conflict",
            "远程差异版本已变化，请刷新后重新选择评论位置",
        ));
    }
    let revision = diff_version(
        context
            .get(
                &[
                    "projects",
                    &pid,
                    "merge_requests",
                    &iid_text,
                    "versions",
                    &reviewed_version_id.to_string(),
                ],
                &[],
            )
            .await?,
        reviewed_version_id,
    )?;
    if revision.refs != *reviewed_refs
        || !matches!(revision.state.as_str(), "collected" | "overflow")
        || !revision.files.iter().any(|file| {
            file.old_path == position.old_path
                && file.new_path == position.new_path
                && diff_contains_position(file, position)
        })
    {
        return Err(ApiError::new(
            "conflict",
            "评论位置不在当前差异中，请刷新后重新选择代码行",
        ));
    }
    let expected_position = DiffNotePosition {
        base_sha: reviewed_refs.base_sha.clone(),
        start_sha: reviewed_refs.start_sha.clone(),
        head_sha: reviewed_refs.head_sha.clone(),
        position_type: "text".into(),
        old_path: position.old_path.clone(),
        new_path: position.new_path.clone(),
        old_line: position.old_line,
        new_line: position.new_line,
    };
    let mut payload = serde_json::json!({
        "position_type": "text", "base_sha": reviewed_refs.base_sha, "start_sha": reviewed_refs.start_sha, "head_sha": reviewed_refs.head_sha,
        "old_path": position.old_path, "new_path": position.new_path,
    });
    if let Some(line) = position.old_line {
        payload["old_line"] = line.into();
    }
    if let Some(line) = position.new_line {
        payload["new_line"] = line.into();
    }
    before_write()?;
    let write = context
        .request(
            Method::POST,
            &["projects", &pid, "merge_requests", &iid_text, "discussions"],
            &[],
            Some(serde_json::json!({"body": body, "position": payload})),
        )
        .await;
    match write {
        Ok((value, _, _)) => match discussion(value) {
            Ok(discussion)
                if discussion.notes.iter().any(|note| {
                    note.id > 0
                        && !note.system
                        && note.body == body
                        && note.author.id == user.id
                        && note.position.as_ref() == Some(&expected_position)
                }) =>
            {
                Ok(DiffCommentResult {
                    state: "created".into(),
                    message: "评论已添加".into(),
                    discussion: Some(discussion),
                })
            }
            _ => Ok(uncertain_diff_comment()),
        },
        Err(error) if uncertain_transport(&error) => Ok(uncertain_diff_comment()),
        Err(error) => Err(error),
    }
}

fn validate_review(
    detail: &Detail,
    reviewed_sha: &str,
    expected_target_branch: &str,
    reviewed_version_id: u64,
    reviewed_refs: &DiffRefs,
) -> Result<(), ApiError> {
    if !valid_sha(reviewed_sha) {
        return Err(ApiError::new("conflict", "请先加载并审阅有效的源提交版本"));
    }
    if detail.summary.sha.as_deref() != Some(reviewed_sha) {
        return Err(ApiError::new(
            "conflict",
            "源分支已有新提交，请刷新差异并重新审阅",
        ));
    }
    if expected_target_branch.is_empty() || detail.summary.target_branch != expected_target_branch {
        return Err(ApiError::new(
            "conflict",
            "合并目标分支已变化，请刷新并重新确认目标",
        ));
    }
    if reviewed_version_id == 0
        || reviewed_refs.head_sha != reviewed_sha
        || detail.diff_refs.as_ref() != Some(reviewed_refs)
        || detail.diff_versions.first().is_none_or(|version| {
            version.id != reviewed_version_id || version.refs != *reviewed_refs
        })
    {
        return Err(ApiError::new(
            "conflict",
            "远程差异版本或比较范围已变化，请刷新并重新审阅",
        ));
    }
    Ok(())
}

pub async fn merge(
    config: &Config,
    project_id: u64,
    iid: u64,
    reviewed_sha: &str,
    expected_target_branch: &str,
    reviewed_version_id: u64,
    reviewed_refs: &DiffRefs,
    squash: bool,
    delete_source: bool,
    merge_commit_message: Option<&str>,
    squash_commit_message: Option<&str>,
) -> Result<MergeResult, ApiError> {
    if !valid_sha(reviewed_sha) {
        return Err(ApiError::new("conflict", "请先加载并审阅有效的源提交版本"));
    }
    let context = Context::new(config)?;
    let (detail, user, project) = load_detail(&context, project_id, iid, true).await?;
    validate_review(
        &detail,
        reviewed_sha,
        expected_target_branch,
        reviewed_version_id,
        reviewed_refs,
    )?;
    if !detail.can_merge {
        return Err(ApiError::new(
            "blocked",
            "GitLab 合并条件尚未满足，请刷新检查结果",
        ));
    }
    if (detail.squash_policy == "always" && !squash) || (detail.squash_policy == "never" && squash)
    {
        return Err(ApiError::new(
            "blocked",
            "所选 Squash 选项与 GitLab 项目策略不一致",
        ));
    }
    if detail.delete_source_required && !delete_source {
        return Err(ApiError::new(
            "blocked",
            "GitLab 项目要求删除源分支，请确认该选项",
        ));
    }
    if delete_source && detail.delete_source_allowed != Some(true) {
        return Err(ApiError::new(
            "blocked",
            "当前未确认删除源分支的权限，请在 GitLab 核对",
        ));
    }
    let pid = project_id.to_string();
    let iid_text = iid.to_string();
    let mut body = serde_json::json!({ "sha": reviewed_sha, "squash": squash, "should_remove_source_branch": delete_source });
    // Omitting untouched messages preserves GitLab's own project templates.
    for (key, message) in [
        ("merge_commit_message", merge_commit_message),
        (
            "squash_commit_message",
            squash_commit_message.filter(|_| squash),
        ),
    ] {
        if let Some(message) = message.filter(|message| !message.trim().is_empty()) {
            if message.len() > MAX_COMMIT_MESSAGE_BYTES {
                return Err(ApiError::new("blocked", "提交消息过长，请缩短后再合并"));
            }
            body[key] = Value::String(message.to_owned());
        }
    }
    let value = context
        .request(
            Method::PUT,
            &["projects", &pid, "merge_requests", &iid_text, "merge"],
            &[],
            Some(body),
        )
        .await;
    match value {
        Ok((value, _, _)) => {
            let summary = decode::<RawMergeRequest>(value)
                .and_then(|request| request.summary(&context, &user, Some(&project), false));
            match summary {
                Ok(summary) if summary.iid == iid => {
                    let merged =
                        summary.state == "merged" && summary.sha.as_deref() == Some(reviewed_sha);
                    Ok(MergeResult {
                        state: if merged { "merged" } else { "pending" }.into(),
                        message: if merged {
                            "GitLab 已确认合并完成"
                        } else {
                            "GitLab 已接收请求，正在确认合并结果"
                        }
                        .into(),
                        summary: Some(summary),
                    })
                }
                _ => reconcile_merge(&context, &project, &user, iid, reviewed_sha).await,
            }
        }
        Err(error)
            if matches!(
                error.kind.as_str(),
                "network" | "timeout" | "server" | "invalid_response"
            ) =>
        {
            // The request may have reached GitLab. Query once; never replay PUT.
            reconcile_merge(&context, &project, &user, iid, reviewed_sha).await
        }
        Err(error) => Err(error),
    }
}

fn action_identity(detail: &Detail, mr_id: u64, project_id: u64, iid: u64) -> bool {
    detail.summary.id == mr_id
        && detail.summary.project_id == project_id
        && detail.summary.iid == iid
}

fn uncertain_action(message: &str, detail: Option<Detail>) -> ActionResult {
    ActionResult {
        state: "uncertain".into(),
        message: message.into(),
        detail,
    }
}

fn uncertain_transport(error: &ApiError) -> bool {
    matches!(
        error.kind.as_str(),
        "network" | "timeout" | "server" | "invalid_response"
    )
}

#[derive(Deserialize)]
struct RawMember {
    #[serde(flatten)]
    user: User,
    state: String,
    locked: Option<bool>,
    expires_at: Option<String>,
    access_level: u64,
}

impl RawMember {
    fn eligible(&self) -> bool {
        self.user.id > 0
            && !self.user.username.is_empty()
            && self.state == "active"
            && self.locked != Some(true)
            && self.access_level > 0
            && self.expires_at.as_ref().is_none_or(|date| {
                chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .is_ok_and(|date| date >= chrono::Utc::now().date_naive())
            })
    }
}

fn participant_ids(ids: &[u64]) -> Result<Vec<u64>, ApiError> {
    if ids.len() > MAX_PARTICIPANTS || ids.contains(&0) {
        return Err(ApiError::new("invalid_input", "成员选择无效或人数超过上限"));
    }
    let mut ids = ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

impl ParticipantKind {
    fn users<'a>(self, assignees: &'a [User], reviewers: &'a [User]) -> &'a [User] {
        match self {
            Self::Assignee => assignees,
            Self::Reviewer => reviewers,
        }
    }

    fn field(self) -> &'static str {
        match self {
            Self::Assignee => "assignee_ids",
            Self::Reviewer => "reviewer_ids",
        }
    }
}

/// This gate always reads both token identity and the MR from GitLab. Cached
/// frontend permissions cannot authorize changing another author's MR.
async fn participant_request(
    context: &Context,
    mr_id: u64,
    project_id: u64,
    iid: u64,
) -> Result<(RawMergeRequest, User), ApiError> {
    if mr_id == 0 || project_id == 0 || iid == 0 {
        return Err(invalid_config());
    }
    let user = context.user().await?;
    let project = context.project(project_id).await?;
    let request: RawMergeRequest = decode(
        context
            .get(
                &[
                    "projects",
                    &project_id.to_string(),
                    "merge_requests",
                    &iid.to_string(),
                ],
                &[],
            )
            .await?,
    )?;
    let summary = request.summary(context, &user, Some(&project), false)?;
    if summary.id != mr_id || summary.iid != iid || summary.project_id != project_id {
        return Err(invalid_response());
    }
    if summary.author.id != user.id || summary.state != "opened" {
        return Err(ApiError::new(
            "blocked",
            "仅创建者可以编辑开放请求的指派人和审核者",
        ));
    }
    Ok((request, user))
}

pub async fn participant_candidates(
    config: &Config,
    mr_id: u64,
    project_id: u64,
    iid: u64,
    query: &str,
    page: u64,
) -> Result<ParticipantCandidates, ApiError> {
    let query = query.trim();
    if query.len() > MAX_PARTICIPANT_QUERY_BYTES
        || query.chars().any(char::is_control)
        || !(1..=MAX_PAGES as u64).contains(&page)
    {
        return Err(ApiError::new(
            "invalid_input",
            "成员搜索或页码无效，请缩短搜索内容",
        ));
    }
    let context = Context::new(config)?;
    participant_request(&context, mr_id, project_id, iid).await?;
    let project = project_id.to_string();
    let parts = ["projects", project.as_str(), "members", "all"];
    let filters = [
        ("query", query.to_owned()),
        ("per_page", PAGE_SIZE.to_string()),
        ("page", page.to_string()),
    ];
    let endpoint = context.endpoint(&parts, &filters)?;
    let (value, headers, _) = context.request(Method::GET, &parts, &filters, None).await?;
    let members: Vec<RawMember> = decode(value)?;
    if members.len() > PAGE_SIZE {
        return Err(invalid_response());
    }
    let next = next_page(&endpoint, &headers, page, members.len())?;
    if next.is_some_and(|next| next > MAX_PAGES as u64) {
        return Err(ApiError::new(
            "invalid_input",
            "成员列表超过分页上限，请缩小搜索范围",
        ));
    }
    // The API's state filter requires a paid tier. Filter the documented user
    // state locally so the same picker works with GitLab Free.
    let mut seen = HashSet::new();
    let users = members
        .into_iter()
        .filter(|member| member.eligible() && seen.insert(member.user.id))
        .map(|member| member.user)
        .collect();
    Ok(ParticipantCandidates {
        users,
        next_page: next,
    })
}

pub async fn update_participants(
    config: &Config,
    mr_id: u64,
    project_id: u64,
    iid: u64,
    kind: ParticipantKind,
    user_ids: &[u64],
    expected_user_ids: &[u64],
    before_write: impl FnOnce() -> Result<(), ApiError>,
) -> Result<ActionResult, ApiError> {
    let selected = participant_ids(user_ids)?;
    let expected = participant_ids(expected_user_ids)?;
    let context = Context::new(config)?;
    let (request, user) = participant_request(&context, mr_id, project_id, iid).await?;
    let assignees = request.assignees.as_deref().ok_or_else(invalid_response)?;
    let reviewers = request.reviewers.as_deref().ok_or_else(invalid_response)?;
    let current_ids = kind
        .users(assignees, reviewers)
        .iter()
        .map(|user| user.id)
        .collect::<Vec<_>>();
    if participant_ids(&current_ids)? != expected {
        return Err(ApiError::new(
            "conflict",
            "指派人或审核者已在远程变化，请刷新后重新选择",
        ));
    }
    let mut body = serde_json::Map::new();
    body.insert(
        kind.field().into(),
        serde_json::json!(if selected.is_empty() {
            vec![0]
        } else {
            selected.clone()
        }),
    );
    before_write()?;
    let write = context
        .request(
            Method::PUT,
            &[
                "projects",
                &project_id.to_string(),
                "merge_requests",
                &iid.to_string(),
            ],
            &[],
            Some(Value::Object(body)),
        )
        .await;
    if let Err(error) = &write {
        if !uncertain_transport(error) {
            return Err(error.clone());
        }
    }
    // A response body alone does not prove the server retained the selection.
    // Reconcile once after success or transport uncertainty; never replay PUT.
    let current = load_detail(&context, project_id, iid, true)
        .await
        .ok()
        .filter(|(detail, current_user, _)| {
            current_user.id == user.id
                && detail.summary.author.id == user.id
                && action_identity(detail, mr_id, project_id, iid)
        })
        .map(|(detail, _, _)| detail);
    let retained_ids = current.as_ref().and_then(|detail| {
        let ids = kind
            .users(&detail.assignees, &detail.reviewers)
            .iter()
            .map(|user| user.id)
            .collect::<Vec<_>>();
        participant_ids(&ids).ok()
    });
    if retained_ids.as_ref() == Some(&selected) {
        Ok(ActionResult {
            state: "updated".into(),
            message: "GitLab 已确认更新成员选择".into(),
            detail: current,
        })
    } else if retained_ids.is_some() {
        Ok(uncertain_action(
            "GitLab 未保留全部成员选择，请检查成员权限、实例版本与人数限制，已同步实际成员",
            current,
        ))
    } else {
        Ok(uncertain_action(
            "成员更新结果尚未确认，请刷新状态核对，请勿重复提交",
            current,
        ))
    }
}

/// Closing does not delete either the source branch or the merge request.
pub async fn close(
    config: &Config,
    mr_id: u64,
    project_id: u64,
    iid: u64,
) -> Result<ActionResult, ApiError> {
    let context = Context::new(config)?;
    let (detail, user, _) = load_detail(&context, project_id, iid, false).await?;
    if !action_identity(&detail, mr_id, project_id, iid) {
        return Err(invalid_response());
    }
    if !detail.can_close {
        return Err(ApiError::new("blocked", "仅发起人可以取消开放的合并请求"));
    }
    let write = context
        .request(
            Method::PUT,
            &[
                "projects",
                &project_id.to_string(),
                "merge_requests",
                &iid.to_string(),
            ],
            &[],
            Some(serde_json::json!({"state_event": "close"})),
        )
        .await;
    if let Err(error) = &write {
        if !uncertain_transport(error) {
            return Err(error.clone());
        }
    }
    // Read once after both success and transport uncertainty. Never replay PUT.
    let current = load_detail(&context, project_id, iid, true)
        .await
        .ok()
        .filter(|(detail, current_user, _)| {
            current_user.id == user.id && action_identity(detail, mr_id, project_id, iid)
        })
        .map(|(detail, _, _)| detail);
    if current
        .as_ref()
        .is_some_and(|detail| detail.summary.state == "closed")
    {
        Ok(ActionResult {
            state: "closed".into(),
            message: "GitLab 已确认取消合并请求".into(),
            detail: current,
        })
    } else {
        Ok(uncertain_action(
            "取消结果尚未确认；请刷新状态或在 GitLab 核对，请勿重复提交",
            current,
        ))
    }
}

pub async fn approve(
    config: &Config,
    mr_id: u64,
    project_id: u64,
    iid: u64,
    reviewed_sha: &str,
    expected_target_branch: &str,
    reviewed_version_id: u64,
    reviewed_refs: &DiffRefs,
) -> Result<ActionResult, ApiError> {
    let context = Context::new(config)?;
    let (detail, user, _) = load_detail(&context, project_id, iid, true).await?;
    if !action_identity(&detail, mr_id, project_id, iid) {
        return Err(invalid_response());
    }
    validate_review(
        &detail,
        reviewed_sha,
        expected_target_branch,
        reviewed_version_id,
        reviewed_refs,
    )?;
    if !detail.can_approve {
        return Err(ApiError::new(
            "blocked",
            "当前账号无法批准此请求，请刷新审核人和审批状态",
        ));
    }
    let write = context
        .request(
            Method::POST,
            &[
                "projects",
                &project_id.to_string(),
                "merge_requests",
                &iid.to_string(),
                "approve",
            ],
            &[],
            Some(serde_json::json!({"sha": reviewed_sha})),
        )
        .await;
    if let Err(error) = &write {
        if !uncertain_transport(error) {
            return Err(error.clone());
        }
    }
    // GitLab enforces approver eligibility, password/SAML requirements and SHA.
    let current = load_detail(&context, project_id, iid, true)
        .await
        .ok()
        .filter(|(detail, current_user, _)| {
            current_user.id == user.id && action_identity(detail, mr_id, project_id, iid)
        })
        .map(|(detail, _, _)| detail);
    let approved = current.as_ref().is_some_and(|detail| {
        detail
            .approvals
            .approved_by
            .iter()
            .any(|approved| approved.id == user.id)
            && approval_status_ready(detail.summary.detailed_merge_status.as_deref())
            && approval_diff_ready(&detail.diff_versions)
            && validate_review(
                detail,
                reviewed_sha,
                expected_target_branch,
                reviewed_version_id,
                reviewed_refs,
            )
            .is_ok()
    });
    if approved {
        Ok(ActionResult {
            state: "approved".into(),
            message: "GitLab 已确认批准当前版本".into(),
            detail: current,
        })
    } else {
        Ok(uncertain_action(
            "批准结果尚未确认；请刷新状态或在 GitLab 核对，请勿重复提交",
            current,
        ))
    }
}

async fn reconcile_merge(
    context: &Context,
    project: &RawProject,
    user: &User,
    iid: u64,
    reviewed_sha: &str,
) -> Result<MergeResult, ApiError> {
    let summary = match context
        .get(
            &[
                "projects",
                &project.id.to_string(),
                "merge_requests",
                &iid.to_string(),
            ],
            &[],
        )
        .await
    {
        Ok(value) => decode::<RawMergeRequest>(value)
            .and_then(|request| request.summary(context, user, Some(project), false))
            .ok()
            .filter(|request| request.iid == iid),
        Err(_) => None,
    };
    let merged = summary.as_ref().is_some_and(|request| {
        request.state == "merged" && request.sha.as_deref() == Some(reviewed_sha)
    });
    Ok(MergeResult {
        state: if merged { "merged" } else { "uncertain" }.into(),
        message: if merged {
            "已重新查询 GitLab，合并已完成"
        } else {
            "合并结果尚未确认；请刷新状态或在 GitLab 核对，请勿重复提交"
        }
        .into(),
        summary,
    })
}

#[cfg(test)]
#[path = "api_tests.rs"]
mod tests;
