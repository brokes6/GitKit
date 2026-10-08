use super::*;
use serde_json::json;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

const SHA: &str = "1111111111111111111111111111111111111111";
const BASE: &str = "2222222222222222222222222222222222222222";
const START: &str = "3333333333333333333333333333333333333333";

fn user(id: u64) -> Value {
    json!({"id": id, "name": format!("User {id}"), "username": format!("u{id}")})
}

fn project() -> Value {
    json!({"id": 9, "name": "app", "path_with_namespace": "team/sub/app", "squash_option": "default_off",
        "remove_source_branch_after_merge": false, "only_allow_merge_if_pipeline_succeeds": true,
        "allow_merge_on_skipped_pipeline": false, "only_allow_merge_if_all_discussions_are_resolved": true})
}

fn mr(iid: u64, author: u64, assignees: &[u64], reviewers: &[u64]) -> Value {
    json!({"id": 100 + iid, "iid": iid, "project_id": 9, "references": {"full": format!("team/sub/app!{iid}")}, "title": format!("MR {iid}"), "state": "opened",
        "description": "Only loaded for details", "source_branch": "feature/ui", "target_branch": "main",
        "author": user(author), "assignees": assignees.iter().map(|id| user(*id)).collect::<Vec<_>>(),
        "reviewers": reviewers.iter().map(|id| user(*id)).collect::<Vec<_>>(), "draft": false,
        "updated_at": "2026-10-06T00:00:00Z", "sha": SHA, "detailed_merge_status": "mergeable",
        "head_pipeline": {"status": "success"}, "user": {"can_merge": true}, "blocking_discussions_resolved": true,
        "has_conflicts": false, "diff_refs": {"base_sha": BASE, "start_sha": START, "head_sha": SHA},
        "squash": false, "should_remove_source_branch": false, "force_remove_source_branch": false, "source_project_id": 9})
}

fn other_project_mr(iid: u64, author: u64, assignees: &[u64], reviewers: &[u64]) -> Value {
    let mut request = mr(iid, author, assignees, reviewers);
    request["id"] = json!(1000 + iid);
    request["project_id"] = json!(10);
    request["source_project_id"] = json!(10);
    request["references"]["full"] = json!(format!("other/mobile!{iid}"));
    request
}

fn other_project() -> Value {
    let mut value = project();
    value["id"] = json!(10);
    value["name"] = json!("mobile");
    value["path_with_namespace"] = json!("other/mobile");
    value
}

fn version(id: u64) -> Value {
    json!({"id": id, "created_at": "2026-10-06T00:00:00Z", "state": "collected", "real_size": "1",
        "base_commit_sha": BASE, "start_commit_sha": START, "head_commit_sha": SHA})
}

fn reviewed_refs() -> DiffRefs {
    DiffRefs {
        base_sha: BASE.into(),
        start_sha: START.into(),
        head_sha: SHA.into(),
    }
}

struct Step {
    method: &'static str,
    target: &'static str,
    status: u16,
    value: Value,
    headers: Vec<(&'static str, String)>,
    drop_response: bool,
    raw_body: Option<Vec<u8>>,
    declared_length: Option<usize>,
}

fn step(method: &'static str, target: &'static str, value: Value) -> Step {
    Step {
        method,
        target,
        status: 200,
        value,
        headers: Vec::new(),
        drop_response: false,
        raw_body: None,
        declared_length: None,
    }
}

fn get(target: &'static str, value: Value) -> Step {
    step("GET", target, value)
}

fn error_step(target: &'static str, status: u16) -> Step {
    let mut step = get(
        target,
        json!({"message": "fixture-secret https://user:fixture-secret@example.test/?token=fixture-secret"}),
    );
    step.status = status;
    step
}

fn mock(steps: Vec<Step>) -> (Config, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let handle = thread::spawn(move || {
        let mut connections: Vec<(TcpStream, Vec<u8>)> = Vec::new();
        for step in steps {
            let until = std::time::Instant::now() + Duration::from_secs(30);
            let mut buffer = [0u8; 4096];
            let (mut stream, mut request) = 'request: loop {
                assert!(
                    std::time::Instant::now() < until,
                    "mock timed out waiting for {} {}",
                    step.method,
                    step.target
                );
                loop {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            stream.set_nonblocking(true).unwrap();
                            connections.push((stream, Vec::new()));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error) => panic!("mock accept: {error}"),
                    }
                }
                let mut index = 0;
                while index < connections.len() {
                    let (stream, bytes) = &mut connections[index];
                    match stream.read(&mut buffer) {
                        Ok(0) if bytes.is_empty() => {
                            connections.swap_remove(index);
                            continue;
                        }
                        Ok(0) => panic!("request closed before headers"),
                        Ok(n) => {
                            bytes.extend_from_slice(&buffer[..n]);
                            if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                                break 'request connections.swap_remove(index);
                            }
                            continue;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error) => panic!("mock request headers: {error}"),
                    }
                    index += 1;
                }
                // Retain empty connections: the client may have connected but
                // not yet received CPU time to write during the parallel suite.
                // Poll all connections so an unused one cannot starve a request.
                thread::sleep(Duration::from_millis(5));
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(100)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let header_end = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .unwrap()
                + 4;
            let headers = String::from_utf8_lossy(&request[..header_end]).into_owned();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            while request.len() < header_end + content_length {
                match stream.read(&mut buffer) {
                    Ok(0) => panic!("request closed before body"),
                    Ok(n) => request.extend_from_slice(&buffer[..n]),
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock
                                | std::io::ErrorKind::TimedOut
                                | std::io::ErrorKind::Interrupted
                        ) && std::time::Instant::now() < until => {}
                    Err(error) => panic!("mock request body: {error}"),
                }
            }
            let request = String::from_utf8(request).unwrap();
            assert!(
                request.starts_with(&format!("{} ", step.method)),
                "{request}"
            );
            assert!(
                request.lines().next().unwrap().contains(step.target),
                "{request}"
            );
            let auth = if step.target.contains("/api/graphql") {
                "authorization: bearer fixture-secret"
            } else {
                "private-token: fixture-secret"
            };
            assert!(request.to_ascii_lowercase().contains(auth));
            recorded.lock().unwrap().push(request);
            if step.drop_response {
                continue;
            }
            let body = step
                .raw_body
                .unwrap_or_else(|| serde_json::to_vec(&step.value).unwrap());
            let extra = step
                .headers
                .into_iter()
                .map(|(name, value)| format!("{name}: {value}\r\n"))
                .collect::<String>();
            write!(stream, "HTTP/1.1 {} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n", step.status, step.declared_length.unwrap_or(body.len()), extra).unwrap();
            stream.write_all(&body).unwrap();
        }
    });
    (
        Config {
            url: format!("http://{address}/gitlab"),
            token: "fixture-secret".into(),
        },
        requests,
        handle,
    )
}

fn run<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

fn preflight(request: Value) -> Vec<Step> {
    vec![
        get("/gitlab/api/v4/user", user(7)),
        get("/gitlab/api/v4/projects/9", project()),
        get("/gitlab/api/v4/projects/9/merge_requests/1", request),
        get(
            "/merge_requests/1/approvals",
            json!({"approvals_required": 1, "approvals_left": 0, "approved_by": [{"user": user(8)}]}),
        ),
        get(
            "/repository/branches/feature%2Fui",
            json!({"protected": false, "default": false, "can_push": true}),
        ),
    ]
}

