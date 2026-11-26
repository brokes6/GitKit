use super::platform_request::{
    browser_url, create, github_request, gitlab_request, http_client, lookup, resolve_target, PlatformRequest,
    Provider, RepoIdentity, Transport,
};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[test]
fn resolves_public_enterprise_and_gitlab_targets() {
    let github = resolve_target("github", "", "git@github.com:Owner/Repo.git").unwrap();
    assert_eq!(github.api_base, "https://api.github.com");
    assert_eq!(github.web_origin, "https://github.com");
    assert_eq!(github.path, "Owner/Repo");
    assert_eq!(github.cli_host, None);
    assert_eq!(resolve_target("github", "https://api.github.com/", "https://github.com/o/r").unwrap().api_base, "https://api.github.com");

    for (instance, api) in [
        ("https://ghe.example.com:8443/", "https://ghe.example.com:8443/api/v3"),
        ("https://ghe.example.com/api/v3", "https://ghe.example.com/api/v3"),
    ] {
        let target = resolve_target("github", instance, "ssh://git@ghe.example.com:2222/team/app.git").unwrap();
        assert_eq!(target.api_base, api, "{instance}");
        assert_eq!(target.path, "team/app");
    }
    let sub = resolve_target("github", "https://git.example.com/enterprise", "https://git.example.com/enterprise/team/app.git").unwrap();
    assert_eq!(sub.api_base, "https://git.example.com/enterprise/api/v3");
    assert_eq!(sub.path, "team/app");

    let gitlab = resolve_target("gitlab", "https://GitLab.example.com", "git@gitlab.example.com:group/sub/project.git").unwrap();
    assert_eq!(gitlab.provider, Provider::Gitlab);
    assert_eq!(gitlab.api_base, "https://gitlab.example.com/api/v4");
    assert_eq!(gitlab.path, "group/sub/project");
    assert_eq!(gitlab.cli_host.as_deref(), Some("gitlab.example.com"));
    assert_eq!(
        resolve_target("gitlab", "https://gitlab.example.com:8443", "https://gitlab.example.com:8443/g/p.git").unwrap().cli_host.as_deref(),
        Some("gitlab.example.com:8443")
    );

    // Sub-path / plain-HTTP instances: HTTPS remote prefix stripped, no CLI.
    let nested = resolve_target("gitlab", "https://example.com/gitlab/", "https://example.com/gitlab/group/project.git").unwrap();
    assert_eq!(nested.api_base, "https://example.com/gitlab/api/v4");
    assert_eq!(nested.path, "group/project");
    assert_eq!(nested.cli_host, None);
    assert_eq!(resolve_target("gitlab", "https://example.com/gitlab", "git@example.com:group/project.git").unwrap().path, "group/project");
    assert_eq!(resolve_target("gitlab", "http://gitlab.local", "http://gitlab.local/g/p").unwrap().cli_host, None);
}

#[test]
fn rejects_mismatched_hosts_and_invalid_inputs() {
    assert!(resolve_target("github", "", "git@gitlab.com:o/r.git").is_err());
    assert!(resolve_target("gitlab", "https://gitlab.example.com", "git@github.com:o/r.git").is_err());
    assert!(resolve_target("gitlab", "", "git@gitlab.example.com:g/p.git").is_err());
    assert!(resolve_target("github", "", "git@github.com:o/r/extra.git").is_err());
    assert!(resolve_target("github", "", "../local").is_err());
    assert!(resolve_target("bitbucket", "", "git@github.com:o/r.git").is_err());
    for instance in ["https://u:p@ghe.example.com", "https://ghe.example.com?x=1", "ghe.example.com", "file:///x"] {
        assert!(resolve_target("github", instance, "git@ghe.example.com:o/r.git").is_err(), "{instance}");
    }
}

fn github_pull(id: u64, number: u64, head_ref: &str, head_repo: Value, base_repo_id: u64, url: &str) -> Value {
    json!({
        "id": id, "number": number, "state": "open", "title": format!("PR {number}"), "html_url": url,
        "head": { "ref": head_ref, "repo": head_repo },
        "base": { "ref": "main", "repo": { "id": base_repo_id, "full_name": "o/r" } },
    })
}

