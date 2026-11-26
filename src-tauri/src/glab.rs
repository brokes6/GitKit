use reqwest::Url;
use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// Only a hostname (including an optional HTTPS port) crosses the CLI boundary.
fn cli_host(instance: &str) -> Result<String, String> {
    let url = Url::parse(instance).map_err(|_| "请输入 GitLab 的 HTTPS 实例地址")?;
    if url.scheme() != "https"
        || url.host().is_none()
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("glab 连接需要 HTTPS 根地址，例如 https://gitlab.com".into());
    }
    Ok(url
        .origin()
        .ascii_serialization()
        .trim_start_matches("https://")
        .to_string())
}

pub(crate) async fn api(host: &str, endpoint: &str, body: Option<Value>) -> Result<Value, String> {
    let host = cli_host(&format!("https://{host}"))?;
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
        "GITLAB_API_HOST",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GLAB_ENABLE_CI_AUTOLOGIN",
        "GITLAB_URI",
        "GITLAB_URL",
    ] {
        cmd.env_remove(var);
    }
    cmd.env("GLAB_CHECK_UPDATE", "false")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "api",
            "--hostname",
            &host,
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
    let user = api(&cli_host(&instance_url)?, "user", None).await?;
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
    fn cli_instances_bind_to_exact_https_hosts() {
        assert_eq!(
            cli_host("https://git.example:8443/").unwrap(),
            "git.example:8443"
        );
        for bad in [
            "http://git.example",
            "https://git.example/path",
            "https://user@git.example",
            "https://git.example?x=1",
        ] {
            assert!(cli_host(bad).is_err());
        }
    }
}
