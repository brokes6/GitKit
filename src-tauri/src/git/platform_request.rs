//! GitHub / GitLab pull (merge) request lookup and creation through the
//! platform REST APIs, using the app's configured instance and token.
//!
//! Every request is pinned to the configured instance; the remote URL only
//! supplies the repository path and must point at that same host. Responses are
//! re-checked against the repository and source branch so a same-named branch
//! in a fork, or a response from an unexpected host, is never reported.

use reqwest::{Client, Method, Url};
use serde::Serialize;
use serde_json::Value;

/// A pull/merge request identity as shown to the UI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformRequest {
    /// Global request id (GitHub PR `id`, GitLab MR `id`).
    pub id: u64,
    /// Repository-scoped number (GitHub `number`, GitLab `iid`).
    pub number: u64,
    pub url: String,
    pub title: String,
    pub target: String,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRequestLookup {
    /// Platform default branch; empty when the repository has none (empty repo).
    pub default_branch: String,
    /// Open requests from `source` in this same repository (may be empty).
    pub requests: Vec<PlatformRequest>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Provider {
    Github,
    Gitlab,
}

/// Where a repository lives: API root, web host, and the repository path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepoTarget {
    pub provider: Provider,
    /// API root without trailing slash, e.g. `https://api.github.com`,
    /// `https://ghe.example.com/api/v3`, `https://gl.example.com/sub/api/v4`.
    pub api_base: String,
    /// Web origin (scheme, host and port) used to validate returned request URLs.
    pub web_origin: String,
    /// `owner/repo` or `group/sub/project`.
    pub path: String,
    /// `hostname[:port]` for the GitLab CLI; only HTTPS root-path GitLab
    /// instances support it.
    pub cli_host: Option<String>,
}

/// Configured instance: API root, web host, web sub-path, CLI host.
struct Instance {
    api_base: String,
    web_origin: String,
    web_prefix: String,
    cli_host: Option<String>,
}

fn instance(provider: Provider, instance_url: &str) -> Result<Instance, String> {
    match provider {
        Provider::Github => {
            let raw = instance_url.trim();
            let public = raw.is_empty() || {
                let url = parse_instance(raw)?;
                matches!(url.origin().ascii_serialization().as_str(), "https://github.com" | "https://api.github.com")
            };
            if public {
                return Ok(Instance {
                    api_base: "https://api.github.com".into(),
                    web_origin: "https://github.com".into(),
                    web_prefix: String::new(),
                    cli_host: None,
                });
            }
            let url = parse_instance(raw)?;
            let path = url.path().trim_end_matches('/');
            // Accept both the Enterprise web root and its REST root.
            let web_path = path.strip_suffix("/api/v3").unwrap_or(path);
            Ok(Instance {
                api_base: format!("{}{}/api/v3", origin_of(&url), web_path),
                web_origin: origin_of(&url),
                web_prefix: web_path.trim_matches('/').to_string(),
                cli_host: None,
            })
        }
        Provider::Gitlab => {
            if instance_url.trim().is_empty() {
                return Err("请先在设置中填写 GitLab 实例地址".into());
            }
            let url = parse_instance(instance_url)?;
            let path = url.path().trim_end_matches('/');
            let cli_host = (url.scheme() == "https" && path.is_empty()).then(|| {
                let host = url.host_str().unwrap_or("").to_ascii_lowercase();
                match url.port() {
                    Some(port) => format!("{host}:{port}"),
                    None => host,
                }
            });
            Ok(Instance {
                api_base: format!("{}{}/api/v4", origin_of(&url), path),
                web_origin: origin_of(&url),
                web_prefix: path.trim_matches('/').to_string(),
                cli_host,
            })
        }
    }
}

fn parse_provider(provider: &str) -> Result<Provider, String> {
    match provider {
        "github" => Ok(Provider::Github),
        "gitlab" => Ok(Provider::Gitlab),
        _ => Err("不支持的代码托管平台".into()),
    }
}

