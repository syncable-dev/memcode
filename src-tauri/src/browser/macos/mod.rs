//! macOS card browsers: a real WKWebView over the card, one WebKit data store per card.
//! Guest pages get no bridge at all. MemCode's own scripts run in a separate content
//! world, and worker input is delivered to the view directly, never through the app's
//! event queue, so only the human's own input reaches `human_input`.
mod address_policy;
mod capture;
mod human_input;
mod input;
mod script;
mod surface;

use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::oneshot;

type Reply = oneshot::Sender<Result<Value, String>>;

pub async fn call(app: AppHandle, method: String, input: Value) -> Result<Value, String> {
    let (reply, answer) = oneshot::channel();
    let main = app.clone();
    app.run_on_main_thread(move || dispatch(&main, &method, input, reply))
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(25), answer)
        .await
        .map_err(|_| "Native browser operation timed out")?
        .map_err(|_| "Native browser operation closed")?
}

fn dispatch(app: &AppHandle, method: &str, input: Value, reply: Reply) {
    match method {
        "browser_create" => surface::create(app, input, reply),
        "browser_capture" => capture::capture(&input, reply),
        "browser_eval" => script::evaluate(&input, reply),
        _ => {
            let _ = reply.send(surface::operate(method, &input));
        }
    }
}