fn merge_preflight(request: Value) -> Vec<Step> {
    let mut steps = preflight(request);
    steps.insert(4, get("/versions", json!([version(5)])));
    steps
}

fn download_preflight(request: Value, revision: Value) -> Vec<Step> {
    vec![
        get("/gitlab/api/v4/user", user(7)),
        get("/gitlab/api/v4/projects/9", project()),
        get("/gitlab/api/v4/projects/9/merge_requests/1", request),
        get("/merge_requests/1/versions", json!([revision])),
    ]
}

fn raw_diff_step(bytes: &[u8]) -> Step {
    let mut response = get("/merge_requests/1/raw_diffs", Value::Null);
    response.raw_body = Some(bytes.to_vec());
    response
}

fn download_postflight(request: Value, revision: Value) -> Vec<Step> {
    vec![
        get("/gitlab/api/v4/projects/9/merge_requests/1", request),
        get("/merge_requests/1/versions", json!([revision])),
    ]
}

#[test]
fn raw_diff_download_preserves_original_bytes_and_pins_revision() {
    let bytes = b"diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\ndiff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\ndiff --git a/README b/README\n--- a/README\n+++ b/README\n@@ -1 +1 @@\n-old\n+new\xff\n";
    let mut revision = version(5);
    revision["real_size"] = json!("3");
    let request = mr(1, 7, &[], &[]);
    let mut steps = download_preflight(request.clone(), revision.clone());
    steps.push(raw_diff_step(bytes));
    steps.extend(download_postflight(request, revision));
    let (config, requests, server) = mock(steps);
    let result = run(download_diff(&config, 101, 9, 1, "main", 5, &reviewed_refs())).unwrap();
    server.join().unwrap();
    assert_eq!(result.bytes, bytes);
    assert_eq!(result.version_id, 5);
    assert_eq!(result.refs, reviewed_refs());
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 7);
    assert!(requests[4].to_ascii_lowercase().contains("accept: text/plain"));
    assert!(requests.iter().all(|request| request.starts_with("GET ")));
}

#[test]
fn raw_diff_download_rejects_revision_changes_after_transfer() {
    for change in ["head", "base", "target", "version"] {
        let request = mr(1, 7, &[], &[]);
        let mut current = request.clone();
        let mut revision = version(5);
        match change {
            "head" => current["sha"] = json!(BASE),
            "base" => current["diff_refs"]["base_sha"] = json!(START),
            "target" => current["target_branch"] = json!("release"),
            "version" => revision["id"] = json!(6),
            _ => unreachable!(),
        }
        let mut steps = download_preflight(request, version(5));
        steps.push(raw_diff_step(b"diff --git a/README b/README\n"));
        steps.extend(download_postflight(current, revision));
        let (config, _, server) = mock(steps);
        let result = run(download_diff(&config, 101, 9, 1, "main", 5, &reviewed_refs()));
        server.join().unwrap();
        assert_eq!(result.err().unwrap().kind, "conflict", "{change}");
    }
}

#[test]
fn raw_diff_download_checks_global_identity_before_export() {
    let mut request = mr(1, 7, &[], &[]);
    request["id"] = json!(999);
    let mut steps = download_preflight(request, version(5));
    steps.pop();
    let (config, requests, server) = mock(steps);
    let result = run(download_diff(&config, 101, 9, 1, "main", 5, &reviewed_refs()));
    server.join().unwrap();
    assert_eq!(result.err().unwrap().kind, "invalid_response");
    assert_eq!(requests.lock().unwrap().len(), 3);
}

#[test]
fn raw_diff_download_rejects_unready_or_unmeasurable_diff_before_transfer() {
    for change in ["processing", "overflow", "missing_count", "limited_count", "patch_pending", "version"] {
        let mut revision = version(5);
        match change {
            "processing" | "overflow" => revision["state"] = json!(change),
            "missing_count" => { revision.as_object_mut().unwrap().remove("real_size"); }
            "limited_count" => revision["real_size"] = json!("1000+"),
            "patch_pending" => revision["patch_id_sha"] = Value::Null,
            "version" => revision["id"] = json!(6),
            _ => unreachable!(),
        }
        let (config, requests, server) = mock(download_preflight(mr(1, 7, &[], &[]), revision));
        let result = run(download_diff(&config, 101, 9, 1, "main", 5, &reviewed_refs()));
        server.join().unwrap();
        assert!(result.is_err(), "{change}");
        assert_eq!(requests.lock().unwrap().len(), 4);
    }
}

#[test]
fn raw_diff_download_rejects_limited_or_unexpected_raw_response() {
    for bytes in [b"<html>Sign in</html>".as_slice(), b"".as_slice(), b"diff --git a/one b/one\ndiff --git a/two b/two\n".as_slice()] {
        let request = mr(1, 7, &[], &[]);
        let mut steps = download_preflight(request.clone(), version(5));
        steps.push(raw_diff_step(bytes));
        steps.extend(download_postflight(request, version(5)));
        let (config, _, server) = mock(steps);
        let result = run(download_diff(&config, 101, 9, 1, "main", 5, &reviewed_refs()));
        server.join().unwrap();
        assert_eq!(result.err().unwrap().kind, "invalid_response");
    }
}

#[test]
fn raw_diff_download_bounds_response_and_redacts_failures() {
    for status in [200, 401, 403, 404, 405, 429, 501] {
        let mut response = error_step("/merge_requests/1/raw_diffs", status);
        if status == 200 {
            response.declared_length = Some(MAX_RAW_DIFF_BYTES + 1);
        }
        if status == 429 {
            response.headers.push(("Retry-After", "90".into()));
        }
        let mut steps = download_preflight(mr(1, 7, &[], &[]), version(5));
        steps.push(response);
        let (config, _, server) = mock(steps);
        let result = run(download_diff(&config, 101, 9, 1, "main", 5, &reviewed_refs()));
        server.join().unwrap();
        let failure = result.err().unwrap();
        assert!(!failure.message.contains("fixture-secret"));
        assert!(!failure.message.contains("http"));
        if status == 429 {
            assert_eq!(failure.retry_after, Some(90));
        }
    }
}

#[test]
fn raw_diff_download_accepts_an_empty_comparison_only_when_confirmed_empty() {
    let mut revision = version(5);
    revision["real_size"] = json!("0");
    let request = mr(1, 7, &[], &[]);
    let mut steps = download_preflight(request.clone(), revision.clone());
    steps.push(raw_diff_step(b""));
    steps.extend(download_postflight(request, revision));
    let (config, _, server) = mock(steps);
    let result = run(download_diff(&config, 101, 9, 1, "main", 5, &reviewed_refs())).unwrap();
    server.join().unwrap();
    assert!(result.bytes.is_empty());
}

fn message_summary(config: &Config) -> Summary {
    let context = Context::new(config).unwrap();
    let request: RawMergeRequest = decode(mr(1, 7, &[], &[])).unwrap();
    request
        .summary(
            &context,
            &decode(user(7)).unwrap(),
            Some(&decode(project()).unwrap()),
            true,
        )
        .unwrap()
}

fn graphql_messages() -> Value {
    json!({"data": {
        "currentUser": {"id": "gid://gitlab/User/7"},
        "project": {"id": "gid://gitlab/Project/9", "fullPath": "team/sub/app", "mergeRequest": {
            "id": "gid://gitlab/MergeRequest/101", "iid": "1", "diffHeadSha": SHA,
            "sourceBranch": "feature/ui", "targetBranch": "main", "title": "MR 1",
            "description": "Only loaded for details", "updatedAt": "2026-10-06T00:00:00.000Z",
            "defaultMergeCommitMessage": "Release: MR 1\n\nCloses #42\n\nProject template footer",
            "defaultSquashCommitMessage": "Custom squash title\n\nCommit details from GitLab",
        }},
    }})
}

