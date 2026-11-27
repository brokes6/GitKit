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
            // Diagnostic output can contain request headers when the CLI is configured for debugging.
            return Err(format!("glab 请求失败，请检查 {host} 的登录状态和项目权限"));
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
