use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

pub(super) const CANCELLED: &str = "__cancelled__";

#[derive(Default)]
struct RunningOperation {
    cancelled: AtomicBool,
    tree_stopped: AtomicBool,
    child: Mutex<Option<Child>>,
}

/// One entry covers the entire fetch/pull, including time between subprocesses.
#[derive(Default, Clone)]
pub struct CancelState(Arc<Mutex<HashMap<String, Arc<RunningOperation>>>>);

pub(super) struct GitOperation {
    state: CancelState,
    id: String,
    running: Arc<RunningOperation>,
}

impl CancelState {
    pub(crate) fn cancel_background(&self, id: &str) {
        // Sleep can arrive just before the worker registers its operation.
        // The scheduler keeps retrying until that worker has settled.
        let _ = self.cancel(id);
    }

    pub(crate) fn has_foreground_operation(&self) -> bool {
        self.0.lock().map(|entries| entries.keys().any(|id| !id.starts_with("daily-check-"))).unwrap_or(true)
    }

    pub(super) fn begin(&self, id: String) -> Result<GitOperation, String> {
        let mut entries = self.0.lock().map_err(|e| e.to_string())?;
        if entries.contains_key(&id) {
            return Err("Git 操作编号重复".into());
        }
        let running = Arc::new(RunningOperation::default());
        entries.insert(id.clone(), running.clone());
        Ok(GitOperation {
            state: self.clone(),
            id,
            running,
        })
    }

    pub(super) fn cancel(&self, id: &str) -> Result<(), String> {
        let running = self.0.lock().map_err(|e| e.to_string())?.get(id).cloned();
        if let Some(running) = running {
            // Serialize cancellation with spawn and reap, but never hold this
            // lock while waiting for output or for a process to exit.
            let mut slot = running.child.lock().map_err(|e| e.to_string())?;
            if running.cancelled.load(Ordering::SeqCst) {
                return Ok(());
            }
            if let Some(child) = slot.as_mut() {
                let stopped =
                    kill_tree(child, false).map_err(|e| format!("无法终止 Git 进程：{e}"))?;
                running.tree_stopped.store(stopped, Ordering::SeqCst);
            }
            running.cancelled.store(true, Ordering::SeqCst);
            Ok(())
        } else {
            // Do not acknowledge an early request which ran before begin().
            // The frontend ignores this if its original operation has settled.
            Err("操作尚未就绪或已经结束，请重试取消".into())
        }
    }
}

#[cfg(unix)]
fn kill_tree(child: &mut Child, force: bool) -> std::io::Result<bool> {
    // Every managed child starts a new process group. Signal only that group,
    // including SSH/HTTP helpers which may still hold its output pipes open.
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    let result = unsafe { libc::kill(-(child.id() as libc::pid_t), signal) };
    if result == 0 {
        return Ok(force);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(true);
    }
    // macOS reports EPERM for a group containing only the unreaped parent.
    // Reap that exited process, then confirm the group is gone. A real signal
    // permission failure must still be reported, never treated as cancellation.
    if error.raw_os_error() == Some(libc::EPERM) && child.try_wait()?.is_some() {
        let result = unsafe { libc::kill(-(child.id() as libc::pid_t), 0) };
        if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return Ok(true);
        }
    }
    Err(error)
}

#[cfg(windows)]
fn kill_tree(child: &mut Child, _force: bool) -> std::io::Result<bool> {
    let output = super::command("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .output()?;
    if output.status.success() {
        Ok(true)
    } else {
        Err(std::io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}

enum PipeEvent {
    Data(bool, Vec<u8>),
    Closed(std::io::Result<()>),
}

fn read_pipe(mut pipe: impl Read + Send + 'static, stdout: bool, tx: mpsc::Sender<PipeEvent>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(PipeEvent::Closed(Ok(())));
                    break;
                }
                Ok(n) => {
                    if tx.send(PipeEvent::Data(stdout, buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    let _ = tx.send(PipeEvent::Closed(Err(e)));
                    break;
                }
            }
        }
    });
}

