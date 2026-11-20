use crate::workspace::WorkspaceMailbox;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex, OnceLock,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex, Notify},
};

type Reply = oneshot::Sender<Result<Value, String>>;

fn transport_tracing() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("MEMCODE_TRACE_TRANSPORT").as_deref() == Ok("1"))
}

fn transport_trace(stage: &str, sequence: u64, value: u64) {
    if !transport_tracing() {
        return;
    }
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    eprintln!("[memcode-transport] {{\"stage\":\"{stage}\",\"at\":{at},\"sequence\":{sequence},\"value\":{value}}}");
}

fn transport_rpc_trace(stage: &str, method: &str, id: &str, pending: usize) {
    if !transport_tracing() {
        return;
    }
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    eprintln!(
        "[memcode-transport-rpc] {}",
        json!({"stage":stage,"at":at,"method":method,"id":id,"pending":pending})
    );
}

struct Inner {
    writer: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<String, Reply>>,
    next: AtomicU64,
    ready: Notify,
    failure: Mutex<Option<String>>,
    closing: AtomicBool,
    shutdown_guard: Mutex<()>,
    shutdown_complete: AtomicBool,
    events: StdMutex<LatestEvents>,
    workspace: StdMutex<WorkspaceMailbox<tauri::ipc::Channel<Value>>>,
}

#[derive(Default)]
struct LatestEvents {
    pending: HashMap<String, Value>,
    draining: bool,
}

impl LatestEvents {
    fn push(&mut self, event: String, payload: Value) -> bool {
        self.pending.insert(event, payload);
        if self.draining {
            return false;
        }
        self.draining = true;
        true
    }

    fn take(&mut self) -> HashMap<String, Value> {
        std::mem::take(&mut self.pending)
    }

    fn continue_draining(&mut self) -> bool {
        self.draining = !self.pending.is_empty();
        self.draining
    }
}

#[derive(Clone)]
pub struct RuntimeBridge(Arc<Inner>);

impl RuntimeBridge {
    pub fn new() -> Self {
        Self(Arc::new(Inner {
            writer: Mutex::new(None),
            child: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            ready: Notify::new(),
            failure: Mutex::new(None),
            closing: AtomicBool::new(false),
            shutdown_guard: Mutex::new(()),
            shutdown_complete: AtomicBool::new(false),
            events: StdMutex::new(LatestEvents::default()),
            workspace: StdMutex::new(WorkspaceMailbox::default()),
        }))
    }

    pub fn is_closing(&self) -> bool {
        self.0.closing.load(Ordering::SeqCst)
    }

    pub fn begin_shutdown(&self) -> bool {
        !self.0.closing.swap(true, Ordering::SeqCst)
    }

    pub fn shutdown_complete(&self) -> bool {
        self.0.shutdown_complete.load(Ordering::SeqCst)
    }

