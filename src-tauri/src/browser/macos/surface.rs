//! Card surfaces: create, place, show, hide and close the WKWebViews over cards.
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};

use objc2::rc::Retained;
use objc2_web_kit::{WKContentRuleList, WKWebView, WKWebViewConfiguration};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use wry::{
    BackgroundThrottlingPolicy, NewWindowFeatures, NewWindowResponse, PageLoadEvent,
    PermissionResponse, Rect, WebView, WebViewBuilder, WebViewBuilderExtDarwin,
    WebViewBuilderExtMacos, WebViewExtMacOS,
};

use super::{address_policy, focus, human_input, input, self_close::SelfCloseListener, Reply};
use crate::native::Bounds;

const INITIAL_BOUNDS: Bounds = Bounds {
    x: 0.0,
    y: 0.0,
    width: 1280.0,
    height: 800.0,
};
const MAX_SIDE: f64 = 10000.0;

pub(super) struct Surface {
    pub owner: String,
    pub wk: Retained<WKWebView>,
    opener: Option<String>,
    view: WebView,
    bounds: Bounds,
    visible: bool,
    loads: Rc<Cell<u64>>,
    self_close: Retained<SelfCloseListener>,
}

thread_local! {
    pub(super) static SURFACES: RefCell<HashMap<String, Surface>> = RefCell::new(HashMap::new());
}
static NEXT: AtomicU64 = AtomicU64::new(1);

enum Configuration {
    Card {
        store: [u8; 16],
        rules: Retained<WKContentRuleList>,
    },
    /// A page's `window.open`: WebKit requires the opener's configuration.
    Popup(Retained<WKWebViewConfiguration>),
}

fn next_id() -> String {
    format!("native-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

fn rect(bounds: Bounds) -> Rect {
    Rect {
        position: wry::dpi::LogicalPosition::new(bounds.x, bounds.y).into(),
        size: wry::dpi::LogicalSize::new(bounds.width, bounds.height).into(),
    }
}

pub(super) fn create(app: &AppHandle, input: Value, reply: Reply) {
    let request = (|| -> Result<(String, [u8; 16]), String> {
        let owner = input["taskId"].as_str().ok_or("Missing browser owner")?;
        let profile = input["profile"].as_str().ok_or("Missing browser profile")?;
        Ok((owner.to_owned(), address_policy::store_identifier(profile)?))
    })();
    let (owner, store) = match request {
        Ok(request) => request,
        Err(error) => {
            let _ = reply.send(Err(error));
            return;
        }
    };
    human_input::watch(app);
    let app = app.clone();
    address_policy::with_rules(move |rules| {
        let created = rules.and_then(|rules| {
            let id = next_id();
            let surface = build(&app, Configuration::Card { store, rules }, &owner, None, &id)?;
            SURFACES.with(|surfaces| surfaces.borrow_mut().insert(id.clone(), surface));
            Ok(json!({ "nativeId": id }))
        });
        let _ = reply.send(created);
    });
}

fn build(
    app: &AppHandle,
    configuration: Configuration,
    owner: &str,
    opener: Option<String>,
    id: &str,
) -> Result<Surface, String> {
    let window = app.get_window("main").ok_or("Main window is unavailable")?;
    let loads = Rc::new(Cell::new(0u64));
    let committed = loads.clone();
    let popup_app = app.clone();
    let popup_owner = owner.to_owned();
    let popup_opener = id.to_owned();
    let builder = WebViewBuilder::new()
        .with_visible(false)
        .with_focused(false)
        .with_bounds(rect(INITIAL_BOUNDS))
        .with_background_throttling(BackgroundThrottlingPolicy::Disabled)
        .with_navigation_handler(|url| address_policy::navigable(&url))
        .with_new_window_req_handler(move |url, features| {
            open_popup(&popup_app, &popup_owner, &popup_opener, &url, features)
        })
        .with_download_started_handler(|_, _| false)
        .with_permission_handler(|_| PermissionResponse::Deny)
        .with_on_page_load_handler(move |event, _| {
            if matches!(event, PageLoadEvent::Started) {
                committed.set(committed.get() + 1);
            }
        });
    let (builder, rules) = match configuration {
        Configuration::Card { store, rules } => {
            (builder.with_data_store_identifier(store), Some(rules))
        }
        Configuration::Popup(shared) => (builder.with_webview_configuration(shared), None),
    };
    let view = builder.build_as_child(&window).map_err(|e| e.to_string())?;
    if let Some(rules) = rules {
        unsafe { view.manager().addContentRuleList(&rules) };
    }
    let wk = Retained::into_super(view.webview());
    let self_close = SelfCloseListener::install(&wk);
    Ok(Surface {
        owner: owner.to_owned(),
        wk,
        opener,
        view,
        bounds: INITIAL_BOUNDS,
        visible: false,
        loads,
        self_close,
    })
}

/// Drops the pages that called `window.close()`. This runs at the start of a browser
/// call, outside WebKit's own callback. The runtime then sees them missing from
/// `browser_pages` and closes their tabs.
pub(super) fn remove_self_closed() {
    SURFACES.with(|surfaces| {
        if let Ok(mut surfaces) = surfaces.try_borrow_mut() {
            surfaces.retain(|_, surface| !surface.self_close.requested());
        }
    });
}

fn open_popup(
    app: &AppHandle,
    owner: &str,
    opener: &str,
    url: &str,
    features: NewWindowFeatures,
) -> NewWindowResponse {
    if !address_policy::navigable(url) {
        return NewWindowResponse::Deny;
    }
    let id = next_id();
    let configuration = Configuration::Popup(features.opener.target_configuration);
    let Ok(surface) = build(app, configuration, owner, Some(opener.to_owned()), &id) else {
        return NewWindowResponse::Deny;
    };
    let webview = surface.wk.clone();
    let adopted = SURFACES.with(|surfaces| {
        surfaces
            .try_borrow_mut()
            .map(|mut surfaces| surfaces.insert(id, surface))
            .is_ok()
    });
    if adopted {
        NewWindowResponse::Create { webview }
    } else {
        NewWindowResponse::Deny
    }
}

fn place(surface: &Surface) -> Result<(), String> {
    surface.view.set_bounds(rect(surface.bounds)).map_err(|e| e.to_string())?;
    surface.view.set_visible(surface.visible).map_err(|e| e.to_string())
}

fn page_state(id: &str, surface: &Surface) -> Value {
    let url = unsafe { surface.wk.URL() }
        .and_then(|url| url.absoluteString())
        .map(|url| url.to_string())
        .unwrap_or_else(|| "about:blank".into());
    let title = unsafe { surface.wk.title() }.map(|title| title.to_string()).unwrap_or_default();
    json!({
        "nativeId": id,
        "opener": surface.opener,
        "url": url,
        "title": title,
        "loading": unsafe { surface.wk.isLoading() },
        "loads": surface.loads.get(),
    })
}

fn valid_bounds(value: &Value) -> Result<Bounds, String> {
    let bounds: Bounds = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    let finite = [bounds.x, bounds.y, bounds.width, bounds.height].iter().all(|n| n.is_finite());
    if !finite
        || bounds.x < 0.0
        || bounds.y < 0.0
        || bounds.width < 1.0
        || bounds.height < 1.0
        || bounds.width > MAX_SIDE
        || bounds.height > MAX_SIDE
    {
        return Err("Invalid native browser bounds".into());
    }
    Ok(bounds)
}

/// Looks up a surface the given work item owns.
pub(super) fn owned<'a>(
    surfaces: &'a mut HashMap<String, Surface>,
    input: &Value,
) -> Result<&'a mut Surface, String> {
    let id = input["nativeId"].as_str().ok_or("Missing browser surface")?;
    let owner = input["taskId"].as_str().ok_or("Missing browser owner")?;
    let surface = surfaces.get_mut(id).ok_or("Browser surface not found")?;
    if surface.owner != owner {
        return Err("Browser surface belongs to another work item".into());
    }
    Ok(surface)
}