#[test]
fn default_messages_use_graphql_named_fields_and_preserve_expanded_project_templates() {
    let (config, requests, server) = mock(vec![step(
        "POST",
        "/gitlab/api/graphql",
        graphql_messages(),
    )]);
    let known = message_summary(&config);
    let result = run(commit_messages(&config, &known, 7)).unwrap();
    server.join().unwrap();
    assert_eq!(result.mr_id, 101);
    assert_eq!(result.project_id, 9);
    assert_eq!(result.iid, 1);
    assert_eq!(result.sha, SHA);
    assert_eq!(result.target_branch, "main");
    assert_eq!(
        result.merge_commit_message,
        "Release: MR 1\n\nCloses #42\n\nProject template footer"
    );
    assert_eq!(
        result.squash_commit_message,
        "Custom squash title\n\nCommit details from GitLab"
    );
    let request = requests.lock().unwrap().last().unwrap().clone();
    assert!(request.starts_with("POST /gitlab/api/graphql "));
    assert!(!request.to_ascii_lowercase().contains("private-token:"));
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    let query = body["query"].as_str().unwrap();
    assert!(query.contains("query GitKitCommitMessages"));
    assert!(query.contains("defaultMergeCommitMessage"));
    assert!(query.contains("defaultSquashCommitMessage"));
    assert!(!query.contains("WithDescription"));
    assert!(!query.contains("mutation"));
    assert_eq!(
        body["variables"],
        json!({"projectPath": "team/sub/app", "iid": "1"})
    );
    assert!(!body.to_string().contains("fixture-secret"));
}