#[test]
fn github_parser_excludes_forks_deleted_forks_other_branches_and_hosts() {
    let repo = RepoIdentity { id: Some(7), full_name: "o/r".into() };
    let own = github_pull(1, 3, "feat", json!({"id": 7, "full_name": "o/r"}), 7, "https://github.com/o/r/pull/3");
    assert_eq!(
        github_request(&own, &repo, "feat", "https://github.com"),
        Some(PlatformRequest { id: 1, number: 3, url: "https://github.com/o/r/pull/3".into(), title: "PR 3".into(), target: "main".into(), source: "feat".into() })
    );
    let fork = github_pull(2, 4, "feat", json!({"id": 99, "full_name": "o/r"}), 7, "https://github.com/o/r/pull/4");
    assert!(github_request(&fork, &repo, "feat", "https://github.com").is_none());
    let deleted = github_pull(2, 4, "feat", Value::Null, 7, "https://github.com/o/r/pull/4");
    assert!(github_request(&deleted, &repo, "feat", "https://github.com").is_none());
    assert!(github_request(&own, &repo, "other", "https://github.com").is_none());
    assert!(github_request(&own, &repo, "feat", "https://ghe.example.com").is_none());
    let creds = github_pull(1, 3, "feat", json!({"id": 7}), 7, "https://x:y@github.com/o/r/pull/3");
    assert!(github_request(&creds, &repo, "feat", "https://github.com").is_none());
}

#[test]
fn gitlab_parser_requires_same_source_and_target_project() {
    let mr = |source_project: u64, target_project: u64| json!({
        "id": 11, "iid": 5, "title": "MR", "web_url": "https://gl.example.com/g/p/-/merge_requests/5",
        "source_branch": "feat", "target_branch": "develop", "state": "opened",
        "source_project_id": source_project, "target_project_id": target_project, "project_id": target_project,
    });
    let parsed = gitlab_request(&mr(4, 4), 4, "feat", "https://gl.example.com").unwrap();
    assert_eq!((parsed.id, parsed.number, parsed.target.as_str()), (11, 5, "develop"));
    assert!(gitlab_request(&mr(9, 4), 4, "feat", "https://gl.example.com").is_none());
    assert!(gitlab_request(&mr(4, 9), 4, "feat", "https://gl.example.com").is_none());
    assert!(gitlab_request(&mr(4, 4), 4, "feat", "evil.example.com").is_none());
}

#[test]
fn browser_url_is_limited_to_the_instance_and_safe_characters() {
    assert_eq!(browser_url(" https://github.com/o/r/pull/3 ", "", "github").unwrap(), "https://github.com/o/r/pull/3");
    assert!(browser_url("https://ghe.example.com/o/r/pull/3", "https://ghe.example.com/api/v3", "github").is_ok());
    assert!(browser_url("https://gl.example.com/g/p/-/merge_requests/5", "https://gl.example.com", "gitlab").is_ok());
    for url in [
        "https://github.com:444/o/r/pull/3", "http://github.com/o/r/pull/3",
        "https://evil.example.com/o/r/pull/3", "file:///etc/passwd", "javascript:alert(1)",
        "https://u:p@github.com/o/r", "https://github.com/o/r&calc", "https://github.com/%PATH%",
        "https://github.com/o/\nr", "https://github.com/o/r?q=a b",
    ] {
        assert!(browser_url(url, "", "github").is_err(), "{url}");
    }
    assert!(browser_url("https://gl.example.com/x", "", "gitlab").is_err());
}

#[test]
fn glab_transport_requires_https_root_gitlab_and_never_sends_http() {
    let runtime = runtime();
    let github = resolve_target("github", "", "git@github.com:o/r.git").unwrap();
    assert!(runtime.block_on(lookup(&Transport::Glab, &github, "feat")).is_err());
    let nested = resolve_target("gitlab", "https://example.com/gitlab", "git@example.com:g/p.git").unwrap();
    let error = runtime.block_on(lookup(&Transport::Glab, &nested, "feat")).unwrap_err();
    assert!(error.contains("HTTPS"), "{error}");
    let client = http_client().unwrap();
    let missing = runtime.block_on(lookup(&Transport::Http { client: &client, token: " " }, &nested, "feat")).unwrap_err();
    assert!(missing.contains("令牌"), "{missing}");
}

// --- HTTP round trips against a local mock ---------------------------------

struct Reply {
    status: u16,
    body: Value,
}

fn ok(body: Value) -> Reply {
    Reply { status: 200, body }
}

