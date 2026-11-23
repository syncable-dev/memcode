//! Native browser surfaces. Guest pages receive no Tauri bridge or application RPC.
//! Windows: WebView2 driven over CDP. macOS: WKWebView driven natively (`browser/macos`).
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

pub struct BrowserState {
    pub port: u16,
}
impl BrowserState {
    pub fn new() -> Self {
        let arguments = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let existing = arguments.split_whitespace().find_map(|part| {
            part.strip_prefix("--remote-debugging-port=")
                .and_then(|value| value.parse::<u16>().ok())
        });
        let port = existing.filter(|port| *port != 0).unwrap_or_else(|| {
            std::net::TcpListener::bind(("127.0.0.1", 0))
                .expect("Could not reserve local browser control port")
                .local_addr()
                .unwrap()
                .port()
        });
        if existing.filter(|port| *port != 0).is_none() {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", format!("{arguments} --remote-debugging-port={port} --remote-debugging-address=127.0.0.1"));
        }
        Self { port }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        cell::RefCell,
        collections::{HashMap, VecDeque},
        rc::Rc,
        sync::atomic::{AtomicU64, Ordering},
    };
    use webview2_com::{
        take_pwstr,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Deferral, ICoreWebView2Environment,
            ICoreWebView2NewWindowRequestedEventArgs,
        },
        NewWindowRequestedEventHandler,
    };
    use wry::{WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};
    struct Surface {
        owner: String,
        view: WebView,
        busy: Rc<RefCell<InputWindows>>,
        bounds: crate::native::Bounds,
        visible: bool,
        capture: Option<u64>,
    }
    fn apply_surface(surface: &Surface) -> Result<(), String> {
        let b = surface.bounds;
        // Hidden worker pages need compositor frames for native captures and
        // Playwright's actionability checks. Paint those short operations outside
        // the client area without flashing another card or taking user focus.
        let painting = surface.capture.is_some() || surface.busy.borrow().active.is_some();
        let x = if !surface.visible && painting {
            -b.width - 100.0
        } else {
            b.x
        };
        surface
            .view
            .set_bounds(wry::Rect {
                position: wry::dpi::LogicalPosition::new(x, b.y).into(),
                size: wry::dpi::LogicalSize::new(b.width, b.height).into(),
            })
            .map_err(|e| e.to_string())?;
        surface
            .view
            .set_visible(surface.visible || painting)
            .map_err(|e| e.to_string())
    }
    fn finish_capture(id: &str, generation: u64) {
        SURFACES.with(|surfaces| {
            if let Some(surface) = surfaces.borrow_mut().get_mut(id) {
                if surface.capture == Some(generation) {
                    surface.capture = None;
                    let _ = apply_surface(surface);
                }
            }
        });
    }
    #[derive(Default)]
    struct InputWindows {
        active: Option<u64>,
        recent: VecDeque<(u64, u64)>,
    }
    fn millis() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
    thread_local! { static SURFACES: RefCell<HashMap<String, Surface>> = RefCell::new(HashMap::new()); }
    struct Popup {
        owner: String,
        profile: String,
        environment: ICoreWebView2Environment,
        args: ICoreWebView2NewWindowRequestedEventArgs,
        deferral: ICoreWebView2Deferral,
    }
    thread_local! {static POPUPS:RefCell<HashMap<u64,Popup>>=RefCell::new(HashMap::new());}
    static NEXT: AtomicU64 = AtomicU64::new(1);

    fn guest_url(value: &str) -> bool {
        if value == "about:blank" || value.starts_with("about:blank#memcode-") {
            return true;
        }
        let Ok(url) = tauri::Url::parse(value) else {
            return false;
        };
        let host = url.host_str().unwrap_or("");
        !matches!(
            host,
            "tauri.localhost" | "ipc.localhost" | "asset.localhost"
        ) && url.username().is_empty()
            && url.password().is_none()
            && (url.scheme() == "https"
                || (url.scheme() == "http"
                    && matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")))
    }
    fn create(
        app: &AppHandle,
        owner: String,
        id: String,
        profile: String,
        environment: ICoreWebView2Environment,
        popup: bool,
    ) -> Result<Value, String> {
        let window = app.get_window("main").ok_or("Main window is unavailable")?;
        let busy = Rc::new(RefCell::new(InputWindows::default()));
        let input_busy = busy.clone();
        let input_app = app.clone();
        let input_owner = owner.clone();
        let popup_profile = profile.clone();
        let script = format!(
            r#"Object.defineProperty(window,'__memcodeNativeTab',{{value:{}}});Object.defineProperty(window,'__memcodeNativeOwner',{{value:{}}});Object.defineProperty(window,'__memcodeNativePopup',{{value:{}}});
            for(const name of ['pointerdown','keydown','wheel'])addEventListener(name,event=>{{if(event.isTrusted)window.ipc.postMessage(JSON.stringify({{kind:'memcode-user-input',at:Date.now()}}))}},{{capture:true,passive:true}});"#,
            serde_json::to_string(&id).unwrap(),
            serde_json::to_string(&owner).unwrap(),
            popup
        );
        let builder = WebViewBuilder::new()
            .with_environment(environment)
            .with_profile_name(profile);
        let builder = if popup {
            builder
        } else {
            builder.with_url(format!("about:blank#memcode-{id}"))
        };
        let view = builder
            .with_visible(false)
            .with_focused(false)
            .with_bounds(wry::Rect {
                position: wry::dpi::LogicalPosition::new(0.0, 0.0).into(),
                size: wry::dpi::LogicalSize::new(1280.0, 800.0).into(),
            })
            .with_initialization_script(script)
            .with_navigation_handler(|url| guest_url(&url))
            .with_ipc_handler(move |request| {
                if request.body().len() > 120 {
                    return;
                }
                let Ok(event) = serde_json::from_str::<Value>(request.body()) else {
                    return;
                };
                let Some(at) = event["at"].as_u64() else {
                    return;
                };
                let current = millis();
                if event["kind"] != "memcode-user-input"
                    || at > current + 1000
                    || current.saturating_sub(at) > 15000
                {
                    return;
                }
                let busy = input_busy.borrow();
                let synthetic = busy.active.is_some_and(|start| at >= start)
                    || busy
                        .recent
                        .iter()
                        .any(|(start, end)| at >= *start && at <= *end);
                if !synthetic {
                    let _ = input_app.emit_to(
                        tauri::EventTarget::Webview {
                            label: "main".into(),
                        },
                        "browser:native-input",
                        json!({"taskId":input_owner,"at":at}),
                    );
                }
            })
            .build_as_child(&window)
            .map_err(|e| e.to_string())?;
        install_popup_handler(app, &view, owner.clone(), popup_profile)?;
        SURFACES.with(|surfaces| {
            surfaces.borrow_mut().insert(
                id.clone(),
                Surface {
                    owner,
                    view,
                    busy,
                    bounds: crate::native::Bounds {
                        x: 0.0,
                        y: 0.0,
                        width: 1280.0,
                        height: 800.0,
                    },
                    visible: false,
                    capture: None,
                },
            )
        });
        Ok(
            json!({"nativeId":id,"marker":format!("about:blank#memcode-{id}"),"endpoint":format!("http://127.0.0.1:{}",app.state::<BrowserState>().port)}),
        )
    }

    fn install_popup_handler(
        app: &AppHandle,
        view: &WebView,
        owner: String,
        profile: String,
    ) -> Result<(), String> {
        let core = unsafe {
            view.controller()
                .CoreWebView2()
                .map_err(|e| e.to_string())?
        };
        let environment = view.environment();
        let app = app.clone();
        let mut token = 0;
        unsafe {
            core.add_NewWindowRequested(
                &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut uri = ::windows::core::PWSTR::null();
                    args.Uri(&mut uri)?;
                    let url = take_pwstr(uri);
                    args.SetHandled(true)?;
                    if !guest_url(&url) {
                        return Ok(());
                    }
                    let deferral = args.GetDeferral()?;
                    let key = NEXT.fetch_add(1, Ordering::Relaxed);
                    POPUPS.with(|popups| {
                        popups.borrow_mut().insert(
                            key,
                            Popup {
                                owner: owner.clone(),
                                profile: profile.clone(),
                                environment: environment.clone(),
                                args,
                                deferral,
                            },
                        )
                    });
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let main = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            let Some(popup) =
                                POPUPS.with(|popups| popups.borrow_mut().remove(&key))
                            else {
                                return;
                            };
                            let id = format!("native-{}", NEXT.fetch_add(1, Ordering::Relaxed));
                            let result = (|| -> Result<(), String> {
                                create(
                                    &main,
                                    popup.owner,
                                    id.clone(),
                                    popup.profile,
                                    popup.environment,
                                    true,
                                )?;
                                let core = SURFACES.with(|surfaces| {
                                    surfaces
                                        .borrow()
                                        .get(&id)
                                        .unwrap()
                                        .view
                                        .controller()
                                        .CoreWebView2()
                                        .map_err(|e| e.to_string())
                                })?;
                                popup.args.SetNewWindow(&core).map_err(|e| e.to_string())?;
                                Ok(())
                            })();
                            if let Err(error) = result {
                                eprintln!("Native popup attach failed: {error}");
                                SURFACES.with(|surfaces| surfaces.borrow_mut().remove(&id));
                            }
                            let _ = popup.deferral.Complete();
                        });
                    });
                    Ok(())
                })),
                &mut token,
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub async fn call(app: AppHandle, method: String, input: Value) -> Result<Value, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if method == "browser_create" {
            let owner = input["taskId"]
                .as_str()
                .ok_or("Missing browser owner")?
                .to_owned();
            let profile = input["profile"]
                .as_str()
                .ok_or("Missing browser profile")?
                .to_owned();
            if profile.len() > 64
                || !profile
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-')
            {
                return Err("Invalid browser profile".into());
            }
            let id = format!("native-{}", NEXT.fetch_add(1, Ordering::Relaxed));
            let main = app.get_webview("main").ok_or("Main view is unavailable")?;
            main.with_webview(move |platform| {
                let _ = tx.send(create(
                    &app,
                    owner,
                    id,
                    profile,
                    platform.environment(),
                    false,
                ));
            })
            .map_err(|e| e.to_string())?;
        } else if method == "browser_capture" {
            let generation = NEXT.fetch_add(1, Ordering::Relaxed);
            let cleanup_id = input["nativeId"]
                .as_str()
                .ok_or("Missing native browser")?
                .to_owned();
            let timeout_id = cleanup_id.clone();
            let timeout_app = app.clone();
            app.run_on_main_thread(move || {
                let core = SURFACES.with(|surfaces| -> Result<_, String> {
                    let mut surfaces = surfaces.borrow_mut();
                    let id = input["nativeId"].as_str().ok_or("Missing native browser")?;
                    let surface = surfaces.get_mut(id).ok_or("Browser surface not found")?;
                    if input["taskId"].as_str() != Some(surface.owner.as_str()) {
                        return Err("Browser surface belongs to another work item".into());
                    }
                    surface.capture = Some(generation);
                    apply_surface(surface)?;
                    unsafe {
                        surface
                            .view
                            .controller()
                            .CoreWebView2()
                            .map_err(|e| e.to_string())
                    }
                });
                match core {
                    Ok(core) => crate::browser_capture::capture(
                        core,
                        input,
                        tx,
                        Box::new(move || finish_capture(&cleanup_id, generation)),
                    ),
                    Err(error) => {
                        finish_capture(&cleanup_id, generation);
                        let _ = tx.send(Err(error));
                    }
                }
            })
            .map_err(|e| e.to_string())?;
            let result = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
                .await
                .map_err(|_| "Native browser capture timed out".to_string())
                .and_then(|reply| reply.map_err(|_| "Native browser capture closed".to_string()))
                .and_then(|reply| reply);
            if result.is_err() {
                let _ =
                    timeout_app.run_on_main_thread(move || finish_capture(&timeout_id, generation));
            }
            return result;
        } else {
            app.run_on_main_thread(move || {
                let result = SURFACES.with(|surfaces| -> Result<Value, String> {
                    let mut surfaces = surfaces.borrow_mut();
                    if method == "browser_hide_all" {
                        for surface in surfaces.values_mut() {
                            surface.visible = false;
                            apply_surface(surface)?;
                        }
                        return Ok(Value::Null);
                    }
                    if method == "browser_close_all" {
                        surfaces.clear();
                        return Ok(Value::Null);
                    }
                    if method == "browser_close_task" {
                        let owner = input["taskId"].as_str().ok_or("Missing browser owner")?;
                        surfaces.retain(|_, surface| surface.owner != owner);
                        return Ok(Value::Null);
                    }
                    let id = input["nativeId"]
                        .as_str()
                        .ok_or("Missing browser surface")?;
                    let owner = input["taskId"].as_str().ok_or("Missing browser owner")?;
                    let surface = surfaces.get(id).ok_or("Browser surface not found")?;
                    if surface.owner != owner {
                        return Err("Browser surface belongs to another work item".into());
                    }
                    if method == "browser_close" {
                        surfaces.remove(id);
                        return Ok(Value::Null);
                    }
                    if method == "browser_busy" {
                        let mut busy = surface.busy.borrow_mut();
                        if input["busy"].as_bool().unwrap_or(false) {
                            busy.active = Some(millis());
                        } else if let Some(start) = busy.active.take() {
                            busy.recent.push_back((start, millis()));
                            while busy.recent.len() > 16 {
                                busy.recent.pop_front();
                            }
                        }
                        drop(busy);
                        apply_surface(surface)?;
                        return Ok(Value::Null);
                    }
                    if method != "browser_surface" {
                        return Err("Unknown browser surface operation".into());
                    }
                    let visible = input["visible"].as_bool().unwrap_or(false);
                    for (key, other) in surfaces.iter_mut() {
                        if key != id {
                            other.visible = false;
                            apply_surface(other)?;
                        }
                    }
                    let surface = surfaces.get_mut(id).unwrap();
                    if visible {
                        let bounds: crate::native::Bounds =
                            serde_json::from_value(input["bounds"].clone())
                                .map_err(|e| e.to_string())?;
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
                            return Err("Invalid native browser bounds".into());
                        }
                        surface.bounds = bounds;
                    }
                    surface.visible = visible;
                    apply_surface(surface)?;
                    Ok(Value::Null)
                });
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        }
        tokio::time::timeout(std::time::Duration::from_secs(20), rx)
            .await
            .map_err(|_| "Native browser operation timed out")?
            .map_err(|_| "Native browser operation closed")?
    }
}
#[cfg(target_os = "macos")]
mod macos;

pub async fn call(app: AppHandle, method: &str, input: Value) -> Result<Value, String> {
    #[cfg(windows)]
    {
        windows::call(app, method.to_owned(), input).await
    }
    #[cfg(target_os = "macos")]
    {
        macos::call(app, method.to_owned(), input).await
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app, method, input);
        Err("The shared native browser requires Windows WebView2 or macOS WebKit".into())
    }
}