#[test]
fn default_messages_reject_changed_server_identity_or_revision() {
    for change in [
        "user",
        "project",
        "path",
        "mr",
        "iid",
        "sha",
        "source",
        "target",
        "title",
        "description",
        "updated",
    ] {
        let mut value = graphql_messages();
        match change {
            "user" => value["data"]["currentUser"]["id"] = json!("gid://gitlab/User/8"),
            "project" => value["data"]["project"]["id"] = json!("gid://gitlab/Project/10"),
            "path" => value["data"]["project"]["fullPath"] = json!("other/app"),
            _ => {
                let request = &mut value["data"]["project"]["mergeRequest"];
                let (field, value) = match change {
                    "mr" => ("id", "gid://gitlab/MergeRequest/201"),
                    "iid" => ("iid", "2"),
                    "sha" => ("diffHeadSha", BASE),
                    "source" => ("sourceBranch", "other/source"),
                    "target" => ("targetBranch", "release"),
                    "title" => ("title", "Updated title"),
                    "description" => ("description", "Updated body"),
                    "updated" => ("updatedAt", "2026-10-06T00:01:00Z"),
                    _ => unreachable!(),
                };
                request[field] = json!(value);
            }
        }
        let (config, requests, server) = mock(vec![step("POST", "/gitlab/api/graphql", value)]);
        let error = run(commit_messages(&config, &message_summary(&config), 7)).unwrap_err();
        server.join().unwrap();
        assert!(matches!(
            error.kind.as_str(),
            "stale" | "invalid_response" | "conflict"
        ));
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
}

#[test]
fn unavailable_graphql_default_messages_reject_partial_errors_nulls_and_oversized_text() {
    for change in [
        "errors",
        "project",
        "mr",
        "merge",
        "squash",
        "blank",
        "oversized",
    ] {
        let mut value = graphql_messages();
        match change {
            "errors" => {
                value["errors"] = json!([{"message": "fixture-secret internal details", "data": "valid fields must not be used"}])
            }
            "project" => value["data"]["project"] = Value::Null,
            "mr" => value["data"]["project"]["mergeRequest"] = Value::Null,
            _ => {
                let request = &mut value["data"]["project"]["mergeRequest"];
                match change {
                    "merge" => request["defaultMergeCommitMessage"] = Value::Null,
                    "squash" => request["defaultSquashCommitMessage"] = Value::Null,
                    "blank" => request["defaultMergeCommitMessage"] = json!("  \n"),
                    "oversized" => {
                        request["defaultMergeCommitMessage"] =
                            json!("x".repeat(MAX_COMMIT_MESSAGE_BYTES + 1))
                    }
                    _ => unreachable!(),
                }
            }
        }
        let (config, requests, server) = mock(vec![step("POST", "/gitlab/api/graphql", value)]);
        let error = run(commit_messages(&config, &message_summary(&config), 7)).unwrap_err();
        server.join().unwrap();
        assert_eq!(error.kind, "unsupported");
        assert!(!error.message.contains("fixture-secret"));
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
}

#[test]
fn default_message_reads_can_be_explicitly_retried_without_automatic_replay() {
    let mut lost = step("POST", "/gitlab/api/graphql", Value::Null);
    lost.drop_response = true;
    let (config, requests, server) = mock(vec![
        lost,
        step("POST", "/gitlab/api/graphql", graphql_messages()),
    ]);
    let known = message_summary(&config);
    run(async {
        assert!(commit_messages(&config, &known, 7).await.is_err());
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert!(commit_messages(&config, &known, 7).await.is_ok());
    });
    server.join().unwrap();
    assert_eq!(requests.lock().unwrap().len(), 2);
}

#[test]
fn graphql_default_reads_do_not_follow_authenticated_redirects() {
    let mut redirected = step("POST", "/gitlab/api/graphql", Value::Null);
    redirected.status = 302;
    redirected
        .headers
        .push(("Location", "https://other.example.test/api/graphql".into()));
    let (config, requests, server) = mock(vec![redirected]);
    let error = run(commit_messages(&config, &message_summary(&config), 7)).unwrap_err();
    server.join().unwrap();
    assert_eq!(error.kind, "invalid_config");
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert!(!error.message.contains("fixture-secret"));
}

#[test]
fn strict_account_instance_and_open_urls_preserve_subpaths_and_ports() {
    let config = Config {
        url: "https://gitlab.example.test:8443/instance/".into(),
        token: "fixture-secret".into(),
    };
    let context = Context::new(&config).unwrap();
    assert_eq!(
        validate_config(&config).unwrap(),
        "https://gitlab.example.test:8443/instance"
    );
    assert_eq!(
        context.endpoint(&["merge_requests"], &[]).unwrap().as_str(),
        "https://gitlab.example.test:8443/instance/api/v4/merge_requests"
    );
    for namespace in ["team/sub/app", "another/app"] {
        let url =
            format!("https://gitlab.example.test:8443/instance/{namespace}/-/merge_requests/1");
        assert_eq!(validated_web_url(&config, 9, 1, &url).unwrap(), url);
        assert!(validated_web_url(&config, 9, 2, &url).is_err());
    }
    for url in [
        "https://other.example.test:8443/instance/team/app/-/merge_requests/1",
        "https://gitlab.example.test/instance/team/app/-/merge_requests/1",
        "https://gitlab.example.test:8443/elsewhere/team/app/-/merge_requests/1",
        "https://user:fixture-secret@gitlab.example.test:8443/instance/team/app/-/merge_requests/1",
        "https://gitlab.example.test:8443/instance/team/app/-/merge_requests/1?next=secret",
        "https://gitlab.example.test:8443/instance/team/app/-/merge_requests/1#secret",
        "https://gitlab.example.test:8443/instance/team%2Fapp/-/merge_requests/1",
        "https://gitlab.example.test:8443/instance/team/../app/-/merge_requests/1",
        "https://gitlab.example.test:8443/instance/team/app/-/merge_requests/1&whoami",
        "https://gitlab.example.test:8443/instance/app/-/merge_requests/1",
    ] {
        assert!(validated_web_url(&config, 9, 1, url).is_err(), "{url}");
    }
    for url in [
        "https://user:fixture-secret@gitlab.example.test/instance",
        "https://gitlab.example.test/instance?token=fixture-secret",
        "https://gitlab.example.test/instance#fixture-secret",
        "https://gitlab.example.test/instance%2Fextra",
        "https://gitlab.example.test/instance/..",
        "https://gitlab.example.test/instance/./extra",
        "https://gitlab.example.test/instance//extra",
        "file:///fixture-secret",
    ] {
        let invalid = Config {
            url: url.into(),
            token: "fixture-secret".into(),
        };
        let error = validate_config(&invalid).unwrap_err();
        assert_eq!(error.kind, "invalid_config");
        assert!(!error.message.contains("fixture-secret"));
    }
}

#[test]
fn list_reads_every_page_deduplicates_roles_and_uses_authenticated_user_id() {
    let mut first = get("author_id=7", json!([mr(1, 7, &[7], &[])]));
    first.headers.push(("X-Next-Page", "2".into()));
    let steps = vec![
        get("/user", user(7)),
        first,
        get("page=2", json!([mr(2, 8, &[], &[7])])),
        get("assignee_id=7", json!([mr(1, 7, &[7], &[])])),
        get("reviewer_id=7", json!([mr(2, 8, &[], &[7])])),
    ];
    let (config, requests, server) = mock(steps);
    let result = run(list(&config)).unwrap();
    server.join().unwrap();
    assert_eq!(result.items.len(), 2);
    assert_eq!(
        result.items.iter().find(|mr| mr.iid == 1).unwrap().roles,
        ["author", "assignee"]
    );
    assert_eq!(
        result.items.iter().find(|mr| mr.iid == 2).unwrap().roles,
        ["reviewer"]
    );
    assert!(result.items.iter().all(|mr| mr.description.is_none()));
    assert_eq!(requests.lock().unwrap().len(), 5);
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("fixture-secret"));
}

#[test]
fn global_list_keeps_colliding_project_iids_and_filters_actual_roles_without_project_fanout() {
    let (config, requests, server) = mock(vec![
        get("/user", user(7)),
        get(
            "author_id=7",
            json!([mr(1, 7, &[7], &[7]), other_project_mr(1, 7, &[], &[])]),
        ),
        get(
            "assignee_id=7",
            json!([mr(1, 7, &[7], &[7]), mr(2, 8, &[], &[])]),
        ),
        get("reviewer_id=7", json!([mr(1, 7, &[7], &[7])])),
    ]);
    let result = run(list(&config)).unwrap();
    server.join().unwrap();
    assert_eq!(result.items.len(), 2);
    assert!(result.items.iter().all(|item| item.iid == 1));
    let first = result
        .items
        .iter()
        .find(|item| item.project_id == 9)
        .unwrap();
    let second = result
        .items
        .iter()
        .find(|item| item.project_id == 10)
        .unwrap();
    assert_eq!(first.roles, ["author", "assignee", "reviewer"]);
    assert_eq!(second.roles, ["author"]);
    assert_eq!(first.project_path_with_namespace, "team/sub/app");
    assert_eq!(second.project_path_with_namespace, "other/mobile");
    assert_eq!(
        second.web_url,
        format!("{}/other/mobile/-/merge_requests/1", config.url)
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    for request in &requests[1..] {
        let line = request.lines().next().unwrap();
        assert!(
            line.starts_with("GET /gitlab/api/v4/merge_requests?"),
            "{line}"
        );
        assert!(
            line.contains("state=opened") && line.contains("scope=all"),
            "{line}"
        );
    }
}

#[test]
fn project_namespace_uses_authoritative_references_or_same_instance_web_url_and_rejects_conflicts()
{
    let config = Config {
        url: "https://gitlab.example.test/instance".into(),
        token: "fixture-secret".into(),
    };
    let context = Context::new(&config).unwrap();
    let identity = decode(user(7)).unwrap();
    let mut raw = other_project_mr(1, 7, &[], &[]);
    raw["web_url"] = json!("https://gitlab.example.test/instance/other/mobile/-/merge_requests/1");
    assert_eq!(
        decode::<RawMergeRequest>(raw.clone())
            .unwrap()
            .summary(&context, &identity, None, false)
            .unwrap()
            .project_path_with_namespace,
        "other/mobile"
    );
    raw.as_object_mut().unwrap().remove("references");
    assert_eq!(
        decode::<RawMergeRequest>(raw.clone())
            .unwrap()
            .summary(&context, &identity, None, false)
            .unwrap()
            .project_path_with_namespace,
        "other/mobile"
    );
    for reference in [
        "other/mobile!2",
        "other/../mobile!1",
        "other%2Fmobile!1",
        "other/app!1",
    ] {
        raw["references"] = json!({"full": reference});
        assert_eq!(
            decode::<RawMergeRequest>(raw.clone())
                .unwrap()
                .summary(&context, &identity, None, false)
                .unwrap_err()
                .kind,
            "invalid_response"
        );
    }
    raw["references"] = json!({"full": "other/mobile!1"});
    raw["web_url"] = json!("https://other.example.test/other/mobile/-/merge_requests/1");
    assert!(decode::<RawMergeRequest>(raw)
        .unwrap()
        .summary(&context, &identity, None, false)
        .is_err());
}

#[test]
fn global_list_rejects_an_id_that_changes_project_between_role_responses() {
    let mut collision = other_project_mr(1, 7, &[7], &[]);
    collision["id"] = json!(101);
    let (config, _, server) = mock(vec![
        get("/user", user(7)),
        get("author_id=7", json!([mr(1, 7, &[7], &[])])),
        get("assignee_id=7", json!([collision])),
    ]);
    assert_eq!(run(list(&config)).unwrap_err().kind, "invalid_response");
    server.join().unwrap();
}

#[test]
fn cached_identity_list_only_requests_three_roles() {
    let (config, requests, server) = mock(vec![
        get("author_id=7", json!([])),
        get("assignee_id=7", json!([])),
        get("reviewer_id=7", json!([])),
    ]);
    let identity = decode(user(7)).unwrap();
    assert!(run(list_resolved(&config, &identity))
        .unwrap()
        .items
        .is_empty());
    server.join().unwrap();
    assert_eq!(requests.lock().unwrap().len(), 3);
}

#[test]
fn incomplete_role_schema_and_partial_pagination_never_become_successful_empty_lists() {
    let mut raw = mr(1, 7, &[], &[]);
    raw.as_object_mut().unwrap().remove("reviewers");
    let (config, _, server) = mock(vec![
        get("/user", user(7)),
        get("author_id=7", json!([raw])),
    ]);
    assert_eq!(run(list(&config)).unwrap_err().kind, "unsupported");
    server.join().unwrap();
    let mut first = get("author_id=7", json!([mr(1, 7, &[], &[])]));
    first.headers.push(("X-Next-Page", "2".into()));
    let (config, _, server) = mock(vec![
        get("/user", user(7)),
        first,
        error_step("page=2", 503),
    ]);
    let error = run(list(&config)).unwrap_err();
    assert_eq!(error.kind, "server");
    assert!(!error.message.contains("fixture-secret"));
    server.join().unwrap();
}

#[test]
fn authenticated_redirects_are_not_followed() {
    let mut redirect = error_step("/user", 302);
    redirect.headers.push((
        "Location",
        "https://other.example.test/?token=fixture-secret".into(),
    ));
    let (config, requests, server) = mock(vec![redirect]);
    let error = run(list(&config)).unwrap_err();
    assert_eq!(error.kind, "invalid_config");
    assert!(!error.message.contains("fixture-secret"));
    server.join().unwrap();
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[test]
fn status_errors_are_redacted_and_merge_permission_401_does_not_stop_account() {
    let mut headers = header::HeaderMap::new();
    headers.insert(header::RETRY_AFTER, header::HeaderValue::from_static("137"));
    assert_eq!(
        status_error(429, &headers, false, false).retry_after,
        Some(137)
    );
    assert_eq!(
        status_error(401, &headers, false, false).kind,
        "unauthorized"
    );
    assert_eq!(status_error(401, &headers, true, false).kind, "forbidden");
    assert_eq!(status_error(403, &headers, false, false).kind, "forbidden");
    assert_eq!(status_error(404, &headers, false, false).kind, "not_found");
    assert_eq!(status_error(409, &headers, true, false).kind, "conflict");
    let future = chrono::Utc::now() + chrono::Duration::seconds(130);
    assert!(retry_after(Some(&future.to_rfc2822())).is_some_and(|seconds| seconds >= 128));
    assert_eq!(retry_after(Some("invalid")), None);
}

#[test]
fn pagination_links_cannot_change_origin_or_filters_and_full_pages_need_another_request() {
    let endpoint = Url::parse("https://gitlab.example.test/instance/api/v4/projects/9/merge_requests?state=opened&per_page=100&page=1").unwrap();
    let mut headers = header::HeaderMap::new();
    headers.insert(header::LINK, header::HeaderValue::from_static("<https://other.example.test/instance/api/v4/projects/9/merge_requests?state=opened&per_page=100&page=2>; rel=\"next\""));
    assert!(next_page(&endpoint, &headers, 1, 100).is_err());
    headers.insert(
        header::LINK,
        header::HeaderValue::from_static("<?state=closed&per_page=100&page=2>; rel=\"next\""),
    );
    assert!(next_page(&endpoint, &headers, 1, 100).is_err());
    headers.insert(
        header::LINK,
        header::HeaderValue::from_static("<?state=opened&per_page=100&page=2>; rel=\"next\""),
    );
    assert_eq!(next_page(&endpoint, &headers, 1, 100).unwrap(), Some(2));
    headers.clear();
    assert_eq!(next_page(&endpoint, &headers, 1, 100).unwrap(), Some(2));
    assert_eq!(next_page(&endpoint, &headers, 1, 99).unwrap(), None);
    headers.insert("x-next-page", header::HeaderValue::from_static("3"));
    assert!(next_page(&endpoint, &headers, 1, 100).is_err());
}

#[test]
fn inaccessible_approvals_remain_unknown_while_server_merge_conditions_are_readable() {
    let mut steps = preflight(mr(1, 7, &[], &[7]));
    steps[3] = error_step("/approvals", 403);
    steps.insert(4, get("/versions", json!([version(5)])));
    let (config, _, server) = mock(steps);
    let detail = run(detail(&config, 9, 1)).unwrap();
    server.join().unwrap();
    assert!(!detail.approvals.readable);
    assert_eq!(detail.approvals.approved, None);
    assert!(detail.can_merge);
    assert_eq!(detail.diff_refs.unwrap().start_sha, START);
    assert_eq!(detail.diff_versions[0].refs.base_sha, BASE);
}

#[test]
fn nullable_ci_or_discussion_summaries_do_not_override_server_mergeable_status() {
    let mut request = mr(1, 7, &[], &[]);
    request["head_pipeline"] = Value::Null;
    request["blocking_discussions_resolved"] = Value::Null;
    let request: RawMergeRequest = decode(request).unwrap();
    let project: RawProject = decode(project()).unwrap();
    assert!(merge_blockers(&request, &project, &unknown_approvals()).is_empty());
}

#[test]
fn status_refresh_skips_version_history_and_invalidates_it_after_revision_changes() {
    for changed in [false, true] {
        let mut steps = preflight(mr(1, 7, &[], &[]));
        steps.insert(4, get("/versions", json!([version(5)])));
        let mut current = mr(1, 7, &[], &[]);
        if changed {
            current["sha"] = json!(BASE);
            current["diff_refs"]["head_sha"] = json!(BASE);
        }
        steps.extend(preflight(current));
        let (config, requests, server) = mock(steps);
        let (known, refreshed) = run(async {
            let known = detail(&config, 9, 1).await.unwrap();
            let refreshed = detail_status(&config, 9, 1, &known).await.unwrap();
            (known, refreshed)
        });
        server.join().unwrap();
        assert_eq!(known.diff_versions.len(), 1);
        assert_eq!(refreshed.diff_versions.is_empty(), changed);
        assert_eq!(requests.lock().unwrap().len(), 11);
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.lines().next().unwrap().contains("/versions"))
                .count(),
            1
        );
    }
}

#[test]
fn resolved_project_id_is_checked_before_loading_merge_requests() {
    let (config, requests, server) =
        mock(vec![get("/user", user(7)), get("/projects/99", project())]);
    assert_eq!(
        run(detail(&config, 99, 1)).unwrap_err().kind,
        "invalid_config"
    );
    server.join().unwrap();
    assert_eq!(requests.lock().unwrap().len(), 2);
}

#[test]
fn version_diff_keeps_pinned_refs_rename_metadata_and_server_truncation() {
    let mut version = version(5);
    version["state"] = json!("overflow");
    version["real_size"] = json!("12");
    version["diffs"] = json!([
        {"old_path": "old.ts", "new_path": "new.ts", "a_mode": "100644", "b_mode": "100644", "diff": "@@ -1 +1 @@\n-before\n+after\n", "new_file": false, "renamed_file": true, "deleted_file": false, "too_large": false, "collapsed": false},
        {"old_path": "large.bin", "new_path": "large.bin", "a_mode": "100644", "b_mode": "100644", "new_file": false, "renamed_file": false, "deleted_file": false, "too_large": true, "collapsed": false}]);
    let (config, requests, server) = mock(vec![
        get("/projects/9", project()),
        get("/merge_requests/1/versions/5", version),
    ]);
    let diff = run(diffs(&config, 9, 1, 5)).unwrap();
    server.join().unwrap();
    assert_eq!(diff.refs.base_sha, BASE);
    assert_eq!(diff.refs.start_sha, START);
    assert_eq!(diff.refs.head_sha, SHA);
    assert!(diff.truncated);
    assert!(diff.files[0].renamed_file);
    assert_eq!(diff.files[1].too_large, Some(true));
    assert!(requests.lock().unwrap().iter().all(|request| !request
        .lines()
        .next()
        .unwrap()
        .contains("/diffs")));
}

#[test]
fn discussions_are_paginated_and_keep_resolution_unknown_when_not_returned() {
    let discussion = |id: &str| json!({"id": id, "individual_note": false, "notes": [{"id": 1, "body": "Please check", "author": user(8), "created_at": "2026-10-06T00:00:00Z", "updated_at": "2026-10-06T00:00:00Z", "system": false, "resolvable": true}]});
    let mut first = get("/discussions", json!([discussion("d1")]));
    first.headers.push(("X-Next-Page", "2".into()));
    let (config, _, server) = mock(vec![
        get("/projects/9", project()),
        first,
        get("page=2", json!([discussion("d2")])),
    ]);
    let discussions = run(discussions(&config, 9, 1)).unwrap();
    server.join().unwrap();
    assert_eq!(discussions.len(), 2);
    assert_eq!(discussions[0].notes[0].resolved, None);
}

#[test]
fn merge_preflight_rejects_changed_sha_or_target_without_put() {
    for (sha, target) in [(BASE, "main"), (SHA, "release")] {
        let (config, requests, server) = mock(merge_preflight(mr(1, 7, &[], &[])));
        let error = run(merge(
            &config,
            9,
            1,
            sha,
            target,
            5,
            &reviewed_refs(),
            false,
            false,
            None,
            None,
        ))
        .unwrap_err();
        assert_eq!(error.kind, "conflict");
        server.join().unwrap();
        assert!(requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.starts_with("GET ")));
    }
}