fn invalid_instance() -> String {
    "实例地址无效，请使用不含账号、密码、参数的 HTTP(S) 地址".into()
}

fn parse_instance(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.chars().any(char::is_control) || raw.contains('\\') || !raw.contains("://") {
        return Err(invalid_instance());
    }
    let url = Url::parse(raw).map_err(|_| invalid_instance())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().map_or(true, str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_instance());
    }
    Ok(url)
}

fn origin_of(url: &Url) -> String {
    let mut origin = format!("{}://{}", url.scheme(), url.host_str().unwrap_or(""));
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    origin
}

/// Host (lower-cased, no port) and path of a Git remote. Accepts HTTPS,
/// ssh://, git:// and scp-style remotes.
fn remote_host_and_path(remote: &str) -> Option<(String, String)> {
    let web = super::remote_web_url(remote)?;
    let rest = web.split_once("://")?.1;
    let (authority, path) = rest.split_once('/')?;
    let host = if authority.starts_with('[') {
        authority.split(']').next()?.trim_start_matches('[').to_string()
    } else {
        authority.split(':').next()?.to_string()
    };
    let path = path.trim_matches('/').to_string();
    if host.is_empty() || path.is_empty() || path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return None;
    }
    Some((host.to_ascii_lowercase(), path))
}

fn normalize_host(host: &str) -> String {
    host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase()
}

/// Resolve the API target for `remote_url` on the configured instance.
pub(crate) fn resolve_target(provider: &str, instance_url: &str, remote_url: &str) -> Result<RepoTarget, String> {
    let provider = parse_provider(provider)?;
    let (remote_host, remote_path) =
        remote_host_and_path(remote_url).ok_or_else(|| "无法从远程地址解析仓库路径".to_string())?;
    let Instance { api_base, web_origin, web_prefix, cli_host } = instance(provider, instance_url)?;
    let origin = Url::parse(&web_origin).map_err(|_| invalid_instance())?;
    let web_remote = Url::parse(remote_url).ok().filter(|url| matches!(url.scheme(), "https" | "http"));
    if remote_host != normalize_host(origin.host_str().unwrap_or(""))
        || web_remote.as_ref().is_some_and(|remote| remote.origin() != origin.origin()) {
        return Err(format!("远程仓库主机 {remote_host} 与已配置的实例 {web_origin} 不一致，请检查远程地址或实例设置"));
    }
    let prefix = format!("{web_prefix}/");
    let path = if web_prefix.is_empty() || web_remote.is_none() {
        remote_path
    } else {
        remote_path.strip_prefix(&prefix).ok_or("远程仓库不在已配置的实例路径下")?.to_string()
    };
    if provider == Provider::Github && path.split('/').count() != 2 {
        return Err("无法从远程地址解析 GitHub 仓库（应为 owner/repo）".into());
    }
    Ok(RepoTarget { provider, api_base, web_origin, path, cli_host })
}

/// Validate a request web URL for opening in the browser: HTTP(S), no
/// credentials, on the configured instance host, and free of characters the
/// Windows `cmd /C start` launcher would interpret.
pub(crate) fn browser_url(url: &str, instance_url: &str, provider: &str) -> Result<String, String> {
    let provider = parse_provider(provider)?;
    let web_origin = instance(provider, instance_url)?.web_origin;
    let invalid = || "链接无效或不属于已配置的实例".to_string();
    let url = url.trim();
    if url.chars().any(char::is_control) || !valid_web_url(url, &web_origin) {
        return Err(invalid());
    }
    let parsed = Url::parse(url).map_err(|_| invalid())?;
    if parsed
        .as_str()
        .bytes()
        .any(|byte| matches!(byte, b'%' | b'&' | b'|' | b'^' | b'<' | b'>' | b'"' | b'!' | b'(' | b')' | b' '))
    {
        return Err(invalid());
    }
    Ok(parsed.into())
}

/// Percent-encode one URL path segment / query value.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn platform_name(provider: Provider) -> &'static str {
    match provider {
        Provider::Github => "GitHub",
        Provider::Gitlab => "GitLab",
    }
}