    pub async fn launch(&self, app: AppHandle) -> Result<(), String> {
        let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("Missing application root")?
            .to_path_buf();
        let source_service = source_root.join("dist-runtime/service.cjs");
        let service = std::env::var_os("MEMCODE_SERVICE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if cfg!(debug_assertions) && source_service.exists() {
                    source_service.clone()
                } else {
                    app.path()
                        .resource_dir()
                        .unwrap_or_else(|_| source_root.clone())
                        .join("runtime/service.cjs")
                }
            });
        if !service.is_file() {
            return Err(if cfg!(debug_assertions) {
                format!(
                    "The local runtime is missing at {}. Run npm run build first.",
                    service.display()
                )
            } else {
                "A required MemCode program file is missing. Run the MemCode installer again to repair the application. Your projects and settings are kept separately.".into()
            });
        }
        let app_path = std::env::var_os("MEMCODE_APP_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if source_service == service {
                    source_root.clone()
                } else {
                    service
                        .parent()
                        .and_then(|p| p.parent())
                        .unwrap_or(&source_root)
                        .to_path_buf()
                }
            });
        let data_path = std::env::var_os("MEMCODE_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or(
                app.path()
                    .config_dir()
                    .map_err(|e| e.to_string())?
                    .join("MemCode"),
            );
        std::fs::create_dir_all(&data_path).map_err(|e| e.to_string())?;
        let mut command = Command::new(node_binary(app.path().resource_dir().ok().as_deref()));
        // Windows resource paths can use an extended-length prefix that Node's
        // entrypoint resolver rejects. Preserve UNC semantics while simplifying
        // paths that are safely expressible in the conventional form.
        command
            .arg(dunce::simplified(&service))
            .arg("--data-dir")
            .arg(dunce::simplified(&data_path))
            .arg("--app-path")
            .arg(dunce::simplified(&app_path))
            .current_dir(dunce::simplified(&app_path))
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if std::env::var("MEMCODE_TOOLCHAIN_OVERRIDE").as_deref() == Ok("1") {
            command
                .env_remove("RUSTUP_TOOLCHAIN")
                .env_remove("MEMCODE_TOOLCHAIN_OVERRIDE");
        }
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|error| {
            if cfg!(debug_assertions) {
                format!("Could not start the local Node runtime: {error}. Install Node.js 22.12+ or set MEMCODE_NODE_PATH.")
            } else {
                format!("MemCode could not start its bundled runtime: {error}. Run the MemCode installer again to repair the application. Your projects and settings are kept separately.")
            }
        })?;
        let stdout = child.stdout.take().ok_or("Missing runtime output")?;
        let stderr = child.stderr.take().ok_or("Missing runtime diagnostics")?;
        *self.0.writer.lock().await = child.stdin.take();
        *self.0.child.lock().await = Some(child);
        self.0.ready.notify_waiters();
        let bridge = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.len() > 1024 * 1024 {
                    transport_trace("rust-line-read", 0, line.len() as u64);
                }
                if line.len() > 32 * 1024 * 1024 {
                    bridge
                        .fail("Runtime message exceeded the 32MB transport limit.".into())
                        .await;
                    break;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(message) => bridge.receive(app.clone(), message).await,
                    Err(_) => {
                        eprintln!("MemCode ignored a non-protocol line from its local runtime.")
                    }
                }
            }
            let error = "The local runtime stopped. Reopen MemCode to reconnect; saved work has been preserved.".to_string();
            bridge.fail(error.clone()).await;
            if !bridge.is_closing() {
                let _ = app.emit_to(
                    tauri::EventTarget::Webview {
                        label: "main".into(),
                    },
                    "runtime:stopped",
                    json!({"message": error}),
                );
            }
        });
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[memcode-runtime] {line}");
            }
        });
        Ok(())
    }

    pub async fn request(&self, method: &str, input: Value) -> Result<Value, String> {
        let notified = self.0.ready.notified();
        tokio::pin!(notified);
        // Register before checking state so a fast startup cannot lose its wakeup.
        notified.as_mut().enable();
        if self.0.writer.lock().await.is_none() {
            if let Some(error) = self.0.failure.lock().await.clone() {
                return Err(error);
            }
            tokio::time::timeout(Duration::from_secs(30), notified)
                .await
                .map_err(|_| "The local runtime did not start within 30 seconds.")?;
        }
        if let Some(error) = self.0.failure.lock().await.clone() {
            return Err(error);
        }
        let id = self.0.next.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = oneshot::channel();
        let pending_count = {
            let mut pending = self.0.pending.lock().await;
            pending.insert(id.clone(), tx);
            pending.len()
        };
        transport_rpc_trace("rpc-start", method, &id, pending_count);
        if let Err(error) = self
            .send(json!({"kind":"request","id":id,"method":method,"input":input}))
            .await
        {
            self.0.pending.lock().await.remove(&id);
            transport_rpc_trace(
                "rpc-send-failed",
                method,
                &id,
                self.0.pending.lock().await.len(),
            );
            return Err(error);
        }
        let result = match tokio::time::timeout(Duration::from_secs(900), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The runtime response channel closed.".into()),
            Err(_) => {
                self.0.pending.lock().await.remove(&id);
                Err("The local runtime operation exceeded its 15 minute deadline.".into())
            }
        };
        transport_rpc_trace("rpc-end", method, &id, self.0.pending.lock().await.len());
        result
    }

    async fn send(&self, message: Value) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        encoded.push(b'\n');
        let mut guard = self.0.writer.lock().await;
        let writer = guard.as_mut().ok_or("The local runtime is unavailable.")?;
        writer
            .write_all(&encoded)
            .await
            .map_err(|e| e.to_string())?;
        writer.flush().await.map_err(|e| e.to_string())
    }

    async fn receive(&self, app: AppHandle, mut message: Value) {
        match message["kind"].as_str() {
            Some("response") => {
                if let Some(id) = message["id"].as_str() {
                    if let Some(reply) = self.0.pending.lock().await.remove(id) {
                        let result = message["error"]
                            .as_str()
                            .map(|s| Err(s.to_string()))
                            .unwrap_or_else(|| Ok(message["result"].clone()));
                        let _ = reply.send(result);
                    }
                }
            }
            Some("event") => {
                if message["event"].as_str() == Some("workspace:state") {
                    transport_trace(
                        "rust-workspace-receive",
                        message["transportSequence"].as_u64().unwrap_or(0),
                        0,
                    );
                    let payload = message["payload"].take();
                    if self.0.workspace.lock().unwrap().push(payload) {
                        self.drain_workspace();
                    }
                    return;
                }
                if message["event"].as_str() == Some("review:event") {
                    let target = app.clone();
                    let payload = message["payload"].clone();
                    let _ = app.run_on_main_thread(move || {
                        let _ = target.emit_to(
                            tauri::EventTarget::Webview {
                                label: "main".into(),
                            },
                            "review:event",
                            payload,
                        );
                    });
                    return;
                }
                if let Some(event @ ("beta:status" | "preview:event" | "workspace:save-status")) =
                    message["event"].as_str()
                {
                    self.queue_event(app, event.to_owned(), message["payload"].clone())
                        .await;
                }
            }
            Some("host_request") => {
                let bridge = self.clone();
                tauri::async_runtime::spawn(async move {
                    let id = message["id"].clone();
                    let result = crate::native::host_call(
                        app,
                        message["method"].as_str().unwrap_or(""),
                        message["input"].clone(),
                    )
                    .await;
                    let response = match result {
                        Ok(value) => json!({"kind":"host_response","id":id,"result":value}),
                        Err(error) => json!({"kind":"host_response","id":id,"error":error}),
                    };
                    let _ = bridge.send(response).await;
                });
            }
            _ => {}
        }
    }

    pub fn connect_workspace(&self, channel: tauri::ipc::Channel<Value>, token: String) {
        transport_trace("rust-workspace-connect", 0, 0);
        if self.0.workspace.lock().unwrap().connect(channel, token) {
            self.drain_workspace();
        }
    }

    pub fn acknowledge_workspace(&self, sequence: u64, token: &str) -> bool {
        let acknowledgement = self
            .0
            .workspace
            .lock()
            .unwrap()
            .acknowledge(sequence, token);
        transport_trace(
            "rust-workspace-ack",
            sequence,
            acknowledgement.accepted as u64,
        );
        if acknowledgement.resume_drain {
            self.drain_workspace();
        }
        acknowledgement.accepted
    }

    fn drain_workspace(&self) {
        let bridge = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let delivery = bridge.0.workspace.lock().unwrap().next();
                let Some(delivery) = delivery else {
                    break;
                };
                let sequence = delivery.sequence;
                let token = delivery.token;
                // Channels fetch large bodies over IPC instead of embedding the
                // full workspace inside an evaluated JavaScript event script.
                transport_trace("rust-channel-send-start", sequence, 0);
                let sent = delivery.channel.send(json!({
                    "sequence": sequence,
                    "token": token,
                    "base": delivery.base,
                    "change": delivery.change,
                }));
                transport_trace("rust-channel-send-return", sequence, sent.is_ok() as u64);
                let received = if sent.is_ok() {
                    matches!(
                        tokio::time::timeout(Duration::from_secs(5), delivery.acknowledged).await,
                        Ok(Ok(()))
                    )
                } else {
                    false
                };
                if !received && bridge.0.workspace.lock().unwrap().expire(sequence, &token) {
                    eprintln!("MemCode paused workspace delivery until the renderer acknowledges or reconnects.");
                    break;
                }
            }
        });
    }

    async fn queue_event(&self, app: AppHandle, event: String, payload: Value) {
        if !self.0.events.lock().unwrap().push(event, payload) {
            return;
        }
        let bridge = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(33)).await;
                let target = app.clone();
                let queued = bridge.clone();
                let (delivered, acknowledged) = oneshot::channel();
                // Keep at most one native callback outstanding. Take the newest
                // payload only when that callback executes, so a busy UI cannot
                // accumulate closures retaining old multi-megabyte snapshots.
                let dispatch = app.run_on_main_thread(move || {
                    let events = queued.0.events.lock().unwrap().take();
                    for (event, payload) in events {
                        let _ = target.emit_to(
                            tauri::EventTarget::Webview {
                                label: "main".into(),
                            },
                            &event,
                            payload,
                        );
                    }
                    let _ = delivered.send(());
                });
                if dispatch.is_err() || acknowledged.await.is_err() {
                    bridge.0.events.lock().unwrap().draining = false;
                    break;
                }
                if !bridge.0.events.lock().unwrap().continue_draining() {
                    break;
                }
            }
        });
    }

    pub async fn fail(&self, error: String) {
        *self.0.failure.lock().await = Some(error.clone());
        self.0.ready.notify_waiters();
        for (_, pending) in self.0.pending.lock().await.drain() {
            let _ = pending.send(Err(error.clone()));
        }
    }

    pub async fn shutdown(&self) {
        self.shutdown_with_timeout(runtime_shutdown_timeout(|name| std::env::var(name).ok()))
            .await;
    }

    async fn shutdown_with_timeout(&self, timeout: Duration) {
        self.begin_shutdown();
        // Quit, window close and updater callbacks must all await the same
        // complete drain. Merely seeing `closing` is not permission to exit.
        let _shutdown = self.0.shutdown_guard.lock().await;
        if self.shutdown_complete() {
            return;
        }
        if tokio::time::timeout(timeout, self.request("runtime:shutdown", Value::Null))
            .await
            .is_err()
        {
            eprintln!("MemCode reached its bounded runtime shutdown deadline; forced cleanup may require local graph recovery on the next launch.");
        }
        self.0.writer.lock().await.take();
        if let Some(mut child) = self.0.child.lock().await.take() {
            if tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .is_err()
            {
                #[cfg(windows)]
                if let Some(pid) = child.id() {
                    let taskkill = PathBuf::from(
                        std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
                    )
                    .join("System32/taskkill.exe");
                    let _ = tokio::time::timeout(
                        Duration::from_secs(10),
                        Command::new(taskkill)
                            .args(["/PID", &pid.to_string(), "/T", "/F"])
                            .creation_flags(0x08000000)
                            .output(),
                    )
                    .await;
                }
                #[cfg(unix)]
                if let Some(pid) = child.id() {
                    stop_unix_runtime_tree(pid).await;
                }
                let _ = child.kill().await;
            }
        }
        self.0.shutdown_complete.store(true, Ordering::SeqCst);
    }
}