#[test]
fn merge_preflight_rejects_changed_base_start_or_version_even_when_source_sha_is_unchanged() {
    for change in ["base", "start", "version"] {
        let mut refs = reviewed_refs();
        let id = if change == "version" { 4 } else { 5 };
        if change == "base" {
            refs.base_sha = START.into();
        }
        if change == "start" {
            refs.start_sha = BASE.into();
        }
        let (config, requests, server) = mock(merge_preflight(mr(1, 7, &[], &[])));
        let error = run(merge(
            &config, 9, 1, SHA, "main", id, &refs, false, false, None, None,
        ))
        .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.kind, "conflict");
        assert!(requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.starts_with("GET ")));
    }
}

#[test]
fn merge_sends_reviewed_sha_and_treats_opened_success_as_pending() {
    let mut steps = merge_preflight(mr(1, 7, &[], &[]));
    steps.push(step("PUT", "/merge_requests/1/merge", mr(1, 7, &[], &[])));
    let (config, requests, server) = mock(steps);
    let result = run(merge(
        &config,
        9,
        1,
        SHA,
        "main",
        5,
        &reviewed_refs(),
        false,
        true,
        None,
        None,
    ))
    .unwrap();
    server.join().unwrap();
    assert_eq!(result.state, "pending");
    let request = requests.lock().unwrap().last().unwrap().clone();
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["sha"], SHA);
    assert_eq!(body["should_remove_source_branch"], true);
    assert_eq!(body["squash"], false);
    assert!(body.get("auto_merge").is_none());
}

