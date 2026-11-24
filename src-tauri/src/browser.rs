//! Native browser surfaces. Guest pages receive no Tauri bridge or application RPC.
//! Windows: WebView2 driven over CDP. macOS: WKWebView driven natively (`browser/macos`).
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// What wry itself passes to WebView2. Giving arguments replaces these, so they are kept.
const WEBVIEW_ARGUMENTS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
const DEVELOPER_ARGUMENTS: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

/// How MemCode's own views are started, apart from workers' pages.
pub struct BrowserState {
    developer: Option<String>,
}
impl BrowserState {
    /// Takes the WebView2 arguments a developer or a test set out of the environment, before
    /// anything else starts. WebView2 would give them to every view of this process, workers'
    /// pages included, and every program MemCode starts would inherit them. Only a development
    /// build or a profile of its own may have them: whoever can talk to a debugging port of the
    /// main window can do all that MemCode can.
    pub fn take() -> Self {
        let set = std::env::var(DEVELOPER_ARGUMENTS).ok();
        std::env::remove_var(DEVELOPER_ARGUMENTS);
        let allowed =
            cfg!(debug_assertions) || std::env::var_os("MEMCODE_DATA_DIR").is_some();
        Self {
            developer: set.filter(|set| allowed && !set.trim().is_empty()),
        }
    }

    /// The arguments for MemCode's own views, when they differ from wry's. All of them share
    /// one browser, so all of them need the same.
    pub fn app_arguments(&self) -> Option<String> {
        let developer = self.developer.as_deref()?;
        Some(format!("{WEBVIEW_ARGUMENTS} {developer}"))
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
    use wry::{WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};
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
    /// Workers' pages run in a browser of their own, apart from MemCode's window: they are the
    /// only ones the runtime drives over a debugging port, and a program that finds that port
    /// must not reach the window. The browser, and its port, are there only while a page is.
    fn worker_pages(context: &mut WebContext) -> WebViewBuilder<'_> {
        WebViewBuilder::new_with_web_context(context).with_additional_browser_args(format!(
            "{WEBVIEW_ARGUMENTS} --remote-debugging-port=0"
        ))
    }

    /// A page in the browser of workers' pages. A popup is made in its opener's environment.
    /// Answers with the browser's process id.
    fn create(
        app: &AppHandle,
        owner: String,
        id: String,
        profile: String,
        opener: Option<ICoreWebView2Environment>,
    ) -> Result<u32, String> {
        let popup = opener.is_some();
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
        let mut context = WebContext::new(Some(crate::native::worker_pages_dir(app)?));
        let builder = match opener {
            Some(environment) => WebViewBuilder::new().with_environment(environment),
            None => worker_pages(&mut context).with_url(marker(&id)),
        }
        .with_profile_name(profile);
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
        let mut browser = 0;
        unsafe {
            view.controller()
                .CoreWebView2()
                .and_then(|core| core.BrowserProcessId(&mut browser))
                .map_err(|e| e.to_string())?;
        }
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
        Ok(browser)
    }

    fn marker(id: &str) -> String {
        format!("about:blank#memcode-{id}")
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
                                    Some(popup.environment),
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
            let (made, created) = tokio::sync::oneshot::channel();
            let (main, page) = (app.clone(), id.clone());
            app.run_on_main_thread(move || {
                let _ = made.send(create(&main, owner, page, profile, None));
            })
            .map_err(|e| e.to_string())?;
            let browser = tokio::time::timeout(std::time::Duration::from_secs(20), created)
                .await
                .map_err(|_| "Native browser operation timed out")?
                .map_err(|_| "Native browser operation closed")??;
            let port = crate::browser_port::of(browser).await?;
            return Ok(
                json!({"nativeId":id,"marker":marker(&id),"endpoint":format!("http://127.0.0.1:{port}")}),
            );
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

#[cfg(test)]
mod tests {
    use super::{BrowserState, DEVELOPER_ARGUMENTS};

    #[test]
    fn a_debugging_port_is_taken_out_of_the_environment_and_stays_out_of_workers_pages() {
        std::env::set_var(DEVELOPER_ARGUMENTS, "--remote-debugging-port=9");
        let state = BrowserState::take();
        assert!(std::env::var_os(DEVELOPER_ARGUMENTS).is_none());
        // A development build, as tests are, may have it for its own window.
        let arguments = state.app_arguments().unwrap();
        assert!(arguments.contains("msSmartScreenProtection"), "{arguments}");
        assert!(arguments.ends_with(" --remote-debugging-port=9"), "{arguments}");

        std::env::set_var(DEVELOPER_ARGUMENTS, " ");
        assert_eq!(BrowserState::take().app_arguments(), None);
        assert_eq!(BrowserState::take().app_arguments(), None);
    }
}