fn status_error(provider: Provider, status: u16, body: &Value) -> String {
    let name = platform_name(provider);
    match status {
        401 => format!("{name}：Token 无效或已过期，请在设置中更换令牌"),
        403 => format!("{name}：Token 无权访问此仓库，或已触发访问频率限制"),
        404 => format!("{name}：未找到仓库，或当前 Token 无权访问"),
        _ => {
            let message = body
                .get("message")
                .or_else(|| body.get("error"))
                .map(|value| match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .filter(|text| !text.trim().is_empty());
            match message {
                Some(message) => format!("{name}：{}", message.chars().take(300).collect::<String>()),
                None => format!("{name}：请求失败（HTTP {status}）"),
            }
        }
    }
}

pub(crate) fn http_client() -> Result<Client, String> {
    crate::network::client_builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let same_instance = attempt.previous().first()
                .is_some_and(|first| first.origin() == attempt.url().origin());
            if same_instance && attempt.previous().len() < 5 { attempt.follow() } else { attempt.stop() }
        }))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())
}

/// How API calls reach the platform.
pub(crate) enum Transport<'a> {
    /// REST over HTTP with the app's configured token.
    Http { client: &'a Client, token: &'a str },
    /// The GitLab CLI's own authentication (`crate::glab::api`).
    Glab,
}

impl Transport<'_> {
    fn validate(&self, target: &RepoTarget) -> Result<(), String> {
        match self {
            Transport::Http { token, .. } => check_token(token).map(|_| ()),
            Transport::Glab if target.provider != Provider::Gitlab => Err("GitLab CLI 仅可用于 GitLab".into()),
            Transport::Glab if target.cli_host.is_none() => {
                Err("GitLab CLI 仅支持 HTTPS 根路径实例，请改用访问令牌".into())
            }
            Transport::Glab => Ok(()),
        }
    }
}

/// `path` is relative to the API root and starts with `/` (query included).
/// GET when `body` is `None`, POST otherwise. Never retried.
async fn call(transport: &Transport<'_>, target: &RepoTarget, path: &str, body: Option<Value>) -> Result<Value, String> {
    let name = platform_name(target.provider);
    let (client, token) = match transport {
        Transport::Http { client, token } => (*client, token.trim()),
        Transport::Glab => {
            let host = target.cli_host.as_deref().ok_or_else(|| "GitLab CLI 仅支持 HTTPS 根路径实例，请改用访问令牌".to_string())?;
            let value = crate::glab::api(host, path.trim_start_matches('/'), body).await?;
            if value.is_null() {
                return Err(format!("{name}：响应格式无效"));
            }
            return Ok(value);
        }
    };
    let url = format!("{}{}", target.api_base, path);
    let method = if body.is_some() { Method::POST } else { Method::GET };
    let mut request = client.request(method, &url).header("User-Agent", "GitKit");
    request = match target.provider {
        Provider::Github => request
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28"),
        Provider::Gitlab => request
            .header("PRIVATE-TOKEN", token)
            .header("Accept", "application/json"),
    };
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("{name}：网络请求失败（{}）", error.without_url()))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("{name}：读取响应失败（{}）", error.without_url()))?;
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(status_error(target.provider, status.as_u16(), &value));
    }
    if value.is_null() {
        return Err(format!("{name}：响应格式无效"));
    }
    Ok(value)
}

fn str_field<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(value, |value, key| value.get(*key))?.as_str()
}

fn u64_field(value: &Value, path: &[&str]) -> Option<u64> {
    path.iter().try_fold(value, |value, key| value.get(*key))?.as_u64()
}

/// The request URL must be a web URL on the configured instance host.
fn valid_web_url(url: &str, web_origin: &str) -> bool {
    Url::parse(url).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
            && url.origin().ascii_serialization() == web_origin
    })
}

/// Repository identity the returned requests must belong to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepoIdentity {
    pub id: Option<u64>,
    pub full_name: String,
}

