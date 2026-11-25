#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod beta_store;
mod bridge;
mod browser;
#[cfg(windows)]
mod browser_capture;
#[cfg(windows)]
mod browser_port;
mod install_location;
mod native;
#[cfg(windows)]
mod startup;
mod state_patch;
mod terminal;
mod updates;
mod update_cache;
mod workspace;

use bridge::RuntimeBridge;
use serde_json::Value;
use tauri::{AppHandle, Manager, RunEvent, Webview, WindowEvent};

fn request_shutdown(app: AppHandle, exit_code: i32) {
    let runtime = app.state::<RuntimeBridge>().inner().clone();
    // Keep the native loop available for browser/terminal cleanup, while the
    // main window closes immediately instead of looking frozen during a flush.
    if let Some(window) = app.get_window("main") {
        let _ = window.hide();
    }
    if runtime.begin_shutdown() {
        tauri::async_runtime::spawn(async move {
            runtime.shutdown().await;
            app.exit(exit_code);
        });
    }
}

#[tauri::command]
async fn rpc(
    webview: Webview,
    runtime: tauri::State<'_, RuntimeBridge>,
    method: String,
    input: Option<Value>,
) -> Result<Value, String> {
    // Main navigation is pinned to main_origin below and capabilities exclude
    // guests. Querying CoreWebView2's live URL on every RPC adds a synchronous
    // UI-thread hop, which can block replies during native browser operations.
    if webview.label() != "main" {
        return Err("Only the MemCode application view can call the local runtime.".into());
    }
    if method.len() > 100 || method == "runtime:shutdown" {
        return Err("This runtime operation is not exposed to the renderer.".into());
    }
    runtime.request(&method, input.unwrap_or(Value::Null)).await
}

#[tauri::command]
fn workspace_connect(
    webview: Webview,
    runtime: tauri::State<'_, RuntimeBridge>,
    channel: tauri::ipc::Channel<Value>,
    token: String,
) -> Result<(), String> {
    if webview.label() != "main" || token.is_empty() || token.len() > 128 {
        return Err("Only the MemCode application may connect workspace updates.".into());
    }
    runtime.connect_workspace(channel, token);
    Ok(())
}

#[tauri::command]
fn workspace_ack(
    webview: Webview,
    runtime: tauri::State<'_, RuntimeBridge>,
    sequence: u64,
    token: String,
) -> Result<bool, String> {
    if webview.label() != "main" || token.is_empty() || token.len() > 128 {
        return Err("Only the MemCode application may acknowledge workspace updates.".into());
    }
    Ok(runtime.acknowledge_workspace(sequence, &token))
}

fn main() {
    let browser = browser::BrowserState::take();
    let runtime = RuntimeBridge::new();
    let result = tauri::Builder::default()
        .manage(runtime)
        .manage(native::PreviewState::default())
        .manage(browser)
        .manage(terminal::TerminalState::default())
        .manage(updates::UpdateState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            rpc,
            workspace_connect,
            workspace_ack,
            updates::app_update_info,
            updates::app_update_context,
            updates::app_update_history,
            updates::app_update_check,
            updates::app_update_download,
            updates::app_update_install
        ])
        .setup(|app| {
            let result: Result<(), Box<dyn std::error::Error>> = (|| {
                let handle = app.handle().clone();
                let config = app
                    .config()
                    .app
                    .windows
                    .first()
                    .ok_or("Missing main window configuration")?
                    .clone();
                let verification = std::env::var_os("MEMCODE_NATIVE_TEST_PROFILE").is_some();
                // Fail before WebView2 can open its own blocking initialization
                // dialog when a stale file or an inaccessible path obstructs data.
                let webview_data =
                    native::profile_dir(app.handle()).map_err(std::io::Error::other)?;
                std::fs::create_dir_all(&webview_data).map_err(|error| {
                    format!(
                        "MemCode could not prepare its webview data folder at {}. A writable directory is required. Windows reported: {error}",
                        webview_data.display()
                    )
                })?;
                let mut window = tauri::WebviewWindowBuilder::from_config(app, &config)?
                    .prevent_overflow()
                    .focused(!verification)
                    .skip_taskbar(verification);
                if std::env::var("MEMCODE_NATIVE_TEST_PROFILE").as_deref() == Ok("1")
                    && std::env::var("MEMCODE_UPDATER_ACL_TEST").as_deref() == Ok("1")
                    && std::env::var_os("MEMCODE_DATA_DIR")
                        .map(std::path::PathBuf::from)
                        .is_some_and(|path| path.is_absolute())
                {
                    window = window.initialization_script(include_str!("updater_acl_probe.js"));
                }
                if verification {
                    window = window.title("MemCode — verification");
                }
                if let Some(arguments) = app.state::<browser::BrowserState>().app_arguments() {
                    window = window.additional_browser_args(&arguments);
                }
                window
                    .data_directory(webview_data)
                    .on_navigation(native::main_origin)
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .disable_drag_drop_handler()
                    .build()?;
                let runtime = app.state::<RuntimeBridge>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = runtime.launch(handle.clone()).await {
                        #[cfg(windows)]
                        startup::record("local-runtime", &error);
                        runtime.fail(error).await;
                    }
                    if !runtime.is_closing() {
                        if let Some(window) = handle.get_window("main") {
                            let _ = window.show();
                        }
                    }
                });
                Ok(())
            })();
            // Tauri turns a returned setup error into a panic during its Ready
            // event. Handle it here so release panic=abort cannot hide the error.
            #[cfg(windows)]
            if let Err(error) = &result {
                startup::fatal(&error.to_string());
                std::process::exit(1);
            }
            result
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                request_shutdown(window.app_handle().clone(), 0);
            }
        })
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                let runtime = app.state::<RuntimeBridge>();
                if !runtime.shutdown_complete() {
                    // macOS Cmd+Q / application Quit does not require a window
                    // close event. It must wait for the same durable drain.
                    api.prevent_exit();
                    request_shutdown(app.clone(), code.unwrap_or(0));
                }
            }
        }),
        Err(error) => {
            #[cfg(windows)]
            startup::fatal(&error.to_string());
            #[cfg(not(windows))]
            eprintln!("MemCode could not start its native desktop shell: {error}");
            std::process::exit(1);
        }
    }
}
