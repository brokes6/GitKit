use reqwest::Url;
use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// Keep the API protocol and hostname (including any non-default port) together.
fn cli_endpoint(instance: &str) -> Result<Url, String> {
    let url = Url::parse(instance).map_err(|_| "请输入 GitLab 的 HTTP 或 HTTPS 实例地址")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("glab 连接需要 HTTP 或 HTTPS 根地址，仅填写协议、主机和可选端口".into());
    }
    Ok(url)
}

// glab diagnostics may contain credentials, headers or response bodies. Only
// return fixed, translated descriptions for recognized failures.
fn failure_message(stderr: &[u8], account_check: bool) -> &'static str {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    let has = |patterns: &[&str]| patterns.iter().any(|p| text.contains(*p));
    if has(&["http 401", "401 unauthorized", "not been authenticated", "not logged in", "glab auth login"]) {
        "glab 尚未登录此实例或凭据已失效，请在终端重新登录"
    } else if has(&["http 403", "403 forbidden"]) {
        if account_check { "GitLab 拒绝读取 glab 账号，请检查 CLI 凭据的 API 访问权限" }
        else { "GitLab 拒绝此操作，请检查 glab 账号的项目权限" }
    } else if has(&["x509:", "certificate verify", "certificate signed"]) {
        "glab 无法验证 GitLab 证书，请检查证书信任设置"
    } else if has(&["http response to https client", "first record does not look like a tls handshake", "client sent an http request to an https server"]) {
        "GitLab API 协议不匹配，请核对实例地址的 http 或 https"
    } else if has(&["no such host", "could not resolve", "name resolution", "connection refused", "network is unreachable", "no route to host", "proxyconnect"]) {
        "glab 无法连接 GitLab，请检查实例地址、网络和代理"
    } else if has(&["timeout", "timed out", "deadline exceeded"]) {
        "glab 请求超时"
    } else if account_check {
        "无法验证 glab 账号，请在终端检查此实例的登录状态"
    } else {
        "glab 请求失败，请检查 CLI 登录状态和项目权限"
    }
}

pub(crate) async fn api(instance: &str, endpoint: &str, body: Option<Value>) -> Result<Value, String> {
    let url = cli_endpoint(instance)?;
    let host = url.host_str().ok_or("请输入 GitLab 的 HTTP 或 HTTPS 实例地址")?;
    // glab api accepts only the bare hostname for the account selector.
    // Bind its API destination separately so a non-default port is preserved.
    let api_host = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let mut cmd = crate::git::command("glab");
    #[cfg(target_os = "macos")]
    cmd.env("PATH", crate::git::augmented_path());
    // Keep repository-local CLI configuration and ambient CI credentials out of this flow.
    let neutral = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = neutral.ancestors().last().ok_or("无法定位系统目录")?;
    cmd.current_dir(root);
    for var in [
        "GLAB_DEBUG_HTTP",
        "GITLAB_TOKEN",
        "GITLAB_ACCESS_TOKEN",
        "OAUTH_TOKEN",
        "CI_JOB_TOKEN",
        "GITLAB_REPO",
        "GITLAB_HOST",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GLAB_ENABLE_CI_AUTOLOGIN",
        "GITLAB_URI",
        "GITLAB_URL",
    ] {
        cmd.env_remove(var);
    }
    cmd.env("GLAB_CHECK_UPDATE", "false")
        .env("GLAB_API_PROTOCOL", url.scheme())
        .env("GITLAB_API_HOST", api_host)
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "api",
            "--hostname",
            host,
            "--method",
            if body.is_some() { "POST" } else { "GET" },
        ]);
    if body.is_some() {
        cmd.args(["--input", "-"]);
    }
    cmd.arg("--")
        .arg(endpoint.trim_start_matches('/'))
        .stdin(if body.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = tokio::process::Command::from(cmd)
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "无法启动 glab，请先安装 GitLab CLI".to_string())?;
    let send = async move {
        if let Some(body) = body {
            let mut stdin = child.stdin.take().ok_or("无法写入 glab")?;
            stdin
                .write_all(body.to_string().as_bytes())
                .await
                .map_err(|e| e.to_string())?;
        }
        let output = child.wait_with_output().await.map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(failure_message(&output.stderr, endpoint == "user").to_string());
        }
        serde_json::from_slice(&output.stdout).map_err(|_| "glab 返回了无效的 JSON".into())
    };
    tokio::time::timeout(Duration::from_secs(30), send)
        .await
        .map_err(|_| "glab 请求超时".to_string())?
}

#[tauri::command]
pub async fn glab_account(instance_url: String) -> Result<String, String> {
    let user = api(&instance_url, "user", None).await?;
    user["username"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "无法确认 glab 登录账号".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_diagnostics_are_actionable_without_exposing_output() {
        for (message, account_check, expected) in [
            ("HTTP 401: invalid token", true, "重新登录"),
            ("HTTP 403: forbidden", true, "API 访问权限"),
            ("HTTP 403: forbidden", false, "项目权限"),
            ("dial tcp: no such host", true, "网络"),
            ("http: server gave HTTP response to HTTPS client", true, "协议"),
            ("x509: certificate signed by unknown authority", true, "证书"),
            ("context deadline exceeded", true, "超时"),
            ("unrecognized failure", true, "登录状态"),
        ] {
            let diagnostic = format!("{message}\nPrivate-Token: secret-for-test");
            let result = failure_message(diagnostic.as_bytes(), account_check);
            assert!(result.contains(expected));
            assert!(!result.contains("secret-for-test"));
        }
    }
    #[test]
    fn cli_instances_bind_to_exact_protocol_host_and_port() {
        for (instance, protocol, port) in [
            ("http://git.example", "http", None),
            ("http://git.example:8080", "http", Some(8080)),
            ("https://git.example:8443/", "https", Some(8443)),
        ] {
            let url = cli_endpoint(instance).unwrap();
            assert_eq!(url.scheme(), protocol);
            assert_eq!(url.host_str(), Some("git.example"));
            assert_eq!(url.port(), port);
        }
        for bad in [
            "ssh://git.example",
            "https://git.example/path",
            "https://user@git.example",
            "https://git.example?x=1",
        ] {
            assert!(cli_endpoint(bad).is_err());
        }
    }
}