/// Native graph owners close in parallel. Match their configured durable-flush
/// and sidecar budgets (including the native 15s margin), then allow another
/// minute for worker cancellation, read-only reviewers and final profile writes.
/// No part of this wait runs on the window/event-loop thread.
fn runtime_shutdown_timeout(environment: impl Fn(&str) -> Option<String>) -> Duration {
    let seconds = |name, fallback, ceiling| {
        environment(name)
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .map(|value| value.min(ceiling))
            .unwrap_or(fallback)
    };
    Duration::from_secs(
        seconds("MEMTRACE_MCP_SHUTDOWN_FLUSH_SECS", 120, 3600).max(
            seconds("MEMTRACE_SHUTDOWN_FLUSH_TIMEOUT_SECS", 10, 300)
                + seconds("MEMTRACE_MEMDB_SIDECAR_STOP_SECS", 30, 3600),
        ) + 15
            + 60,
    )
}

#[cfg(any(unix, test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct RuntimeProcess {
    pid: u32,
    parent: u32,
    started: String,
}

#[cfg(any(unix, test))]
fn runtime_processes(output: &str) -> Vec<RuntimeProcess> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok()?;
            let parent = fields.next()?.parse::<u32>().ok()?;
            let started = fields.collect::<Vec<_>>().join(" ");
            (pid > 1 && !started.is_empty()).then_some(RuntimeProcess {
                pid,
                parent,
                started,
            })
        })
        .collect()
}

