use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{
    webview::{NewWindowResponse, PermissionResponse, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};

#[derive(Clone, Copy, Default, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Default)]
pub struct PreviewState(
    pub Mutex<Option<(String, Bounds)>>,
    pub std::sync::atomic::AtomicBool,
);

pub fn profile_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    Ok(std::env::var_os("MEMCODE_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or(
            app.path()
                .config_dir()
                .map_err(|e| e.to_string())?
                .join("MemCode"),
        )
        .join("webview"))
}

pub fn main_origin(url: &Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost"))
            | ("http", Some("tauri.localhost"))
            | ("https", Some("tauri.localhost"))
    ) || (cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(5197))
}

fn loopback(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
        && url.username().is_empty()
        && url.password().is_none()
}

pub async fn host_call(app: AppHandle, method: &str, input: Value) -> Result<Value, String> {
    if method.starts_with("beta_store_") || method.starts_with("beta_access_") {
        return crate::beta_store::call(app, method, input).await;
    }
    if method.starts_with("terminal_") {
        return crate::terminal::call(app, method, input).await;
    }
    if method.starts_with("browser_") {
        return crate::browser::call(app, method, input).await;
    }
    match method {
        "select_folder" => {
            let selected = tauri::async_runtime::spawn_blocking(|| {
                rfd::FileDialog::new()
                    .set_title("Choose a MemCode project folder")
                    .pick_folder()
            })
            .await
            .map_err(|e| e.to_string())?;
            Ok(selected
                .map(|p| json!(p.to_string_lossy()))
                .unwrap_or(Value::Null))
        }
        "window_action" => {
            // A preview makes this a multi-webview window. WebviewWindow lookup
            // only succeeds for windows containing a single matching webview.
            let window = app.get_window("main").ok_or("Main window is unavailable")?;
            match input["action"].as_str() {
                Some("minimize") => window.minimize().map_err(|e| e.to_string())?,
                Some("maximize") => {
                    if window.is_maximized().map_err(|e| e.to_string())? {
                        window.unmaximize().map_err(|e| e.to_string())?
                    } else {
                        window.maximize().map_err(|e| e.to_string())?
                    }
                }
                Some("close") => {
                    let _ = window.close();
                }
                _ => return Err("Unknown window action".into()),
            }
            Ok(Value::Null)
        }
        "open_memtrace_claim" => {
            let url = memtrace_claim_url(input["url"].as_str().ok_or("Missing sign-in URL")?)?;
            tauri::async_runtime::spawn_blocking(move || open_claim(&url))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "open_memcode_identity" => {
            let url = memcode_identity_url(input["url"].as_str().ok_or("Missing team sign-in URL")?)?;
            tauri::async_runtime::spawn_blocking(move || open_claim(&url))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "open_memcode_beta" => {
            let url = memcode_beta_url(input["url"].as_str().ok_or("Missing beta sign-in URL")?)?;
            tauri::async_runtime::spawn_blocking(move || open_claim(&url))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "open_slack_install" => {
            let url = slack_install_url(input["url"].as_str().ok_or("Missing Slack install URL")?)?;
            tauri::async_runtime::spawn_blocking(move || open_claim(&url))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "open_inbox_link" => {
            let url = inbox_link_url(input["url"].as_str().ok_or("Missing link")?)?;
            tauri::async_runtime::spawn_blocking(move || open_claim(&url))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "open_saved_file" => {
            let profile = profile_dir(&app)?;
            let data = profile.parent().ok_or("Missing profile folder")?;
            let path = saved_file(input["path"].as_str().ok_or("Missing file")?, data)?;
            tauri::async_runtime::spawn_blocking(move || open_folder(&path))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "open_github_pull_request" => {
            let url = github_pull_request_url(input["url"].as_str().ok_or("Missing pull request URL")?)?;
            tauri::async_runtime::spawn_blocking(move || open_claim(&url))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "open_github_device" => {
            tauri::async_runtime::spawn_blocking(|| open_claim("https://github.com/login/device"))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "installation_status" => {
            let status = tauri::async_runtime::spawn_blocking(crate::install_location::status)
                .await.map_err(|error| error.to_string())?;
            serde_json::to_value(status).map_err(|error| error.to_string())
        }
        "installation_show_source" => {
            tauri::async_runtime::spawn_blocking(crate::install_location::show_install_location)
                .await.map_err(|error| error.to_string())??;
            Ok(Value::Null)
        }
        "installation_show_applications" => {
            tauri::async_runtime::spawn_blocking(crate::install_location::show_applications)
                .await.map_err(|error| error.to_string())??;
            Ok(Value::Null)
        }
        "open_worker_setup" => {
            let url = match input["harness"].as_str() {
                Some("codex") => "https://developers.openai.com/codex/cli/",
                Some("claude") => "https://code.claude.com/docs/en/setup",
                Some("cursor") => "https://cursor.com/docs/cli/installation",
                Some("copilot") => "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
                Some("dsh") => "https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md",
                _ => return Err("Unknown worker provider".into()),
            };
            tauri::async_runtime::spawn_blocking(move || open_claim(url))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        #[cfg(target_os = "macos")]
        "open_worker_terminal" => {
            tauri::async_runtime::spawn_blocking(|| {
                let status = std::process::Command::new("/usr/bin/open")
                    .args(["-a", "Terminal"])
                    .status()
                    .map_err(|error| error.to_string())?;
                if status.success() {
                    Ok(Value::Null)
                } else {
                    Err("Terminal could not be opened.".to_owned())
                }
            })
            .await
            .map_err(|error| error.to_string())?
        }
        "open_memcode_telemetry_privacy" => {
            tauri::async_runtime::spawn_blocking(|| open_claim("https://www.memtrace.io/docs/privacy/telemetry#memcode"))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "open_path" => {
            let path = input["path"]
                .as_str()
                .ok_or("Missing folder path")?
                .to_owned();
            if !std::path::Path::new(&path).is_dir() {
                return Err("The project folder no longer exists".into());
            }
            tauri::async_runtime::spawn_blocking(move || open_folder(&path))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "preview_show" => {
            show_preview(&app, input).await?;
            Ok(Value::Null)
        }
        "preview_hide" => {
            if let Some(view) = app.get_webview("preview") {
                view.hide().map_err(|e| e.to_string())?;
            }
            app.state::<PreviewState>()
                .1
                .store(false, std::sync::atomic::Ordering::SeqCst);
            Ok(Value::Null)
        }
        "preview_action" => {
            let view = app
                .get_webview("preview")
                .ok_or("Open a local preview first")?;
            let script = match input["action"].as_str() {
                Some("back") => "history.back()",
                Some("forward") => "history.forward()",
                Some("reload") => "location.reload()",
                _ => return Err("Unknown preview action".into()),
            };
            view.eval(script).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "preview_capture" => {
            if !app
                .state::<PreviewState>()
                .1
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err("Open a visible preview before capturing it".into());
            }
            let bounds = input
                .get("bounds")
                .cloned()
                .filter(|v| !v.is_null())
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .or_else(|| {
                    app.state::<PreviewState>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|state| state.as_ref().map(|(_, bounds)| *bounds))
                })
                .ok_or("Open a visible preview first")?;
            let app_copy = app.clone();
            let png =
                tauri::async_runtime::spawn_blocking(move || capture_visible(&app_copy, bounds))
                    .await
                    .map_err(|e| e.to_string())??;
            Ok(json!({"pngBase64":base64::engine::general_purpose::STANDARD.encode(png)}))
        }
        _ => Err(format!("Unknown native host operation: {method}")),
    }
}

async fn show_preview(app: &AppHandle, input: Value) -> Result<(), String> {
    let url: Url = input["url"]
        .as_str()
        .ok_or("Missing preview URL")?
        .parse()
        .map_err(|_| "Invalid preview URL")?;
    if !loopback(&url) {
        return Err(
            "Preview navigation is limited to local development and artifact content".into(),
        );
    }
    let bounds: Bounds =
        serde_json::from_value(input["bounds"].clone()).map_err(|e| e.to_string())?;
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|n| n.is_finite())
        || bounds.x < 0.0
        || bounds.y < 0.0
        || bounds.width < 1.0
        || bounds.height < 1.0
        || bounds.width > 10000.0
        || bounds.height > 10000.0
    {
        return Err("Invalid preview bounds".into());
    }
    let previous = app
        .state::<PreviewState>()
        .0
        .lock()
        .map_err(|_| "Preview state is unavailable")?
        .clone();
    if let Some(view) = app.get_webview("preview") {
        view.set_position(LogicalPosition::new(bounds.x, bounds.y))
            .map_err(|e| e.to_string())?;
        view.set_size(LogicalSize::new(bounds.width, bounds.height))
            .map_err(|e| e.to_string())?;
        if previous.as_ref().map(|(previous, _)| previous.as_str()) != Some(url.as_str()) {
            view.navigate(url.clone()).map_err(|e| e.to_string())?;
        }
        view.show().map_err(|e| e.to_string())?;
    } else {
        let window = app.get_window("main").ok_or("Main window is unavailable")?;
        let titles = app.clone();
        let pages = app.clone();
        let builder=WebviewBuilder::new("preview",WebviewUrl::External(url.clone()))
            .data_directory(profile_dir(app)?)
            .disable_drag_drop_handler()
            .on_navigation(loopback)
            .on_new_window(|_,_|NewWindowResponse::Deny)
            .on_permission_request(|_,_|PermissionResponse::Deny)
            .on_download(|_,_|false)
            .on_document_title_changed(move |view,title|{let _=titles.emit_to(tauri::EventTarget::Webview {label:"main".into()},"preview:event",json!({"url":view.url().ok().map(|url|url.to_string()).unwrap_or_default(),"title":title}));})
            .on_page_load(move |view,payload|{let _=pages.emit_to(tauri::EventTarget::Webview {label:"main".into()},"preview:event",json!({"url":payload.url().to_string(),"title":"Local preview","event":format!("{:?}",payload.event()),"view":view.label()}));});
        window
            .add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
            )
            .map_err(|e| e.to_string())?;
    }
    *app.state::<PreviewState>()
        .0
        .lock()
        .map_err(|_| "Preview state is unavailable")? = Some((url.to_string(), bounds));
    app.state::<PreviewState>()
        .1
        .store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

fn memtrace_claim_url(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "Invalid Memtrace sign-in URL")?;
    let pairs: Vec<_> = url.query_pairs().collect();
    let valid_code = pairs.len() == 1
        && pairs[0].0 == "code"
        && (4..=256).contains(&pairs[0].1.len())
        && pairs[0]
            .1
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("memtrace.io" | "www.memtrace.io"))
        || url.path() != "/claim"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || url.fragment().is_some()
        || !valid_code
    {
        return Err("Only the official Memtrace sign-in claim can open here".into());
    }
    Ok(url.to_string())
}

/// Only a github.com pull request or the prefilled compare page that creates one.
fn github_pull_request_url(value: &str) -> Result<String, String> {
    let invalid = || "Only a GitHub pull request page can open here".to_string();
    let url = Url::parse(value).map_err(|_| invalid())?;
    if value.len() > 8192 || url.scheme() != "https" || url.host_str() != Some("github.com")
        || !url.username().is_empty() || url.password().is_some()
        || url.port_or_known_default() != Some(443) || url.fragment().is_some()
    { return Err(invalid()); }
    let segments: Vec<&str> = url.path_segments().map(|parts| parts.collect()).unwrap_or_default();
    let name = |part: &str| !part.is_empty() && part != "." && part != ".." && part.len() <= 100
        && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    let page = segments.len() >= 4 && name(segments[0]) && name(segments[1]) && match segments[2] {
        "pull" => segments.len() == 4 && segments[3].chars().all(|c| c.is_ascii_digit()) && !segments[3].is_empty(),
        "compare" => segments[3..].join("/").contains("..."),
        _ => false,
    };
    if !page { return Err(invalid()); }
    Ok(url.to_string())
}

fn memcode_identity_url(value: &str) -> Result<String, String> {
    let invalid = || "Only the official Memtrace team authorization can open here".to_string();
    let url = Url::parse(value).map_err(|_| invalid())?;
    if value.len() > 4096 || url.scheme() != "https" || url.host_str() != Some("memtrace.io")
        || url.path() != "/api/memcode/authorize" || !url.username().is_empty() || url.password().is_some()
        || url.port_or_known_default() != Some(443) || url.fragment().is_some()
    { return Err(invalid()); }
    let pairs: Vec<_> = url.query_pairs().collect();
    let names = ["audience", "nonce", "expires_at", "redirect_uri", "state", "code_challenge", "code_challenge_method"];
    if pairs.len() != names.len() || names.iter().any(|name| pairs.iter().filter(|(key, _)| key == name).count() != 1) {
        return Err(invalid());
    }
    let get = |name: &str| pairs.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_ref()).unwrap_or("");
    let opaque = |value: &str| (32..=200).contains(&value.len()) && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !opaque(get("nonce")) || !opaque(get("state")) || !opaque(get("code_challenge"))
        || get("code_challenge").len() != 43 || get("code_challenge_method") != "S256"
    { return Err(invalid()); }
    let expires = get("expires_at").as_bytes();
    if expires.len() != 24 || expires.iter().enumerate().any(|(i, c)| match i {
        4 | 7 => *c != b'-', 10 => *c != b'T', 13 | 16 => *c != b':', 19 => *c != b'.', 23 => *c != b'Z', _ => !c.is_ascii_digit(),
    }) { return Err(invalid()); }
    let audience = Url::parse(get("audience")).map_err(|_| invalid())?;
    let local = matches!(audience.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
    if !audience.username().is_empty() || audience.password().is_some() || audience.query().is_some() || audience.fragment().is_some()
        || audience.path() != "/" || audience.origin().ascii_serialization() != get("audience")
        || !(audience.scheme() == "https" || (audience.scheme() == "http" && local))
    { return Err(invalid()); }
    let callback = Url::parse(get("redirect_uri")).map_err(|_| invalid())?;
    if callback.scheme() != "http" || callback.host_str() != Some("127.0.0.1") || callback.port().unwrap_or(0) < 1024
        || !callback.username().is_empty() || callback.password().is_some() || callback.query().is_some() || callback.fragment().is_some()
        || callback.path() != format!("/memcode-identity/{}", get("state"))
    { return Err(invalid()); }
    Ok(url.to_string())
}

/// Slack's page for adding MemCode to a workspace, as MemSync builds it.
fn slack_install_url(value: &str) -> Result<String, String> {
    let invalid = || "Only Slack's page for adding MemCode can open here".to_string();
    let url = Url::parse(value).map_err(|_| invalid())?;
    if value.len() > 4096 || url.scheme() != "https" || url.host_str() != Some("slack.com")
        || url.path() != "/oauth/v2/authorize" || !url.username().is_empty() || url.password().is_some()
        || url.port_or_known_default() != Some(443) || url.fragment().is_some() { return Err(invalid()); }
    let pairs: Vec<_> = url.query_pairs().collect();
    let names = ["client_id", "scope", "redirect_uri", "state"];
    if pairs.len() != names.len() || names.iter().any(|name| pairs.iter().filter(|(key, _)| key == name).count() != 1) { return Err(invalid()); }
    let get = |name: &str| pairs.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_ref()).unwrap_or("");
    let callback = Url::parse(get("redirect_uri")).map_err(|_| invalid())?;
    if callback.scheme() != "https" || callback.path() != "/slack/oauth" || !callback.username().is_empty()
        || callback.query().is_some() || callback.fragment().is_some() { return Err(invalid()); }
    Ok(url.to_string())
}

/// A web address someone put in a report. The runtime opens only those a report holds.
fn inbox_link_url(value: &str) -> Result<String, String> {
    let invalid = || "Only a web link from a report can open here".to_string();
    let url = Url::parse(value).map_err(|_| invalid())?;
    if value.len() > 4096 || !matches!(url.scheme(), "https" | "http") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() { return Err(invalid()); }
    Ok(url.to_string())
}

/// A file the runtime keeps in the profile, from a report or attached by the person, of a
/// kind that holds no program.
fn saved_file(value: &str, data: &std::path::Path) -> Result<String, String> {
    const KINDS: [&str; 24] = ["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "txt", "log", "md", "csv",
        "json", "png", "jpg", "jpeg", "gif", "webp", "heic", "mp4", "mov", "webm", "m4a", "mp3"];
    let invalid = || "Only a file MemCode keeps can open here".to_string();
    let path = std::path::Path::new(value).canonicalize().map_err(|_| invalid())?;
    let kind = path.extension().and_then(|kind| kind.to_str()).unwrap_or_default().to_ascii_lowercase();
    let known = KINDS.contains(&kind.as_str()) || kind == "wav";
    let kept = ["inbox-files", "attachments"].iter()
        .filter_map(|folder| data.join(folder).canonicalize().ok())
        .any(|folder| path.starts_with(&folder));
    if !kept || !path.is_file() || !known { return Err(invalid()); }
    Ok(dunce::simplified(&path).to_string_lossy().into_owned())
}

#[cfg(test)]
mod inbox_tests {
    use super::{inbox_link_url, saved_file};
    #[test]
    fn a_report_opens_web_links_and_nothing_else() {
        for value in ["https://acme.slack.com/archives/C1/p1", "https://sentry.io/issues/4f2?a=1#b", "http://localhost:3000/cart"] {
            assert!(inbox_link_url(value).is_ok(), "rejected {value}");
        }
        for value in ["file:///C:/Windows/system32/calc.exe", "javascript:alert(1)", "ms-settings:", "slack://open",
            "https://user:pass@acme.test/", "\\\\server\\share", "C:\\a.exe", ""] {
            assert!(inbox_link_url(value).is_err(), "accepted {value}");
        }
    }
    #[test]
    fn only_a_harmless_file_memcode_keeps_opens() {
        let data = std::env::temp_dir().join(format!("memcode-inbox-{}", std::process::id()));
        let kept = data.join("inbox-files").join("ab");
        std::fs::create_dir_all(&kept).unwrap();
        for name in ["report.pdf", "Screen shot (2).PNG", "run.exe", "page.html", "macro.docm"] {
            std::fs::write(kept.join(name), b"x").unwrap();
        }
        std::fs::write(data.join("outside.pdf"), b"x").unwrap();
        let path = |name: &str| kept.join(name).to_string_lossy().into_owned();
        assert!(saved_file(&path("report.pdf"), &data).is_ok());
        assert!(saved_file(&path("Screen shot (2).PNG"), &data).is_ok());
        let attached = data.join("attachments").join("cd");
        std::fs::create_dir_all(&attached).unwrap();
        std::fs::write(attached.join("plan.pptx"), b"x").unwrap();
        assert!(saved_file(&attached.join("plan.pptx").to_string_lossy(), &data).is_ok());
        for name in ["run.exe", "page.html", "macro.docm", "missing.pdf", "../../outside.pdf"] {
            assert!(saved_file(&path(name), &data).is_err(), "accepted {name}");
        }
        std::fs::remove_dir_all(&data).unwrap();
    }
}

fn memcode_beta_url(value: &str) -> Result<String, String> {
    let invalid = || "Only the official Memtrace beta authorization can open here".to_string();
    let url = Url::parse(value).map_err(|_| invalid())?;
    if value.len() > 4096 || url.scheme() != "https" || url.host_str() != Some("www.memtrace.io")
        || url.path() != "/api/memcode/beta/authorize" || !url.username().is_empty() || url.password().is_some()
        || url.port_or_known_default() != Some(443) || url.fragment().is_some() { return Err(invalid()); }
    let pairs: Vec<_> = url.query_pairs().collect();
    let names = ["device_id", "session_id", "nonce", "expires_at", "redirect_uri", "state", "code_challenge", "code_challenge_method"];
    if pairs.len() != names.len() || names.iter().any(|name| pairs.iter().filter(|(key, _)| key == name).count() != 1) { return Err(invalid()); }
    let get = |name: &str| pairs.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_ref()).unwrap_or("");
    let opaque = |value: &str, minimum: usize, maximum: usize| (minimum..=maximum).contains(&value.len()) && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !opaque(get("device_id"),16,128) || !opaque(get("session_id"),16,128)
        || !opaque(get("nonce"),32,200) || !opaque(get("state"),32,200)
        || !opaque(get("code_challenge"),43,43) || get("code_challenge_method") != "S256" { return Err(invalid()); }
    let expires = get("expires_at").as_bytes();
    if expires.len() != 24 || expires.iter().enumerate().any(|(i,c)| match i {4|7 => *c != b'-',10 => *c != b'T',13|16 => *c != b':',19 => *c != b'.',23 => *c != b'Z',_ => !c.is_ascii_digit()}) { return Err(invalid()); }
    let callback = Url::parse(get("redirect_uri")).map_err(|_| invalid())?;
    if callback.scheme() != "http" || callback.host_str() != Some("127.0.0.1") || callback.port().unwrap_or(0) < 1024
        || !callback.username().is_empty() || callback.password().is_some() || callback.query().is_some() || callback.fragment().is_some()
        || callback.path() != format!("/memcode-beta/{}", get("state")) { return Err(invalid()); }
    Ok(url.to_string())
}

#[cfg(test)]
mod beta_url_tests {
    use super::memcode_beta_url;
    #[test]
    fn beta_authorization_opener_is_pinned_to_the_exact_service_and_callback() {
        let state="s".repeat(43);
        let mut url=tauri::Url::parse("https://www.memtrace.io/api/memcode/beta/authorize").unwrap();
        for (key,value) in [("device_id","device-binding-123456".to_string()),("session_id","session-binding-123456".to_string()),("nonce","n".repeat(43)),("expires_at","2026-11-16T12:00:00.000Z".to_string()),("redirect_uri",format!("http://127.0.0.1:31245/memcode-beta/{state}")),("state",state),("code_challenge","c".repeat(43)),("code_challenge_method","S256".to_string())] {url.query_pairs_mut().append_pair(key,&value);}
        assert!(memcode_beta_url(url.as_str()).is_ok());
        for (key,value) in [("redirect_uri","http://localhost:31245/other"),("code_challenge_method","plain"),("device_id","short"),("state","short"),("expires_at","unbounded")]{let mut bad=url.clone();let pairs:Vec<_>=bad.query_pairs().map(|(k,v)|(k.to_string(),if k==key{value.to_string()}else{v.to_string()})).collect();bad.set_query(None);bad.query_pairs_mut().extend_pairs(pairs);assert!(memcode_beta_url(bad.as_str()).is_err());}
        for bad in [url.to_string().replace("www.memtrace.io","evil.example"),url.to_string().replace("https:","http:"),url.to_string().replace("/api/memcode/beta/authorize","/api/memcode/authorize"),format!("{}&state=extra",url),format!("{}#secret",url)] {assert!(memcode_beta_url(&bad).is_err());}
    }
}

#[cfg(test)]
mod claim_url_tests {
    use super::{github_pull_request_url, memcode_identity_url, memtrace_claim_url, slack_install_url};
    #[test]
    fn pull_request_opener_accepts_only_github_pull_and_compare_pages() {
        for value in [
            "https://github.com/acme/app/pull/42",
            "https://github.com/acme/app/compare/main...epic/mc-12?expand=1&title=Tokens&body=Text",
        ] {
            assert!(github_pull_request_url(value).is_ok(), "rejected {value}");
        }
        for value in [
            "http://github.com/acme/app/pull/42",
            "https://github.com.evil.test/acme/app/pull/42",
            "https://gist.github.com/acme/app/pull/42",
            "https://user:pass@github.com/acme/app/pull/42",
            "https://github.com:444/acme/app/pull/42",
            "https://github.com/acme/app/pull/42#files",
            "https://github.com/acme/app/pull/abc",
            "https://github.com/acme/app/settings",
            "https://github.com/acme/app/compare/main",
            "https://github.com/login/device",
            "file:///acme/app/pull/42",
        ] {
            assert!(github_pull_request_url(value).is_err(), "accepted {value}");
        }
    }
    #[test]
    fn claim_url_accepts_only_the_official_device_claim() {
        assert!(memtrace_claim_url("https://memtrace.io/claim?code=ABCD-1234").is_ok());
        let slack = "https://slack.com/oauth/v2/authorize?client_id=123.456&scope=app_mentions%3Aread&redirect_uri=https%3A%2F%2Fsync.hosted.memtrace.io%2Fslack%2Foauth&state=1.2.v0%3Dab";
        assert!(slack_install_url(slack).is_ok());
        for bad in [slack.replace("slack.com", "slack.com.evil.test"), slack.replace("https:", "http:"), slack.replace("/oauth/v2/authorize", "/oauth/other"), format!("{slack}&extra=1"), format!("{slack}#x"), slack.replace("https%3A%2F%2Fsync", "http%3A%2F%2Fsync")] {
            assert!(slack_install_url(&bad).is_err(), "{bad}");
        }
        for value in [
            "http://memtrace.io/claim?code=ABCD-1234",
            "https://memtrace.io.evil.test/claim?code=ABCD-1234",
            "https://memtrace.io/other?code=ABCD-1234",
            "https://user:pass@memtrace.io/claim?code=ABCD-1234",
            "https://memtrace.io:444/claim?code=ABCD-1234",
            "https://memtrace.io/claim?code=ABCD-1234&redirect=https://evil.test",
            "file:///claim?code=ABCD-1234",
        ] {
            assert!(memtrace_claim_url(value).is_err(), "accepted {value}");
        }
    }
    #[test]
    fn team_identity_opener_is_scoped_to_official_pkce_flow() {
        let state = "s".repeat(43);
        let mut url = tauri::Url::parse("https://memtrace.io/api/memcode/authorize").unwrap();
        url.query_pairs_mut().extend_pairs([
            ("audience", "https://team.example.test".to_string()), ("nonce", "n".repeat(43)),
            ("expires_at", "2026-11-15T22:50:00.000Z".to_string()), ("state", state.clone()),
            ("redirect_uri", format!("http://127.0.0.1:54321/memcode-identity/{state}")),
            ("code_challenge", "c".repeat(43)), ("code_challenge_method", "S256".to_string()),
        ]);
        assert!(memcode_identity_url(url.as_str()).is_ok());
        for (key, value) in [
            ("audience", "http://remote.test"), ("audience", "https://user:pass@team.test"),
            ("audience", "https://team.test/path"), ("redirect_uri", "https://remote.test/callback"),
            ("redirect_uri", "http://localhost:54321/memcode-identity/x"), ("redirect_uri", "http://127.0.0.1:80/memcode-identity/x"),
            ("state", "bad"), ("code_challenge_method", "plain"), ("expires_at", "forever"),
        ] {
            let mut bad = url.clone();
            let pairs: Vec<_> = url.query_pairs().map(|(k, v)| (k.to_string(), if k == key { value.to_string() } else { v.to_string() })).collect();
            bad.set_query(None); bad.query_pairs_mut().extend_pairs(pairs);
            assert!(memcode_identity_url(bad.as_str()).is_err(), "accepted {key}={value}");
        }
        for (key, value) in [("redirect", "https://attacker.test"), ("nonce", "duplicate")] {
            let mut bad = url.clone(); bad.query_pairs_mut().append_pair(key, value);
            assert!(memcode_identity_url(bad.as_str()).is_err());
        }
        for bad in [url.to_string().replace("https://memtrace.io", "http://memtrace.io"),
            url.to_string().replace("memtrace.io", "memtrace.io.evil.test"),
            url.to_string().replace("/api/memcode/authorize", "/claim"), format!("{}#token", url)] {
            assert!(memcode_identity_url(&bad).is_err());
        }
    }
}

fn open_claim(url: &str) -> Result<(), String> {
    let mut command = std::process::Command::new(if cfg!(windows) {
        "rundll32.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    });
    if cfg!(windows) {
        command.arg("url.dll,FileProtocolHandler");
    }
    command.arg(url);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn open_folder(path: &str) -> Result<(), String> {
    let mut command = std::process::Command::new(if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    });
    command.arg(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn capture_visible(app: &AppHandle, bounds: Bounds) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Foundation::POINT, Graphics::Gdi::*};
    let window = app.get_window("main").ok_or("Main window is unavailable")?;
    window.set_focus().map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(100));
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as _;
    if unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() } != hwnd {
        return Err("Bring MemCode to the foreground before capturing its visible preview".into());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let x = (bounds.x * scale).round().max(0.0) as i32;
    let y = (bounds.y * scale).round().max(0.0) as i32;
    let width = (bounds.width * scale)
        .round()
        .min((size.width as i32 - x).max(0) as f64) as i32;
    let height = (bounds.height * scale)
        .round()
        .min((size.height as i32 - y).max(0) as f64) as i32;
    if width < 1 || height < 1 || width > 12000 || height > 12000 {
        return Err("The visible preview has no capturable area".into());
    }
    let mut origin = POINT { x: 0, y: 0 };
    // Capture the visible native preview region. This deliberately does not claim
    // to capture hidden/occluded content or a page larger than its viewport.
    unsafe {
        if ClientToScreen(hwnd, &mut origin) == 0 {
            return Err("Could not locate the preview on screen".into());
        }
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("Could not access the screen surface".into());
        }
        let memory = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        if memory.is_null() || bitmap.is_null() {
            if !memory.is_null() {
                DeleteDC(memory);
            }
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("Could not allocate the preview capture".into());
        }
        let previous = SelectObject(memory, bitmap);
        let copied = BitBlt(
            memory,
            0,
            0,
            width,
            height,
            screen,
            origin.x + x,
            origin.y + y,
            SRCCOPY | CAPTUREBLT,
        );
        // GetDIBits requires the bitmap to be unselected from the device context.
        SelectObject(memory, previous);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let rows = if copied != 0 {
            GetDIBits(
                memory,
                bitmap,
                0,
                height as u32,
                pixels.as_mut_ptr() as _,
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(std::ptr::null_mut(), screen);
        if rows == 0 {
            return Err(
                "The preview could not be captured. Bring MemCode into view and try again.".into(),
            );
        }
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        let image = image::RgbaImage::from_raw(width as u32, height as u32, pixels)
            .ok_or("Invalid capture pixels")?;
        let mut output = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(output.into_inner())
    }
}
#[cfg(not(windows))]
fn capture_visible(_app: &AppHandle, _bounds: Bounds) -> Result<Vec<u8>, String> {
    Err("Native visible-preview capture is currently implemented for Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn application_origin_is_exact() {
        for url in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
        ] {
            assert!(main_origin(&url.parse().unwrap()));
        }
        for url in [
            "https://example.com",
            "http://tauri.localhost.evil/index.html",
            "http://127.0.0.1:9328",
            "file:///C:/secret",
        ] {
            assert!(!main_origin(&url.parse().unwrap()));
        }
    }
    #[test]
    fn preview_accepts_only_credential_free_loopback() {
        for url in [
            "http://localhost:3000",
            "http://127.0.0.1:8080/path",
            "http://[::1]:8080",
        ] {
            assert!(loopback(&url.parse().unwrap()));
        }
        for url in [
            "https://example.com",
            "http://localhost.evil",
            "http://user:pass@localhost:8080",
            "file:///C:/secret",
            "javascript:alert(1)",
        ] {
            assert!(!loopback(&url.parse().unwrap()));
        }
    }
}