#[test]
fn detail_and_merge_route_to_selected_inbox_project_with_a_shared_local_iid() {
    let request = other_project_mr(1, 7, &[], &[7]);
    let preflight = || {
        vec![
            get("/user", user(7)),
            get("/projects/10", other_project()),
            get("/projects/10/merge_requests/1", request.clone()),
            get(
                "/projects/10/merge_requests/1/approvals",
                json!({"approvals_required": 0, "approvals_left": 0}),
            ),
            get(
                "/projects/10/merge_requests/1/versions",
                json!([version(5)]),
            ),
            get(
                "/projects/10/repository/branches/feature%2Fui",
                json!({"protected": false, "default": false, "can_push": true}),
            ),
        ]
    };
    let mut steps = preflight();
    steps.extend(preflight());
    let mut merged = request;
    merged["state"] = json!("merged");
    steps.push(step("PUT", "/projects/10/merge_requests/1/merge", merged));
    let (config, requests, server) = mock(steps);
    let (detail, result) = run(async {
        let detail = detail(&config, 10, 1).await.unwrap();
        let result = merge(
            &config,
            10,
            1,
            SHA,
            "main",
            5,
            &reviewed_refs(),
            false,
            true,
            None,
            None,
        )
        .await
        .unwrap();
        (detail, result)
    });
    server.join().unwrap();
    assert_eq!(detail.summary.project_id, 10);
    assert_eq!(detail.summary.iid, 1);
    assert_eq!(detail.summary.project_path_with_namespace, "other/mobile");
    assert_eq!(result.state, "merged");
    assert_eq!(result.summary.unwrap().project_id, 10);
    assert!(requests.lock().unwrap().iter().all(|request| !request
        .lines()
        .next()
        .unwrap()
        .contains("/projects/9")));
}

#[test]
fn lost_merge_response_queries_outcome_once_and_never_replays_put() {
    for (state, expected) in [("opened", "uncertain"), ("merged", "merged")] {
        let mut steps = merge_preflight(mr(1, 7, &[], &[]));
        let mut lost = step("PUT", "/merge_requests/1/merge", Value::Null);
        lost.drop_response = true;
        steps.push(lost);
        let mut current = mr(1, 7, &[], &[]);
        current["state"] = json!(state);
        steps.push(get("/merge_requests/1", current));
        let (config, requests, server) = mock(steps);
        let result = run(merge(
            &config,
            9,
            1,
            SHA,
            "main",
            5,
            &reviewed_refs(),
            false,
            false,
            None,
            None,
        ))
        .unwrap();
        server.join().unwrap();
        assert_eq!(result.state, expected);
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.starts_with("PUT "))
                .count(),
            1
        );
    }
}

#[test]
fn server_sha_race_409_is_redacted_and_not_retried() {
    let mut steps = merge_preflight(mr(1, 7, &[], &[]));
    let mut refused = error_step("/merge_requests/1/merge", 409);
    refused.method = "PUT";
    steps.push(refused);
    let (config, requests, server) = mock(steps);
    let error = run(merge(
        &config,
        9,
        1,
        SHA,
        "main",
        5,
        &reviewed_refs(),
        false,
        false,
        None,
        None,
    ))
    .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.kind, "conflict");
    assert!(!error.message.contains("fixture-secret"));
    assert_eq!(
        requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.starts_with("PUT "))
            .count(),
        1
    );
}

fn after_close(request: Value) -> Vec<Step> {
    let mut steps = merge_preflight(request);
    // Closed requests do not need source-branch deletion permission.
    steps.pop();
    steps
}

#[test]
fn author_close_uses_state_event_and_confirms_closed_without_deleting_the_branch() {
    let mut steps = preflight(mr(1, 7, &[], &[]));
    let mut closed = mr(1, 7, &[], &[]);
    closed["state"] = json!("closed");
    steps.push(step("PUT", "/merge_requests/1", closed.clone()));
    steps.extend(after_close(closed));
    let (config, requests, server) = mock(steps);
    let result = run(close(&config, 101, 9, 1)).unwrap();
    server.join().unwrap();
    assert_eq!(result.state, "closed");
    let detail = result.detail.unwrap();
    assert_eq!(detail.summary.state, "closed");
    assert!(!detail.can_close);
    assert!(!detail.can_approve);
    let requests = requests.lock().unwrap();
    let request = requests
        .iter()
        .find(|request| request.starts_with("PUT "))
        .unwrap();
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body, json!({"state_event": "close"}));
    assert!(requests
        .iter()
        .all(|request| !request.starts_with("DELETE ")));
}

#[test]
fn close_rejects_non_author_and_wrong_global_identity_before_writing() {
    for (mr_id, request) in [(101, mr(1, 8, &[], &[7])), (201, mr(1, 7, &[], &[]))] {
        let (config, requests, server) = mock(preflight(request));
        let error = run(close(&config, mr_id, 9, 1)).unwrap_err();
        server.join().unwrap();
        assert!(matches!(
            error.kind.as_str(),
            "blocked" | "invalid_response"
        ));
        assert!(requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.starts_with("GET ")));
    }
}