impl GitOperation {
    pub(super) fn check_cancelled(&self) -> Result<(), String> {
        if self.running.cancelled.load(Ordering::SeqCst) {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }

    pub(super) fn run(
        &self,
        mut cmd: Command,
        mut on_stderr: impl FnMut(&[u8]),
    ) -> Result<(ExitStatus, String, String), String> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (stdout, stderr) = {
            let mut slot = self.running.child.lock().map_err(|e| e.to_string())?;
            self.check_cancelled()?;
            let mut child = cmd.spawn().map_err(|e| format!("无法执行 git：{e}"))?;
            let pipes = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
            *slot = Some(child);
            pipes
        };
        let (tx, rx) = mpsc::channel();
        read_pipe(stdout, true, tx.clone());
        read_pipe(stderr, false, tx);
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let mut closed = 0;
        let mut read_error = None;
        #[cfg(unix)]
        let mut cancel_started = None;
        let mut forced = false;
        loop {
            // Never block cancellation on read() or wait(). EOF is not proof
            // that Git has exited, and a dead Git may have live helper pipes.
            let cancelling = self.running.cancelled.load(Ordering::SeqCst);
            if cancelling {
                forced |= self.running.tree_stopped.load(Ordering::SeqCst);
            }
            #[cfg(unix)]
            if cancelling && !forced {
                // Give Git's signal handler a chance to remove its lock files,
                // then kill helpers which ignored SIGTERM. Keep the parent
                // unreaped until then so its process-group ID cannot be reused.
                let started = cancel_started.get_or_insert_with(Instant::now);
                if started.elapsed() >= Duration::from_millis(250) {
                    let mut slot = self.running.child.lock().map_err(|e| e.to_string())?;
                    kill_tree(slot.as_mut().unwrap(), true)
                        .map_err(|e| format!("无法终止 Git 子进程：{e}"))?;
                    self.running.tree_stopped.store(true, Ordering::SeqCst);
                    forced = true;
                }
            }
            if (closed == 2 && !cancelling) || forced {
                let mut slot = self.running.child.lock().map_err(|e| e.to_string())?;
                if self.running.cancelled.load(Ordering::SeqCst) && !forced {
                    continue;
                }
                if let Some(status) = slot
                    .as_mut()
                    .unwrap()
                    .try_wait()
                    .map_err(|e| e.to_string())?
                {
                    *slot = None;
                    if let Some(error) = read_error {
                        return Err(error);
                    }
                    self.check_cancelled()?;
                    return Ok((
                        status,
                        String::from_utf8_lossy(&output).into_owned(),
                        String::from_utf8_lossy(&errors).into_owned(),
                    ));
                }
            }
            match rx.recv_timeout(Duration::from_millis(25)) {
                Ok(PipeEvent::Data(true, bytes)) => output.extend(bytes),
                Ok(PipeEvent::Data(false, bytes)) => {
                    if self.check_cancelled().is_ok() {
                        on_stderr(&bytes);
                    }
                    errors.extend(bytes);
                    // Progress can be arbitrarily long; retain only its tail.
                    if errors.len() > 65_536 {
                        errors.drain(..errors.len() - 65_536);
                    }
                }
                Ok(PipeEvent::Closed(result)) => {
                    closed += 1;
                    if let Err(error) = result {
                        read_error = Some(format!("无法读取 Git 输出：{error}"));
                        self.state.cancel(&self.id)?;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    std::thread::sleep(Duration::from_millis(25))
                }
            }
        }
    }
}

impl Drop for GitOperation {
    fn drop(&mut self) {
        // Normally run() has already reaped the child. This also cleans up a
        // worker which failed or panicked before reaching its normal exit.
        if let Ok(mut slot) = self.running.child.lock() {
            if let Some(mut child) = slot.take() {
                if self.running.tree_stopped.load(Ordering::SeqCst)
                    || kill_tree(&mut child, true).is_ok()
                {
                    let _ = child.wait();
                }
            }
        }
        if let Ok(mut entries) = self.state.0.lock() {
            entries.remove(&self.id);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;

    fn shell(script: &str) -> Command {
        let mut cmd = super::super::command("sh");
        cmd.args(["-c", script]);
        cmd
    }

    #[test]
    fn cancellation_before_spawn_and_between_commands_prevents_work() {
        let state = CancelState::default();
        let operation = state.begin("early".into()).unwrap();
        state.cancel("early").unwrap();
        // A cancelled operation must not even attempt this nonexistent executable.
        assert_eq!(
            operation
                .run(Command::new("gitkit-nonexistent-test-command"), |_| {})
                .unwrap_err(),
            CANCELLED
        );
        drop(operation);
        assert!(state.0.lock().unwrap().is_empty());

        let operation = state.begin("between".into()).unwrap();
        let (status, stdout, _) = operation.run(shell("printf first"), |_| {}).unwrap();
        assert!(status.success());
        assert_eq!(stdout, "first");
        state.cancel("between").unwrap();
        assert_eq!(
            operation.run(shell("printf second"), |_| {}).unwrap_err(),
            CANCELLED
        );
    }

    #[test]
    fn normal_output_errors_and_spawn_failure_clean_up() {
        let state = CancelState::default();
        let operation = state.begin("output".into()).unwrap();
        let mut progress = Vec::new();
        let (status, stdout, stderr) = operation
            .run(
                shell("printf result; printf 'receiving 10%%\\rreceiving 100%%\\n' >&2; exit 7"),
                |bytes| progress.extend_from_slice(bytes),
            )
            .unwrap();
        assert_eq!(status.code(), Some(7));
        assert_eq!(stdout, "result");
        assert_eq!(stderr.as_bytes(), progress);
        assert!(stderr.contains("receiving 100%"));
        assert!(operation
            .run(Command::new("gitkit-nonexistent-test-command"), |_| {})
            .is_err());
        drop(operation);
        assert!(state.0.lock().unwrap().is_empty());
    }

    fn assert_cancels_tree(script: &'static str, wait_for_pipe_close: bool) {
        let state = CancelState::default();
        let operation = state.begin("tree".into()).unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = Vec::new();
            let result = operation.run(shell(script), |bytes| {
                line.extend_from_slice(bytes);
                if line.contains(&b'\n') {
                    let _ = ready_tx.send(String::from_utf8_lossy(&line).to_string());
                    line.clear();
                }
            });
            drop(operation);
            let _ = done_tx.send(result);
        });
        let line = ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let pgid: i32 = line.split_whitespace().next().unwrap().parse().unwrap();
        // Let the parent reach exit()/close(), while its helper is still alive.
        if wait_for_pipe_close {
            std::thread::sleep(Duration::from_millis(100));
        }
        let started = Instant::now();
        let cancel = state.cancel("tree");
        let result = done_rx.recv_timeout(Duration::from_secs(3));
        // Emergency cleanup makes a failing regression test leave no sleeper.
        if cancel.is_err() || result.is_err() {
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
        cancel.unwrap();
        assert_eq!(result.unwrap().unwrap_err(), CANCELLED);
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(state.0.lock().unwrap().is_empty());
        // A cancelled parent alone isn't enough: the entire helper group must exit.
        let deadline = Instant::now() + Duration::from_secs(2);
        while unsafe { libc::kill(-pgid, 0) } == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let alive = unsafe { libc::kill(-pgid, 0) } == 0;
        if alive {
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
        assert!(!alive, "Git helper process group survived cancellation");
    }

    #[test]
    fn cancels_silent_parent_and_helper_holding_output_open() {
        assert_cancels_tree("sleep 60 & printf '%s\\n' $$ >&2; wait", false);
    }

    #[test]
    fn force_kills_helpers_which_ignore_termination() {
        assert_cancels_tree(
            "trap '' TERM; sleep 60 & printf '%s\\n' $$ >&2; wait",
            false,
        );
    }

    #[test]
    fn cancels_helper_even_when_parent_already_exited() {
        assert_cancels_tree("sleep 60 & printf '%s\\n' $$ >&2; exit 0", true);
    }

    #[test]
    fn cancels_process_even_after_both_output_pipes_close() {
        assert_cancels_tree("printf '%s\\n' $$ >&2; exec 1>&- 2>&-; sleep 60", true);
    }
}