fn same_repo(value: &Value, repo: &RepoIdentity) -> bool {
    // GitHub sets head.repo to null when the fork was deleted: never a match.
    if value.is_null() {
        return false;
    }
    match repo.id {
        Some(id) => u64_field(value, &["id"]) == Some(id),
        None => str_field(value, &["full_name"]).is_some_and(|name| name.eq_ignore_ascii_case(&repo.full_name)),
    }
}

/// Parse a GitHub pull. `None` when it is not a request from `source` in `repo`.
pub(crate) fn github_request(value: &Value, repo: &RepoIdentity, source: &str, web_origin: &str) -> Option<PlatformRequest> {
    let head = value.get("head")?;
    let base = value.get("base")?;
    if str_field(head, &["ref"])? != source
        || !same_repo(head.get("repo").unwrap_or(&Value::Null), repo)
        || !same_repo(base.get("repo").unwrap_or(&Value::Null), repo)
    {
        return None;
    }
    let url = str_field(value, &["html_url"])?;
    if !valid_web_url(url, web_origin) {
        return None;
    }
    Some(PlatformRequest {
        id: u64_field(value, &["id"])?,
        number: u64_field(value, &["number"])?,
        url: url.to_string(),
        title: str_field(value, &["title"]).unwrap_or("").to_string(),
        target: str_field(base, &["ref"])?.to_string(),
        source: source.to_string(),
    })
}

/// Parse a GitLab MR. `None` unless both source and target are `project_id`.
pub(crate) fn gitlab_request(value: &Value, project_id: u64, source: &str, web_origin: &str) -> Option<PlatformRequest> {
    if str_field(value, &["source_branch"])? != source
        || u64_field(value, &["source_project_id"])? != project_id
        || u64_field(value, &["target_project_id"])? != project_id
    {
        return None;
    }
    let url = str_field(value, &["web_url"])?;
    if !valid_web_url(url, web_origin) {
        return None;
    }
    Some(PlatformRequest {
        id: u64_field(value, &["id"])?,
        number: u64_field(value, &["iid"])?,
        url: url.to_string(),
        title: str_field(value, &["title"]).unwrap_or("").to_string(),
        target: str_field(value, &["target_branch"])?.to_string(),
        source: source.to_string(),
    })
}

fn sorted(mut requests: Vec<PlatformRequest>) -> Vec<PlatformRequest> {
    requests.sort_by(|a, b| b.number.cmp(&a.number));
    requests.dedup_by_key(|request| request.id);
    requests
}

fn check_source(source: &str) -> Result<&str, String> {
    let source = source.trim();
    if source.is_empty() || source.chars().any(char::is_control) {
        return Err("来源分支无效".into());
    }
    Ok(source)
}

fn check_token(token: &str) -> Result<&str, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("请先在设置中配置访问令牌".into());
    }
    if token.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("访问令牌格式无效".into());
    }
    Ok(token)
}

