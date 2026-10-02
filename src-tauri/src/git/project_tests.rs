use super::*;

struct ProjectFolder(std::path::PathBuf);

impl ProjectFolder {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("gitkit-project-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &str { self.0.to_str().unwrap() }
}

impl Drop for ProjectFolder {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

#[test]
fn opening_plain_project_is_read_only_and_initialization_preserves_files() {
    let folder = ProjectFolder::new();
    std::fs::write(folder.0.join("code.txt"), "existing content\n").unwrap();
    let info = open_repo_inner(folder.path()).unwrap();
    assert!(!info.initialized);
    assert!(!info.has_head);
    assert!(info.current_branch.is_empty());
    assert!(!folder.0.join(".git").exists());

    let info = init_repo_inner(folder.path()).unwrap();
    assert!(info.initialized);
    assert!(!info.has_head);
    assert!(!info.current_branch.is_empty());
    assert_eq!(std::fs::read_to_string(folder.0.join("code.txt")).unwrap(), "existing content\n");
    assert!(run_git(folder.path(), &["diff", "--cached", "--name-only"]).unwrap().is_empty());
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    assert!(runtime.block_on(git_log(info.path.clone(), None)).unwrap().is_empty());
    assert!(runtime.block_on(git_branches(info.path.clone())).unwrap().is_empty());
    assert!(runtime.block_on(git_stash_list(info.path.clone())).unwrap().is_empty());
    let status = runtime.block_on(git_status(info.path)).unwrap();
    assert_eq!(status.len(), 1);
    assert_eq!(status[0].path, "code.txt");
    assert!(!status[0].staged);
}

#[test]
fn initialization_is_idempotent_and_nested_projects_reuse_the_existing_root() {
    let folder = ProjectFolder::new();
    run_git(folder.path(), &["init", "--initial-branch=topic"]).unwrap();
    run_git(folder.path(), &["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "base"]).unwrap();
    let before = run_git(folder.path(), &["rev-parse", "HEAD"]).unwrap();
    std::fs::create_dir(folder.0.join("nested")).unwrap();
    let nested = folder.0.join("nested");
    let info = open_repo_inner(nested.to_str().unwrap()).unwrap();
    assert_eq!(info.path, folder.0.canonicalize().unwrap().to_string_lossy());
    assert!(info.initialized && info.has_head);
    assert_eq!(info.current_branch, "topic");
    let initialized = init_repo_inner(nested.to_str().unwrap()).unwrap();
    assert_eq!(initialized.path, info.path);
    assert_eq!(initialized.current_branch, "topic");
    assert_eq!(run_git(folder.path(), &["rev-parse", "HEAD"]).unwrap(), before);
    assert!(!nested.join(".git").exists());
}

#[test]
fn invalid_paths_bare_repositories_and_broken_metadata_are_not_plain_projects() {
    let folder = ProjectFolder::new();
    assert!(open_repo_inner(folder.0.join("missing").to_str().unwrap()).is_err());
    std::fs::write(folder.0.join("file"), "data").unwrap();
    assert!(open_repo_inner(folder.0.join("file").to_str().unwrap()).is_err());
    std::fs::create_dir(folder.0.join(".git")).unwrap();
    assert!(open_repo_inner(folder.path()).is_err());
    assert!(init_repo_inner(folder.path()).is_err());
    assert!(!folder.0.join(".git/HEAD").exists());
    std::fs::remove_dir(folder.0.join(".git")).unwrap();
    init_repo_inner(folder.path()).unwrap();
    std::fs::write(folder.0.join(".git/config"), "[invalid\n").unwrap();
    assert!(open_repo_inner(folder.path()).is_err());
    let bare = ProjectFolder::new();
    run_git(bare.path(), &["init", "--bare"]).unwrap();
    assert!(open_repo_inner(bare.path()).is_err());
}

fn gitlab_response(status: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let worker = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut request = Vec::new();
        let mut chunk = [0; 4096];
        loop {
            let length = socket.read(&mut chunk).unwrap();
            assert!(length > 0);
            request.extend_from_slice(&chunk[..length]);
            let text = String::from_utf8_lossy(&request);
            if let Some(end) = text.find("\r\n\r\n") {
                let size = text[..end].lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap();
                if request.len() >= end + 4 + size { break; }
            }
        }
        socket.write_all(response.as_bytes()).unwrap();
        String::from_utf8(request).unwrap()
    });
    (address, worker)
}

#[test]
fn gitlab_creation_uses_the_empty_project_contract_and_maps_both_visibilities() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    for private in [true, false] {
        let (url, worker) = gitlab_response("201 Created", r#"{"http_url_to_repo":"https://gitlab.example.invalid/me/project.git","web_url":"https://gitlab.example.invalid/me/project","path_with_namespace":"me/project"}"#);
        let repo = runtime.block_on(gitlab_create_repo(url, "fixture-token".into(), " project ".into(), private, " description ".into())).unwrap();
        assert_eq!(repo.full_name, "me/project");
        assert!(repo.clone_url.ends_with(".git"));
        assert!(repo.html_url.ends_with("/project"));
        let request = worker.join().unwrap();
        assert!(request.starts_with("POST /api/v4/projects HTTP/1.1"));
        assert!(request.to_ascii_lowercase().contains("private-token: fixture-token\r\n"));
        let body: serde_json::Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body, serde_json::json!({"name":"project","path":"project","description":"description",
            "visibility": if private {"private"} else {"public"}, "initialize_with_readme":false}));
    }
}

#[test]
fn gitlab_creation_surfaces_authentication_and_missing_response_fields() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    for (status, body, expected) in [
        ("401 Unauthorized", r#"{"message":"401 Unauthorized"}"#, "GitLab：401 Unauthorized"),
        ("400 Bad Request", r#"{"message":{"path":["has already been taken"]}}"#, "has already been taken"),
        ("201 Created", r#"{"id":1}"#, "仓库已创建"),
    ] {
        let (url, worker) = gitlab_response(status, body);
        let error = runtime.block_on(gitlab_create_repo(url, "fixture-token".into(), "project".into(), true, "".into())).err().unwrap();
        assert!(error.contains(expected), "{error}");
        worker.join().unwrap();
    }
}