#[cfg(any(unix, test))]
fn runtime_descendants(processes: &[RuntimeProcess], root: u32) -> Vec<RuntimeProcess> {
    let mut owners = vec![root];
    let mut descendants = Vec::new();
    let mut cursor = 0;
    while cursor < owners.len() {
        let parent = owners[cursor];
        for process in processes.iter().filter(|process| process.parent == parent) {
            if !owners.contains(&process.pid) {
                owners.push(process.pid);
                descendants.push(process.clone());
            }
        }
        cursor += 1;
    }
    descendants.reverse();
    descendants
}

/// Last-resort cleanup is limited to descendants of this exact Node child.
/// Native owned graphs may have separate process groups; a group-only kill
/// would miss them on macOS. Recheck PID/parent/start time before each signal
/// rather than stopping an unrelated service by name or by workspace path.
#[cfg(unix)]
async fn stop_unix_runtime_tree(root: u32) {
    let cleanup = async {
        let Ok(output) = Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,lstart="])
            .output()
            .await
        else {
            return;
        };
        if !output.status.success() {
            return;
        }
        let processes = runtime_processes(&String::from_utf8_lossy(&output.stdout));
        for process in runtime_descendants(&processes, root) {
            let Ok(current) = Command::new("/bin/ps")
                .args(["-p", &process.pid.to_string(), "-o", "pid=,ppid=,lstart="])
                .output()
                .await
            else {
                continue;
            };
            if runtime_processes(&String::from_utf8_lossy(&current.stdout)) == [process.clone()] {
                let _ = Command::new("/bin/kill")
                    .args(["-KILL", &process.pid.to_string()])
                    .output()
                    .await;
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(10), cleanup).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_shutdown_budget_contains_native_durable_flush_and_runtime_overhead() {
        assert_eq!(runtime_shutdown_timeout(|_| None), Duration::from_secs(195));
        assert_eq!(
            runtime_shutdown_timeout(|name| match name {
                "MEMTRACE_MCP_SHUTDOWN_FLUSH_SECS" => Some("200".into()),
                "MEMTRACE_SHUTDOWN_FLUSH_TIMEOUT_SECS" => Some("300".into()),
                "MEMTRACE_MEMDB_SIDECAR_STOP_SECS" => Some("400".into()),
                _ => None,
            }),
            Duration::from_secs(775),
        );
        assert_eq!(
            runtime_shutdown_timeout(|_| Some("999999".into())),
            Duration::from_secs(3975),
        );
        for invalid in ["0", "-1", "invalid", "2.5", ""] {
            assert_eq!(
                runtime_shutdown_timeout(|_| Some(invalid.into())),
                Duration::from_secs(195),
            );
        }
    }

    #[test]
    fn forced_cleanup_selects_only_exact_runtime_descendants_in_child_first_order() {
        let processes = runtime_processes(
            "100 1 Tue Nov 17 20:00:00 2026\n101 100 Tue Nov 17 20:01:00 2026\n102 101 Tue Nov 17 20:02:00 2026\n200 1 Tue Nov 17 20:00:00 2026\n201 200 Tue Nov 17 20:00:00 2026\nmalformed\n1 0 Tue Nov 17 20:00:00 2026\n103 103 Tue Nov 17 20:00:00 2026",
        );
        let selected = runtime_descendants(&processes, 100);
        assert_eq!(
            selected
                .iter()
                .map(|process| process.pid)
                .collect::<Vec<_>>(),
            [102, 101]
        );
        let mut reused = selected[0].clone();
        reused.started = "Tue Nov 17 20:03:00 2026".into();
        assert_ne!(
            selected[0], reused,
            "Reused PIDs cannot retain a captured process identity"
        );
        let mut reparented = selected[0].clone();
        reparented.parent = 200;
        assert_ne!(
            selected[0], reparented,
            "A borrowed/reparented process is no longer the captured child"
        );
    }

    async fn shutdown_fixture(script: &str) -> (RuntimeBridge, tokio::task::JoinHandle<usize>) {
        let mut command = Command::new(node_binary(None));
        command
            .arg("-e")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .expect("Start the isolated shutdown protocol child");
        let stdout = child.stdout.take().unwrap();
        let bridge = RuntimeBridge::new();
        *bridge.0.writer.lock().await = child.stdin.take();
        *bridge.0.child.lock().await = Some(child);
        let replies = bridge.clone();
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut count = 0;
            while let Ok(Some(line)) = lines.next_line().await {
                let message: Value = serde_json::from_str(&line).unwrap();
                let id = message["id"].as_str().unwrap();
                if let Some(reply) = replies.0.pending.lock().await.remove(id) {
                    count += 1;
                    let _ = reply.send(Ok(Value::Null));
                }
            }
            count
        });
        (bridge, reader)
    }

    #[test]
    fn real_runtime_reply_after_twenty_seconds_is_drained_once_without_blocking_async_work() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let (bridge, reader) = shutdown_fixture(
                r#"require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);setTimeout(()=>{process.stdout.write(JSON.stringify({kind:'response',id:request.id,result:null})+'\n');setTimeout(()=>process.exit(0),10);},21200);});"#,
            ).await;
            let started = std::time::Instant::now();
            let first = bridge.clone();
            let first = tokio::spawn(async move { first.shutdown().await });
            let second = bridge.clone();
            let second = tokio::spawn(async move { second.shutdown().await });
            tokio::time::sleep(Duration::from_millis(20100)).await;
            assert!(!bridge.shutdown_complete(), "The former 20s deadline must not cut off a durable graph flush");
            assert!(!first.is_finished());
            assert!(!second.is_finished(), "A concurrent updater/quit caller must await completion rather than only the closing flag");
            tokio::time::timeout(Duration::from_secs(10), async { first.await.unwrap(); second.await.unwrap(); }).await.unwrap();
            assert!(started.elapsed() >= Duration::from_secs(21));
            assert!(bridge.shutdown_complete());
            assert!(bridge.0.child.lock().await.is_none());
            assert_eq!(reader.await.unwrap(), 1, "Only one shutdown request is sent");
        });
    }

    #[test]
    fn an_unresponsive_owned_runtime_has_a_bounded_forced_cleanup() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let (bridge, reader) =
                    shutdown_fixture("process.stdin.resume();setInterval(()=>{},1000);").await;
                tokio::time::timeout(
                    Duration::from_secs(15),
                    bridge.shutdown_with_timeout(Duration::from_millis(50)),
                )
                .await
                .unwrap();
                assert!(bridge.shutdown_complete());
                assert!(bridge.0.child.lock().await.is_none());
                assert_eq!(reader.await.unwrap(), 0);
            });
    }

    #[test]
    fn blocked_native_dispatch_keeps_only_latest_snapshots() {
        let mut events = LatestEvents::default();
        assert!(events.push("workspace:state".into(), json!({"sequence": 0})));
        for sequence in 1..10_000 {
            assert!(!events.push("workspace:state".into(), json!({"sequence": sequence})));
            assert!(!events.push("preview:event".into(), json!({"sequence": sequence})));
        }
        let delivered = events.take();
        assert_eq!(delivered.len(), 2);
        assert_eq!(delivered["workspace:state"]["sequence"], 9_999);
        assert_eq!(delivered["preview:event"]["sequence"], 9_999);
        assert!(!events.continue_draining());
    }

    #[test]
    fn update_during_delivery_is_not_lost_or_dispatched_twice() {
        let mut events = LatestEvents::default();
        assert!(events.push("workspace:state".into(), json!("running")));
        assert_eq!(events.take()["workspace:state"], "running");
        assert!(!events.push("workspace:state".into(), json!("finished")));
        assert!(events.continue_draining());
        assert_eq!(events.take()["workspace:state"], "finished");
        assert!(!events.continue_draining());
        assert!(events.push("workspace:state".into(), json!("new run")));
    }
}

fn node_binary(resources: Option<&std::path::Path>) -> PathBuf {
    if let Some(configured) = std::env::var_os("MEMCODE_NODE_PATH") {
        return configured.into();
    }
    if let Some(resources) = resources {
        let bundled =
            resources
                .join("desktop-runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        if bundled.is_file() || !cfg!(debug_assertions) {
            return bundled;
        }
    }
    #[cfg(windows)]
    {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let node = PathBuf::from(home).join("scoop/apps/nodejs/current/node.exe");
            if node.is_file() {
                return node;
            }
        }
        if let Some(programs) = std::env::var_os("ProgramFiles") {
            let node = PathBuf::from(programs).join("nodejs/node.exe");
            if node.is_file() {
                return node;
            }
        }
    }
    "node".into()
}
