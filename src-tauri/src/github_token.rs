use reqwest::header::HeaderMap;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize)]
pub struct GithubTokenInfo {
    login: String,
    name: Option<String>,
    token_kind: &'static str,
    scopes: Option<Vec<String>>,
    expires_at: Option<String>,
}

fn api_base(url: &str) -> Result<String, String> {
    let base = url.trim().trim_end_matches('/');
    if matches!(base, "" | "github.com" | "api.github.com") {
        return Ok("https://api.github.com".into());
    }
    let parsed = reqwest::Url::parse(base).map_err(|_| "请填写完整的 GitHub 实例地址")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("请填写 http:// 或 https:// 开头的实例根地址，GitHub.com 可留空".into());
    }
    if matches!(parsed.host_str(), Some("github.com" | "api.github.com")) {
        if parsed.path().trim_matches('/').is_empty() && parsed.port().is_none() {
            return Ok("https://api.github.com".into());
        }
        return Err("GitHub.com 请留空地址，或填写 https://github.com".into());
    }
    Ok(if base.ends_with("/api/v3") {
        base.into()
    } else {
        format!("{base}/api/v3")
    })
}

// Normalize the header in Rust so WebKit and Chromium receive the same ISO date.
fn expiration(raw: &str) -> Option<String> {
    let normalized = raw.trim().replace(" UTC", " +0000");
    chrono::DateTime::parse_from_rfc3339(&normalized)
        .or_else(|_| chrono::DateTime::parse_from_str(&normalized, "%Y-%m-%d %H:%M:%S %z"))
        .map(|date| date.to_utc().to_rfc3339())
        .ok()
}

fn metadata(headers: &HeaderMap, user: Value, token: &str) -> Result<GithubTokenInfo, String> {
    let login = user
        .get("login")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("GitHub 未返回有效的账号信息")?
        .to_string();
    let raw_scopes = headers.get("x-oauth-scopes").and_then(|v| v.to_str().ok());
    let token_kind = if token.starts_with("github_pat_") {
        "fine_grained"
    } else if token.starts_with("ghp_") {
        "classic"
    } else if token.starts_with("gho_") {
        "oauth"
    } else if !token.starts_with("gh") && raw_scopes.is_some() {
        "classic"
    } else {
        "other"
    };
    // X-Accepted-* describes an ENDPOINT's requirements, never this token's grants.
    let scopes = if matches!(token_kind, "classic" | "oauth") {
        raw_scopes.map(|scopes| {
            scopes
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
    } else {
        None
    };
    let expires_at = headers
        .get("github-authentication-token-expiration")
        .and_then(|v| v.to_str().ok())
        .and_then(expiration);
    Ok(GithubTokenInfo {
        login,
        name: user
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        token_kind,
        scopes,
        // Missing header is unknown, not evidence of an unlimited lifetime.
        expires_at,
    })
}

#[tauri::command]
pub async fn github_token_info(url: String, token: String) -> Result<GithubTokenInfo, String> {
    if token.trim().is_empty() {
        return Err("请填写访问令牌".into());
    }
    let api = api_base(&url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建 GitHub 连接")?;
    let response = client
        .get(format!("{api}/user"))
        .header("Authorization", format!("Bearer {}", token.trim()))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "GitKit")
        .send()
        .await
        .map_err(|_| "无法连接 GitHub，请检查网络或实例地址后重试")?;
    match response.status().as_u16() {
        200 => {
            let headers = response.headers().clone();
            let user = response
                .json()
                .await
                .map_err(|_| "GitHub 返回的账号信息无法解析")?;
            metadata(&headers, user, token.trim())
        }
        401 => Err("认证失败：Token 可能已过期、被撤销或无效，请更换令牌后重试".into()),
        403 | 429 => {
            Err("GitHub 拒绝了请求，可能受到权限、组织策略或请求频率限制，请稍后重试".into())
        }
        404 => Err("接口未找到，请确认 GitHub Enterprise 实例地址是否正确".into()),
        status => Err(format!(
            "读取 GitHub Token 信息失败（HTTP {status}），请检查实例地址后重试"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn routes_public_and_enterprise_hosts_exactly() {
        for url in [
            "",
            "github.com",
            "https://github.com/",
            "https://api.github.com",
        ] {
            assert_eq!(api_base(url).unwrap(), "https://api.github.com");
        }
        assert_eq!(
            api_base("https://work.example/github/").unwrap(),
            "https://work.example/github/api/v3"
        );
        assert_eq!(
            api_base("https://notgithub.com").unwrap(),
            "https://notgithub.com/api/v3"
        );
        assert_eq!(
            api_base("https://work.example/api/v3").unwrap(),
            "https://work.example/api/v3"
        );
        for url in [
            "file:///tmp/test",
            "https://user:secret@work.example",
            "https://github.com/user",
            "https://work.example?token=secret",
        ] {
            assert!(api_base(url).is_err());
        }
    }

    #[test]
    fn normalizes_expiration_offsets_without_guessing_missing_values() {
        assert_eq!(
            expiration("2026-10-01 23:00:00 UTC").as_deref(),
            Some("2026-10-01T23:00:00+00:00")
        );
        assert_eq!(
            expiration("2026-10-01 23:00:00 -0500").as_deref(),
            Some("2026-10-02T04:00:00+00:00")
        );
        assert_eq!(
            expiration("2026-10-01T23:00:00Z").as_deref(),
            Some("2026-10-01T23:00:00+00:00")
        );
        for raw in ["", "never", "2026-02-30 00:00:00 UTC", "2026-10-01"] {
            assert!(expiration(raw).is_none());
        }
    }

    #[test]
    fn only_authorized_scopes_are_used_and_empty_differs_from_missing() {
        let mut headers = HeaderMap::new();
        headers.insert("x-accepted-oauth-scopes", "repo, workflow".parse().unwrap());
        headers.insert(
            "x-accepted-github-permissions",
            "contents=write".parse().unwrap(),
        );
        let user = json!({"login":"demo", "name":null, "token":"never-forward"});
        let unknown = metadata(&headers, user.clone(), "ghp_fixture").unwrap();
        assert!(unknown.scopes.is_none());
        assert!(unknown.expires_at.is_none());
        headers.insert("x-oauth-scopes", "".parse().unwrap());
        assert_eq!(
            metadata(&headers, user.clone(), "ghp_fixture")
                .unwrap()
                .scopes,
            Some(vec![])
        );
        headers.insert("x-oauth-scopes", "repo, read:org".parse().unwrap());
        let classic = metadata(&headers, user.clone(), "ghp_fixture").unwrap();
        assert_eq!(classic.scopes, Some(vec!["repo".into(), "read:org".into()]));
        assert!(!serde_json::to_string(&classic)
            .unwrap()
            .contains("never-forward"));
        let fine = metadata(&headers, user, "github_pat_fixture").unwrap();
        assert_eq!(fine.token_kind, "fine_grained");
        assert!(fine.scopes.is_none());
        assert!(metadata(&headers, json!({"message":"error"}), "ghp_fixture").is_err());
    }
}