/// Default branch plus the open requests whose source is `source` in this
/// repository. `Err` means the lookup failed; `Ok` with no requests means none.
pub(crate) async fn lookup(
    transport: &Transport<'_>,
    target: &RepoTarget,
    source: &str,
) -> Result<BranchRequestLookup, String> {
    transport.validate(target)?;
    let source = check_source(source)?;
    match target.provider {
        Provider::Github => {
            let (owner, name) = target.path.split_once('/').ok_or_else(|| "无法解析 GitHub 仓库".to_string())?;
            let repo = call(transport, target, &format!("/repos/{}/{}", encode(owner), encode(name)), None).await?;
            let id = u64_field(&repo, &["id"]).ok_or_else(|| "GitHub：仓库信息无效".to_string())?;
            let full_name = str_field(&repo, &["full_name"]).ok_or_else(|| "GitHub：仓库信息无效".to_string())?;
            // Renamed/transferred repositories redirect; use the canonical name.
            let (owner, name) = full_name.split_once('/').ok_or_else(|| "GitHub：仓库信息无效".to_string())?;
            let default_branch = str_field(&repo, &["default_branch"]).unwrap_or("").to_string();
            let pulls = call(
                transport,
                target,
                &format!(
                    "/repos/{}/{}/pulls?state=open&head={}&per_page=100",
                    encode(owner),
                    encode(name),
                    encode(&format!("{owner}:{source}")),
                ),
                None,
            )
            .await?;
            let items = pulls.as_array().ok_or_else(|| "GitHub：拉取请求列表格式无效".to_string())?;
            let identity = RepoIdentity { id: Some(id), full_name: full_name.to_string() };
            let requests = items
                .iter()
                .filter(|item| str_field(item, &["state"]).map_or(true, |state| state == "open"))
                .filter_map(|item| github_request(item, &identity, source, &target.web_origin))
                .collect();
            Ok(BranchRequestLookup { default_branch, requests: sorted(requests) })
        }
        Provider::Gitlab => {
            let project = call(transport, target, &format!("/projects/{}", encode(&target.path)), None).await?;
            let id = u64_field(&project, &["id"]).ok_or_else(|| "GitLab：项目信息无效".to_string())?;
            let default_branch = str_field(&project, &["default_branch"]).unwrap_or("").to_string();
            let list = call(
                transport,
                target,
                &format!(
                    "/projects/{id}/merge_requests?state=opened&source_branch={}&per_page=100",
                    encode(source)
                ),
                None,
            )
            .await?;
            let items = list.as_array().ok_or_else(|| "GitLab：合并请求列表格式无效".to_string())?;
            let requests = items
                .iter()
                .filter(|item| str_field(item, &["state"]).map_or(true, |state| state == "opened"))
                .filter_map(|item| gitlab_request(item, id, source, &target.web_origin))
                .collect();
            Ok(BranchRequestLookup { default_branch, requests: sorted(requests) })
        }
    }
}

/// Create a request from `source` into `target_branch` within this repository.
pub(crate) async fn create(
    transport: &Transport<'_>,
    target: &RepoTarget,
    source: &str,
    target_branch: &str,
    title: &str,
    description: &str,
) -> Result<PlatformRequest, String> {
    transport.validate(target)?;
    let source = check_source(source)?;
    let target_branch = target_branch.trim();
    let title = title.trim();
    if title.is_empty() {
        return Err("标题不能为空".into());
    }
    if target_branch.is_empty() {
        return Err("目标分支不能为空".into());
    }
    if source == target_branch {
        return Err("来源分支与目标分支不能相同".into());
    }
    let mismatch = || format!("{}：已提交创建请求，但返回结果与当前仓库或分支不一致，请在网页中确认", platform_name(target.provider));
    match target.provider {
        Provider::Github => {
            let (owner, name) = target.path.split_once('/').ok_or_else(|| "无法解析 GitHub 仓库".to_string())?;
            let body = serde_json::json!({ "title": title, "head": source, "base": target_branch, "body": description });
            let value = call(transport, target, &format!("/repos/{}/{}/pulls", encode(owner), encode(name)), Some(body)).await?;
            // The base is the repository we posted to; require the head to be
            // that same repository (not a fork carrying this branch name).
            let base_id = u64_field(&value, &["base", "repo", "id"]).ok_or_else(mismatch)?;
            let identity = RepoIdentity { id: Some(base_id), full_name: target.path.clone() };
            let created = github_request(&value, &identity, source, &target.web_origin).ok_or_else(mismatch)?;
            if created.target != target_branch {
                return Err(mismatch());
            }
            Ok(created)
        }
        Provider::Gitlab => {
            let body = serde_json::json!({
                "source_branch": source, "target_branch": target_branch,
                "title": title, "description": description,
            });
            let value = call(transport, target, &format!("/projects/{}/merge_requests", encode(&target.path)), Some(body)).await?;
            let project_id = u64_field(&value, &["project_id"]).ok_or_else(mismatch)?;
            let created = gitlab_request(&value, project_id, source, &target.web_origin).ok_or_else(mismatch)?;
            if created.target != target_branch {
                return Err(mismatch());
            }
            Ok(created)
        }
    }
}
