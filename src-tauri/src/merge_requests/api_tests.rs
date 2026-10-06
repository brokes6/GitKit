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
    json!({"id": 100 + iid, "iid": iid, "project_id": 9, "title": format!("MR {iid}"), "state": "opened",
        "description": "Only loaded for details", "source_branch": "feature/ui", "target_branch": "main",
        "author": user(author), "assignees": assignees.iter().map(|id| user(*id)).collect::<Vec<_>>(),
        "reviewers": reviewers.iter().map(|id| user(*id)).collect::<Vec<_>>(), "draft": false,
        "updated_at": "2026-10-06T00:00:00Z", "sha": SHA, "detailed_merge_status": "mergeable",
        "head_pipeline": {"status": "success"}, "user": {"can_merge": true}, "blocking_discussions_resolved": true,
        "has_conflicts": false, "diff_refs": {"base_sha": BASE, "start_sha": START, "head_sha": SHA},
        "squash": false, "should_remove_source_branch": false, "force_remove_source_branch": false, "source_project_id": 9})
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
}

fn step(method: &'static str, target: &'static str, value: Value) -> Step {
    Step {
        method,
        target,
        status: 200,
        value,
        headers: Vec::new(),
        drop_response: false,
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
            assert!(request
                .to_ascii_lowercase()
                .contains("private-token: fixture-secret"));
            recorded.lock().unwrap().push(request);
            if step.drop_response {
                continue;
            }
            let body = serde_json::to_string(&step.value).unwrap();
            let extra = step
                .headers
                .into_iter()
                .map(|(name, value)| format!("{name}: {value}\r\n"))
                .collect::<String>();
            write!(stream, "HTTP/1.1 {} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}", step.status, body.len(), extra, body).unwrap();
        }
    });
    (
        Config {
            url: format!("http://{address}/gitlab"),
            token: "fixture-secret".into(),
            remote: format!("http://{address}/gitlab/team/sub/app.git"),
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
        get("/gitlab/api/v4/projects/team%2Fsub%2Fapp", project()),
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

#[test]
fn strict_remote_mapping_preserves_subgroups_subpaths_ports_and_ssh_paths() {
    for remote in [
        "https://gitlab.example.test:8443/instance/team/sub/app.git",
        "ssh://git@gitlab.example.test:2222/team/sub/app.git",
        "git@gitlab.example.test:team/sub/app.git",
    ] {
        let config = Config {
            url: "https://gitlab.example.test:8443/instance/".into(),
            token: "fixture-secret".into(),
            remote: remote.into(),
        };
        let context = Context::new(&config).unwrap();
        assert_eq!(context.project_path, "team/sub/app");
        assert_eq!(
            context
                .endpoint(&["projects", &context.project_path], &[])
                .unwrap()
                .as_str(),
            "https://gitlab.example.test:8443/instance/api/v4/projects/team%2Fsub%2Fapp"
        );
        let url = "https://gitlab.example.test:8443/instance/team/sub/app/-/merge_requests/1";
        assert_eq!(validated_web_url(&config, 9, 1, url).unwrap(), url);
        assert!(validated_web_url(&config, 9, 2, url).is_err());
        assert!(validated_web_url(
            &config,
            9,
            1,
            "https://other.example.test/team/sub/app/-/merge_requests/1"
        )
        .is_err());
    }
    for remote in [
        "https://gitlab.example.test/team/sub/app.git",
        "https://gitlab.example.test:8443/elsewhere/team/sub/app.git",
        "https://other.example.test:8443/instance/team/sub/app.git",
        "https://user:fixture-secret@gitlab.example.test:8443/instance/team/sub/app.git",
        "file:///fixture-secret",
        "git@gitlab.example.test:team%2Fsub/app.git",
    ] {
        let config = Config {
            url: "https://gitlab.example.test:8443/instance".into(),
            token: "fixture-secret".into(),
            remote: remote.into(),
        };
        let error = validate_config(&config).unwrap_err();
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
        get("/projects/team%2Fsub%2Fapp", project()),
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
    assert_eq!(requests.lock().unwrap().len(), 6);
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("fixture-secret"));
}

#[test]
fn cached_identity_list_only_requests_three_roles() {
    let (config, requests, server) = mock(vec![
        get("author_id=7", json!([])),
        get("assignee_id=7", json!([])),
        get("reviewer_id=7", json!([])),
    ]);
    let identity = decode(user(7)).unwrap();
    let project = Project {
        id: 9,
        name: "app".into(),
        path_with_namespace: "team/sub/app".into(),
        web_url: String::new(),
    };
    assert!(run(list_resolved(&config, &identity, &project))
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
        get("/projects/team%2Fsub%2Fapp", project()),
        get("author_id=7", json!([raw])),
    ]);
    assert_eq!(run(list(&config)).unwrap_err().kind, "unsupported");
    server.join().unwrap();
    let mut first = get("author_id=7", json!([mr(1, 7, &[], &[])]));
    first.headers.push(("X-Next-Page", "2".into()));
    let (config, _, server) = mock(vec![
        get("/user", user(7)),
        get("/projects/team%2Fsub%2Fapp", project()),
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
    assert_eq!(status_error(429, &headers, false).retry_after, Some(137));
    assert_eq!(status_error(401, &headers, false).kind, "unauthorized");
    assert_eq!(status_error(401, &headers, true).kind, "forbidden");
    assert_eq!(status_error(403, &headers, false).kind, "forbidden");
    assert_eq!(status_error(404, &headers, false).kind, "not_found");
    assert_eq!(status_error(409, &headers, true).kind, "conflict");
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
fn current_project_id_is_checked_before_loading_arbitrary_merge_requests() {
    let (config, requests, server) = mock(vec![
        get("/user", user(7)),
        get("/projects/team%2Fsub%2Fapp", project()),
    ]);
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
        get("/projects/team%2Fsub%2Fapp", project()),
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
        get("/projects/team%2Fsub%2Fapp", project()),
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
        let error = run(merge(&config, 9, 1, SHA, "main", id, &refs, false, false)).unwrap_err();
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