pub(super) fn operate(method: &str, input: &Value) -> Result<Value, String> {
    SURFACES.with(|surfaces| {
        let mut surfaces = surfaces.borrow_mut();
        match method {
            "browser_hide_all" => {
                for surface in surfaces.values_mut() {
                    surface.visible = false;
                    place(surface)?;
                }
            }
            "browser_close_all" => surfaces.clear(),
            "browser_close_task" => {
                let owner = input["taskId"].as_str().ok_or("Missing browser owner")?;
                surfaces.retain(|_, surface| surface.owner != owner);
            }
            "browser_pages" => {
                let owner = input["taskId"].as_str().ok_or("Missing browser owner")?;
                let pages: Vec<Value> = surfaces
                    .iter()
                    .filter(|(_, surface)| surface.owner == owner)
                    .map(|(id, surface)| page_state(id, surface))
                    .collect();
                return Ok(Value::Array(pages));
            }
            "browser_close" => {
                owned(&mut surfaces, input)?;
                surfaces.remove(input["nativeId"].as_str().unwrap_or_default());
            }
            "browser_surface" => show(&mut surfaces, input)?,
            "browser_navigate" => {
                let url = input["url"].as_str().ok_or("Missing address")?;
                if !address_policy::navigable(url) || url.starts_with("data:") || url.starts_with("blob:") {
                    return Err("Open an HTTPS website or a localhost development server.".into());
                }
                owned(&mut surfaces, input)?.view.load_url(url).map_err(|e| e.to_string())?;
            }
            "browser_history" => {
                let surface = owned(&mut surfaces, input)?;
                let _ = match input["action"].as_str() {
                    Some("back") => unsafe { surface.wk.goBack() },
                    Some("forward") => unsafe { surface.wk.goForward() },
                    Some("reload") => unsafe { surface.wk.reload() },
                    _ => return Err("Unknown browser history action".into()),
                };
            }
            "browser_input" => {
                let card = &owned(&mut surfaces, input)?.wk;
                focus::remember(card);
                input::deliver(card, &input["input"])?
            }
            _ => return Err("Unknown browser surface operation".into()),
        }
        Ok(Value::Null)
    })
}

/// Shows one card's tab and hides every other surface, as on Windows.
fn show(surfaces: &mut HashMap<String, Surface>, input: &Value) -> Result<(), String> {
    let visible = input["visible"].as_bool().unwrap_or(false);
    let bounds = if visible { Some(valid_bounds(&input["bounds"])?) } else { None };
    owned(surfaces, input)?;
    let shown = input["nativeId"].as_str().unwrap_or_default();
    for (id, other) in surfaces.iter_mut() {
        if id != shown {
            other.visible = false;
            place(other)?;
        }
    }
    let surface = owned(surfaces, input)?;
    if let Some(bounds) = bounds {
        surface.bounds = bounds;
    }
    surface.visible = visible;
    place(surface)
}
