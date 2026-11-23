//! Notices the human's own clicks, keys and scrolling in a card surface.
//!
//! Real input passes through `NSApplication.sendEvent`, where local monitors run.
//! Worker input is handed straight to the WKWebView, so it never shows up here and
//! no time-window guess is needed to tell the two apart.
use std::{cell::RefCell, ptr::NonNull};

use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventType, NSView};
use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::surface::{Surface, SURFACES};

thread_local! {
    static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

pub(super) fn watch(app: &AppHandle) {
    MONITOR.with(|monitor| {
        if monitor.borrow().is_some() {
            return;
        }
        let app = app.clone();
        let seen = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            if let Some(owner) = receiving_owner(unsafe { event.as_ref() }) {
                let _ = app.emit_to(
                    tauri::EventTarget::Webview { label: "main".into() },
                    "browser:native-input",
                    json!({ "taskId": owner, "at": millis() }),
                );
            }
            event.as_ptr()
        });
        let mask = NSEventMask::LeftMouseDown
            | NSEventMask::RightMouseDown
            | NSEventMask::OtherMouseDown
            | NSEventMask::KeyDown
            | NSEventMask::ScrollWheel;
        *monitor.borrow_mut() =
            unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &seen) };
    });
}

fn millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn receiving_owner(event: &NSEvent) -> Option<String> {
    SURFACES.with(|surfaces| {
        let surfaces = surfaces.try_borrow().ok()?;
        surfaces
            .values()
            .find(|surface| receives(surface, event))
            .map(|surface| surface.owner.clone())
    })
}

fn receives(surface: &Surface, event: &NSEvent) -> bool {
    let view: &NSView = &surface.wk;
    let Some(window) = view.window() else {
        return false;
    };
    if view.isHiddenOrHasHiddenAncestor() || event.windowNumber() != window.windowNumber() {
        return false;
    }
    if event.r#type() == NSEventType::KeyDown {
        return window.firstResponder().is_some_and(|responder| {
            let responder: &AnyObject = &responder;
            responder
                .downcast_ref::<NSView>()
                .is_some_and(|responder| responder.isDescendantOf(view))
        });
    }
    let point = view.convertPoint_fromView(event.locationInWindow(), None);
    let bounds = view.bounds();
    point.x >= 0.0 && point.y >= 0.0 && point.x <= bounds.size.width && point.y <= bounds.size.height
}