#[test]
fn detail_actions_follow_current_server_roles_and_personal_approval() {
    for (author, reviewers, approved, can_close, can_approve) in [
        (7, vec![7], false, true, false),
        (8, vec![7], false, false, true),
        (8, vec![], false, false, false),
        (8, vec![7], true, false, false),
    ] {
        let mut steps = merge_preflight(mr(1, author, &[], &reviewers));
        if approved {
            steps[3].value["approved_by"] = json!([{"user": user(7)}]);
        }
        let (config, _, server) = mock(steps);
        let detail = run(detail(&config, 9, 1)).unwrap();
        server.join().unwrap();
        assert_eq!(detail.can_close, can_close);
        assert_eq!(detail.can_approve, can_approve);
    }
}

#[test]
fn reviewer_approval_sends_reviewed_sha_and_reads_confirmed_personal_approval() {
    let mut steps = merge_preflight(mr(1, 8, &[], &[7]));
    steps.push(step(
        "POST",
        "/merge_requests/1/approve",
        json!({"approved_by": [{"user": user(7)}]}),
    ));
    let mut confirmed = merge_preflight(mr(1, 8, &[], &[7]));
    confirmed[3].value["approved_by"] = json!([{"user": user(7)}]);
    steps.extend(confirmed);
    let (config, requests, server) = mock(steps);
    let result = run(approve(
        &config,
        101,
        9,
        1,
        SHA,
        "main",
        5,
        &reviewed_refs(),
    ))
    .unwrap();
    server.join().unwrap();
    assert_eq!(result.state, "approved");
    assert!(!result.detail.unwrap().can_approve);
    let requests = requests.lock().unwrap();
    let request = requests
        .iter()
        .find(|request| request.starts_with("POST "))
        .unwrap();
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body, json!({"sha": SHA}));
}

#[test]
fn approval_rejects_author_unassigned_reviewer_and_changed_review_identity_before_post() {
    for change in [
        "author", "reviewer", "sha", "target", "version", "base", "start", "global",
    ] {
        let request = match change {
            "author" => mr(1, 7, &[], &[7]),
            "reviewer" => mr(1, 8, &[7], &[]),
            _ => mr(1, 8, &[], &[7]),
        };
        let sha = if change == "sha" { BASE } else { SHA };
        let target = if change == "target" {
            "release"
        } else {
            "main"
        };
        let version_id = if change == "version" { 4 } else { 5 };
        let mr_id = if change == "global" { 201 } else { 101 };
        let mut refs = reviewed_refs();
        if change == "base" {
            refs.base_sha = START.into();
        }
        if change == "start" {
            refs.start_sha = BASE.into();
        }
        let (config, requests, server) = mock(merge_preflight(request));
        let error = run(approve(
            &config, mr_id, 9, 1, sha, target, version_id, &refs,
        ))
        .unwrap_err();
        server.join().unwrap();
        assert!(matches!(
            error.kind.as_str(),
            "blocked" | "conflict" | "invalid_response"
        ));
        assert!(requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.starts_with("GET ")));
    }
}

#[test]
fn lost_approval_response_reconciles_once_and_never_replays_post() {
    for (approved, expected) in [(true, "approved"), (false, "uncertain")] {
        let mut steps = merge_preflight(mr(1, 8, &[], &[7]));
        let mut lost = step("POST", "/merge_requests/1/approve", Value::Null);
        lost.drop_response = true;
        steps.push(lost);
        let mut confirmed = merge_preflight(mr(1, 8, &[], &[7]));
        if approved {
            confirmed[3].value["approved_by"] = json!([{"user": user(7)}]);
        }
        steps.extend(confirmed);
        let (config, requests, server) = mock(steps);
        let result = run(approve(
            &config,
            101,
            9,
            1,
            SHA,
            "main",
            5,
            &reviewed_refs(),
        ))
        .unwrap();
        server.join().unwrap();
        assert_eq!(result.state, expected);
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.starts_with("POST "))
                .count(),
            1
        );
    }
}

#[test]
fn approval_sha_race_and_reauthentication_errors_are_redacted_without_retry() {
    for (status, kind) in [(409, "conflict"), (401, "forbidden"), (400, "blocked")] {
        let mut steps = merge_preflight(mr(1, 8, &[], &[7]));
        let mut refused = error_step("/merge_requests/1/approve", status);
        refused.method = "POST";
        steps.push(refused);
        let (config, requests, server) = mock(steps);
        let error = run(approve(
            &config,
            101,
            9,
            1,
            SHA,
            "main",
            5,
            &reviewed_refs(),
        ))
        .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.kind, kind);
        assert!(!error.message.contains("fixture-secret"));
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.starts_with("POST "))
                .count(),
            1
        );
    }
}

#[test]
fn approval_waits_for_server_sync_and_collected_patch_before_post() {
    for change in [
        "checking",
        "approvals_syncing",
        "uncollected",
        "patch_pending",
    ] {
        let mut request = mr(1, 8, &[], &[7]);
        if matches!(change, "checking" | "approvals_syncing") {
            request["detailed_merge_status"] = json!(change);
        }
        let mut steps = merge_preflight(request);
        if change == "uncollected" {
            steps[4].value[0]["state"] = json!("without_files");
        }
        if change == "patch_pending" {
            steps[4].value[0]["patch_id_sha"] = Value::Null;
        }
        let (config, requests, server) = mock(steps);
        let error = run(approve(
            &config,
            101,
            9,
            1,
            SHA,
            "main",
            5,
            &reviewed_refs(),
        ))
        .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.kind, "blocked");
        assert!(requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.starts_with("GET ")));
    }
}

#[test]
fn merge_sends_custom_messages_and_omits_squash_message_when_squash_is_disabled() {
    for squash in [false, true] {
        let mut steps = merge_preflight(mr(1, 7, &[], &[]));
        steps.push(step("PUT", "/merge_requests/1/merge", mr(1, 7, &[], &[])));
        let (config, requests, server) = mock(steps);
        run(merge(
            &config,
            9,
            1,
            SHA,
            "main",
            5,
            &reviewed_refs(),
            squash,
            false,
            Some("Custom merge\n\nReviewed change"),
            Some("Custom squash"),
        ))
        .unwrap();
        server.join().unwrap();
        let request = requests.lock().unwrap().last().unwrap().clone();
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body["merge_commit_message"],
            "Custom merge\n\nReviewed change"
        );
        if squash {
            assert_eq!(body["squash_commit_message"], "Custom squash");
        } else {
            assert!(body.get("squash_commit_message").is_none());
        }
    }
}

fn comment_position(old_line: Option<u64>, new_line: Option<u64>) -> DiffCommentPosition {
    DiffCommentPosition {
        old_path: "old/name.ts".into(),
        new_path: "new/name.ts".into(),
        old_line,
        new_line,
    }
}

fn comment_revision() -> Value {
    let mut revision = version(5);
    revision["diffs"] = json!([{
        "old_path": "old/name.ts", "new_path": "new/name.ts", "a_mode": "100644", "b_mode": "100644",
        "new_file": false, "renamed_file": true, "deleted_file": false,
        "diff": "@@ -14,3 +15,3 @@\n context\n-removed\n+added\n after\n",
    }]);
    revision
}

fn comment_preflight(request: Value) -> Vec<Step> {
    vec![
        get("/user", user(7)),
        get("/projects/9", project()),
        get("/merge_requests/1", request),
        get("/versions", json!([version(5)])),
        get("/versions/5", comment_revision()),
    ]
}