/// Serve `replies` sequentially, one per connection; record "METHOD target\nheaders\n\nbody".
fn serve(replies: Vec<Reply>) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let log = Arc::new(Mutex::new(Vec::new()));
    let recorded = log.clone();
    let server_origin = origin.clone();
    let handle = thread::spawn(move || {
        for reply in replies {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            let header_end = loop {
                let n = stream.read(&mut buffer).unwrap();
                assert!(n > 0, "request closed early");
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let head = String::from_utf8_lossy(&bytes[..header_end]).to_string();
            let length = head
                .lines()
                .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                .unwrap_or(0);
            while bytes.len() < header_end + length {
                let n = stream.read(&mut buffer).unwrap();
                assert!(n > 0, "body closed early");
                bytes.extend_from_slice(&buffer[..n]);
            }
            let body = String::from_utf8_lossy(&bytes[header_end..header_end + length]).to_string();
            recorded.lock().unwrap().push(format!("{head}{body}"));
            let payload = reply.body.to_string().replace("http://127.0.0.1:1/", &format!("{server_origin}/"));
            write!(
                stream,
                "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                reply.status,
                payload.len(),
                payload
            )
            .unwrap();
        }
    });
    (origin, log, handle)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

fn first_line(request: &str) -> &str {
    request.lines().next().unwrap()
}

#[test]
fn github_lookup_returns_default_branch_and_only_same_repo_open_pulls() {
    let (origin, log, handle) = serve(vec![
        ok(json!({"id": 7, "full_name": "o/r", "default_branch": "trunk"})),
        ok(json!([
            github_pull(1, 3, "feat/x", json!({"id": 7, "full_name": "o/r"}), 7, "http://127.0.0.1:1/o/r/pull/3"),
            github_pull(2, 9, "feat/x", json!({"id": 8, "full_name": "fork/r"}), 7, "http://127.0.0.1:1/o/r/pull/9"),
            github_pull(3, 10, "feat/x", json!({"id": 7, "full_name": "o/r"}), 7, "https://evil.example.com/o/r/pull/10"),
        ])),
    ]);
    let target = resolve_target("github", &origin, &format!("{origin}/o/r.git")).unwrap();
    let client = http_client().unwrap();
    let result = runtime()
        .block_on(lookup(&Transport::Http { client: &client, token: "tok" }, &target, "feat/x"))
        .unwrap();
    handle.join().unwrap();
    assert_eq!(result.default_branch, "trunk");
    assert_eq!(result.requests.iter().map(|r| r.number).collect::<Vec<_>>(), vec![3]);
    let log = log.lock().unwrap();
    assert_eq!(first_line(&log[0]), "GET /api/v3/repos/o/r HTTP/1.1");
    assert_eq!(first_line(&log[1]), "GET /api/v3/repos/o/r/pulls?state=open&head=o%3Afeat%2Fx&per_page=100 HTTP/1.1");
    assert!(log[1].to_ascii_lowercase().contains("authorization: bearer tok"));
}

#[test]
fn gitlab_lookup_distinguishes_none_from_failure() {
    let (origin, log, handle) = serve(vec![
        ok(json!({"id": 4, "path_with_namespace": "g/p", "default_branch": "main"})),
        ok(json!([{
            "id": 11, "iid": 5, "title": "fork", "web_url": "x", "state": "opened",
            "source_branch": "feat", "target_branch": "main", "source_project_id": 9, "target_project_id": 4,
        }])),
        Reply { status: 401, body: json!({"message": "401 Unauthorized tok-secret"}) },
    ]);
    let target = resolve_target("gitlab", &origin, &format!("{origin}/g/p.git")).unwrap();
    let client = http_client().unwrap();
    let transport = Transport::Http { client: &client, token: "tok-secret" };
    let runtime = runtime();
    let none = runtime.block_on(lookup(&transport, &target, "feat")).unwrap();
    assert_eq!(none.default_branch, "main");
    assert!(none.requests.is_empty());
    let failed = runtime.block_on(lookup(&transport, &target, "feat")).unwrap_err();
    handle.join().unwrap();
    assert!(!failed.contains("tok-secret"), "{failed}");
    let log = log.lock().unwrap();
    assert_eq!(first_line(&log[0]), "GET /api/v4/projects/g%2Fp HTTP/1.1");
    assert_eq!(first_line(&log[1]), "GET /api/v4/projects/4/merge_requests?state=opened&source_branch=feat&per_page=100 HTTP/1.1");
    assert!(log[1].contains("private-token: tok-secret") || log[1].contains("PRIVATE-TOKEN: tok-secret"));
}

#[test]
fn create_returns_identity_and_rejects_mismatched_responses() {
    let (origin, log, handle) = serve(vec![
        ok(json!({
            "id": 21, "iid": 6, "project_id": 4, "title": "Add", "web_url": "PLACEHOLDER",
            "source_branch": "feat", "target_branch": "main", "source_project_id": 4, "target_project_id": 4,
        })),
        ok(json!({
            "id": 22, "iid": 7, "project_id": 4, "title": "Add", "web_url": "https://evil.example.com/x",
            "source_branch": "feat", "target_branch": "main", "source_project_id": 4, "target_project_id": 4,
        })),
    ]);
    let target = resolve_target("gitlab", &origin, &format!("{origin}/g/p.git")).unwrap();
    let client = http_client().unwrap();
    let transport = Transport::Http { client: &client, token: "tok" };
    let runtime = runtime();
    // The first reply's URL is not on the instance host either (placeholder).
    assert!(runtime.block_on(create(&transport, &target, "feat", "main", "Add", "body")).is_err());
    assert!(runtime.block_on(create(&transport, &target, "feat", "main", "Add", "body")).is_err());
    handle.join().unwrap();
    let log = log.lock().unwrap();
    assert_eq!(first_line(&log[0]), "POST /api/v4/projects/g%2Fp/merge_requests HTTP/1.1");
    let sent: Value = serde_json::from_str(log[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(sent, json!({"source_branch": "feat", "target_branch": "main", "title": "Add", "description": "body"}));

    let (origin, _log, handle) = serve(vec![ok(json!({
        "id": 30, "number": 12, "title": "Add", "html_url": "PLACEHOLDER",
        "head": {"ref": "feat", "repo": {"id": 7, "full_name": "o/r"}},
        "base": {"ref": "main", "repo": {"id": 7, "full_name": "o/r"}},
    }))]);
    let target = resolve_target("github", &origin, &format!("{origin}/o/r.git")).unwrap();
    let transport = Transport::Http { client: &client, token: "tok" };
    assert!(runtime.block_on(create(&transport, &target, "feat", "main", "Add", "")).is_err());
    handle.join().unwrap();
}

#[test]
fn create_success_on_instance_host() {
    // The mock substitutes its bound origin into response URLs.
    let origin = "http://127.0.0.1:1";
    let (origin2, _log, handle) = serve(vec![
        ok(json!({
            "id": 30, "number": 12, "title": "Add", "html_url": format!("{origin}/o/r/pull/12"),
            "head": {"ref": "feat", "repo": {"id": 7, "full_name": "o/r"}},
            "base": {"ref": "main", "repo": {"id": 7, "full_name": "o/r"}},
        })),
        ok(json!({
            "id": 31, "number": 13, "title": "Fork", "html_url": format!("{origin}/o/r/pull/13"),
            "head": {"ref": "feat", "repo": {"id": 8, "full_name": "fork/r"}},
            "base": {"ref": "main", "repo": {"id": 7, "full_name": "o/r"}},
        })),
        ok(json!({
            "id": 41, "iid": 3, "project_id": 4, "title": "MR", "web_url": format!("{origin}/g/p/-/merge_requests/3"),
            "source_branch": "feat", "target_branch": "main", "source_project_id": 4, "target_project_id": 4,
        })),
    ]);
    let client = http_client().unwrap();
    let transport = Transport::Http { client: &client, token: "tok" };
    let runtime = runtime();
    let github = resolve_target("github", &origin2, &format!("{origin2}/o/r.git")).unwrap();
    let created = runtime.block_on(create(&transport, &github, "feat", "main", "Add", "")).unwrap();
    assert_eq!((created.id, created.number, created.source.as_str(), created.target.as_str()), (30, 12, "feat", "main"));
    assert!(runtime.block_on(create(&transport, &github, "feat", "main", "Add", "")).is_err());
    let gitlab = resolve_target("gitlab", &origin2, &format!("{origin2}/g/p.git")).unwrap();
    let mr = runtime.block_on(create(&transport, &gitlab, "feat", "main", "MR", "")).unwrap();
    assert_eq!((mr.id, mr.number), (41, 3));
    handle.join().unwrap();
}