fn comment_response(position: &DiffCommentPosition) -> Value {
    json!({"id": "diff-thread", "individual_note": false, "notes": [{
        "id": 55, "body": "Review this line", "author": user(7), "created_at": "2026-10-08T00:00:00Z",
        "updated_at": "2026-10-08T00:00:00Z", "system": false, "resolvable": true, "resolved": false,
        "position": {"position_type": "text", "base_sha": BASE, "start_sha": START, "head_sha": SHA,
            "old_path": position.old_path, "new_path": position.new_path,
            "old_line": position.old_line, "new_line": position.new_line}
    }]})
}

#[test]
fn diff_comment_sends_exact_rename_paths_refs_and_line_sides() {
    for position in [
        comment_position(None, Some(16)),
        comment_position(Some(15), None),
        comment_position(Some(14), Some(15)),
    ] {
        let mut steps = comment_preflight(mr(1, 8, &[], &[7]));
        steps.push(step(
            "POST",
            "/projects/9/merge_requests/1/discussions",
            comment_response(&position),
        ));
        let (config, requests, server) = mock(steps);
        let result = run(create_diff_comment(
            &config,
            101,
            9,
            1,
            7,
            5,
            &reviewed_refs(),
            "main",
            &position,
            "  Review this line  ",
            || Ok(()),
        ))
        .unwrap();
        server.join().unwrap();
        assert_eq!(result.state, "created");
        let note_position = result.discussion.unwrap().notes[0]
            .position
            .clone()
            .unwrap();
        assert_eq!(note_position.old_line, position.old_line);
        assert_eq!(note_position.new_line, position.new_line);
        let requests = requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("POST "))
                .count(),
            1
        );
        let body: Value =
            serde_json::from_str(requests.last().unwrap().split_once("\r\n\r\n").unwrap().1)
                .unwrap();
        assert_eq!(body["body"], "Review this line");
        assert_eq!(body["position"]["old_path"], "old/name.ts");
        assert_eq!(body["position"]["new_path"], "new/name.ts");
        assert_eq!(body["position"]["base_sha"], BASE);
        assert_eq!(body["position"]["start_sha"], START);
        assert_eq!(body["position"]["head_sha"], SHA);
        for (key, line) in [
            ("old_line", position.old_line),
            ("new_line", position.new_line),
        ] {
            if let Some(line) = line {
                assert_eq!(body["position"][key], line);
            } else {
                assert!(body["position"].get(key).is_none());
            }
        }
    }
}

#[test]
fn diff_comment_rejects_changed_revision_identity_and_target_before_post() {
    for change in ["head", "base", "start", "target", "version", "global"] {
        let mut request = mr(1, 8, &[], &[7]);
        match change {
            "head" => request["sha"] = json!(BASE),
            "base" => request["diff_refs"]["base_sha"] = json!(START),
            "start" => request["diff_refs"]["start_sha"] = json!(BASE),
            "target" => request["target_branch"] = json!("release"),
            "global" => request["id"] = json!(999),
            _ => {}
        }
        let mut steps = comment_preflight(request);
        steps.truncate(if change == "version" { 4 } else { 3 });
        let (config, requests, server) = mock(steps);
        let result = run(create_diff_comment(
            &config,
            101,
            9,
            1,
            7,
            if change == "version" { 4 } else { 5 },
            &reviewed_refs(),
            "main",
            &comment_position(None, Some(16)),
            "Review this line",
            || Ok(()),
        ))
        .unwrap_err();
        server.join().unwrap();
        assert!(matches!(
            result.kind.as_str(),
            "conflict" | "invalid_response"
        ));
        assert!(requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.starts_with("GET ")));
    }
}

#[test]
fn diff_comment_rejects_line_not_in_patch_or_changed_context_without_post() {
    for position in [
        comment_position(Some(14), Some(14)),
        comment_position(Some(15), Some(16)),
        comment_position(None, Some(99)),
    ] {
        let (config, requests, server) = mock(comment_preflight(mr(1, 8, &[], &[7])));
        let error = run(create_diff_comment(
            &config,
            101,
            9,
            1,
            7,
            5,
            &reviewed_refs(),
            "main",
            &position,
            "Review this line",
            || Ok(()),
        ))
        .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.kind, "conflict");
        assert!(requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.starts_with("GET ")));
    }
    let (config, requests, server) = mock(comment_preflight(mr(1, 8, &[], &[7])));
    let error = run(create_diff_comment(
        &config,
        101,
        9,
        1,
        7,
        5,
        &reviewed_refs(),
        "main",
        &comment_position(None, Some(16)),
        "Review this line",
        || Err(ApiError::new("stale", "account changed")),
    ))
    .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.kind, "stale");
    assert!(requests
        .lock()
        .unwrap()
        .iter()
        .all(|request| request.starts_with("GET ")));
}

#[test]
fn diff_comment_rejects_changed_account_identity_without_reading_mr_or_posting() {
    let (config, requests, server) = mock(vec![get("/user", user(8))]);
    let error = run(create_diff_comment(
        &config,
        101,
        9,
        1,
        7,
        5,
        &reviewed_refs(),
        "main",
        &comment_position(None, Some(16)),
        "Review this line",
        || Ok(()),
    ))
    .unwrap_err();
    server.join().unwrap();
    assert_eq!(error.kind, "stale");
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[test]
fn diff_comment_uncertain_write_never_replays_post_or_fabricates_success() {
    for change in [
        "disconnect",
        "server",
        "invalid_json",
        "wrong_position",
        "wrong_author",
    ] {
        let position = comment_position(None, Some(16));
        let mut post = step("POST", "/discussions", comment_response(&position));
        match change {
            "disconnect" => post.drop_response = true,
            "server" => post.status = 500,
            "invalid_json" => post.raw_body = Some(b"{".to_vec()),
            "wrong_position" => post.value["notes"][0]["position"]["new_line"] = json!(17),
            "wrong_author" => post.value["notes"][0]["author"] = user(8),
            _ => {}
        }
        let mut steps = comment_preflight(mr(1, 8, &[], &[7]));
        steps.push(post);
        let (config, requests, server) = mock(steps);
        let result = run(create_diff_comment(
            &config,
            101,
            9,
            1,
            7,
            5,
            &reviewed_refs(),
            "main",
            &position,
            "Review this line",
            || Ok(()),
        ))
        .unwrap();
        server.join().unwrap();
        assert_eq!(result.state, "uncertain");
        assert!(result.discussion.is_none());
        assert_eq!(
            requests
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.starts_with("POST "))
                .count(),
            1
        );
    }
}

#[test]
fn diff_comment_known_server_rejections_remain_rejections() {
    for (status, kind) in [(400, "conflict"), (403, "forbidden"), (429, "rate_limit")] {
        let mut post = step("POST", "/discussions", json!({"message": "fixture-secret"}));
        post.status = status;
        let mut steps = comment_preflight(mr(1, 8, &[], &[7]));
        steps.push(post);
        let (config, _, server) = mock(steps);
        let error = run(create_diff_comment(
            &config,
            101,
            9,
            1,
            7,
            5,
            &reviewed_refs(),
            "main",
            &comment_position(None, Some(16)),
            "Review this line",
            || Ok(()),
        ))
        .unwrap_err();
        server.join().unwrap();
        assert_eq!(error.kind, kind);
        assert!(!error.message.contains("fixture-secret"));
    }
}
