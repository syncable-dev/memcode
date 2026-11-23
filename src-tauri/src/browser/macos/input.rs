//! The worker's mouse, wheel and keyboard input, handed straight to a card's WKWebView.
//! WebKit delivers these to the page as trusted events at the given CSS point.
use objc2::{msg_send, rc::Retained, MainThreadMarker};
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSScreen, NSView};
use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{CGEvent, CGScrollEventUnit};
use objc2_foundation::{NSNotFound, NSPoint, NSProcessInfo, NSRange, NSString};
use objc2_web_kit::WKWebView;
use serde_json::Value;

const MAX_SCROLL: f64 = 4000.0;

struct Key {
    code: u16,
    characters: &'static str,
    ignoring: &'static str,
    flags: NSEventModifierFlags,
}

pub(super) fn deliver(wk: &WKWebView, input: &Value) -> Result<(), String> {
    let point = || -> Result<NSPoint, String> {
        let x = input["x"].as_f64().ok_or("Missing x")?;
        let y = input["y"].as_f64().ok_or("Missing y")?;
        Ok(window_point(wk, x, y))
    };
    match input["kind"].as_str() {
        Some("click") => click(wk, point()?)?,
        Some("move") => {
            let moved = mouse(wk, NSEventType::MouseMoved, point()?, 0)?;
            wk.mouseMoved(&moved)
        }
        Some("wheel") => {
            let delta = input["deltaY"].as_f64().unwrap_or(600.0).clamp(-MAX_SCROLL, MAX_SCROLL);
            wheel(wk, point()?, delta)?
        }
        Some("key") => press(wk, input["key"].as_str().ok_or("Missing key")?)?,
        Some("text") => insert_text(wk, input["text"].as_str().ok_or("Missing text")?),
        _ => return Err("Unknown browser input".into()),
    }
    Ok(())
}

/// A CSS point in the page, as AppKit window coordinates. WKWebView is flipped.
fn window_point(wk: &WKWebView, x: f64, y: f64) -> NSPoint {
    let view: &NSView = wk;
    let local = if view.isFlipped() {
        NSPoint::new(x, y)
    } else {
        NSPoint::new(x, view.bounds().size.height - y)
    };
    view.convertPoint_toView(local, None)
}

fn window_number(wk: &WKWebView) -> Result<isize, String> {
    Ok(wk.window().ok_or("The card browser is not in a window")?.windowNumber())
}

fn uptime() -> f64 {
    NSProcessInfo::processInfo().systemUptime()
}

fn mouse(wk: &WKWebView, kind: NSEventType, at: NSPoint, clicks: isize) -> Result<Retained<NSEvent>, String> {
    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        kind,
        at,
        NSEventModifierFlags::empty(),
        uptime(),
        window_number(wk)?,
        None,
        0,
        clicks,
        1.0,
    )
    .ok_or_else(|| "Could not create a mouse event".into())
}

fn click(wk: &WKWebView, at: NSPoint) -> Result<(), String> {
    let (moved, down, up) = (
        mouse(wk, NSEventType::MouseMoved, at, 0)?,
        mouse(wk, NSEventType::LeftMouseDown, at, 1)?,
        mouse(wk, NSEventType::LeftMouseUp, at, 1)?,
    );
    wk.mouseMoved(&moved);
    wk.mouseDown(&down);
    wk.mouseUp(&up);
    Ok(())
}

/// With no window attached, NSEvent reports a CG event's flipped location as its
/// window location, which is what WebKit hit-tests against.
fn wheel(wk: &WKWebView, at: NSPoint, delta_y: f64) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("Browser input must run on the main thread")?;
    let primary = NSScreen::screens(mtm).firstObject().ok_or("No screen")?.frame();
    let event = CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Pixel, 1, -delta_y.round() as i32, 0, 0)
        .ok_or("Could not create a scroll event")?;
    CGEvent::set_location(Some(&event), CGPoint { x: at.x, y: primary.size.height - at.y });
    let event = NSEvent::eventWithCGEvent(&event).ok_or("Could not create a scroll event")?;
    wk.scrollWheel(&event);
    Ok(())
}

fn key(name: &str) -> Option<Key> {
    let plain = NSEventModifierFlags::empty();
    let function = NSEventModifierFlags::Function;
    let arrow = NSEventModifierFlags::Function | NSEventModifierFlags::NumericPad;
    let key = |code, characters, ignoring, flags| Key { code, characters, ignoring, flags };
    Some(match name {
        "Enter" => key(36, "\r", "\r", plain),
        "Tab" => key(48, "\t", "\t", plain),
        "Shift+Tab" => key(48, "\u{19}", "\u{19}", NSEventModifierFlags::Shift),
        "Escape" => key(53, "\u{1b}", "\u{1b}", plain),
        "Backspace" => key(51, "\u{7f}", "\u{7f}", plain),
        "Delete" => key(117, "\u{f728}", "\u{f728}", function),
        "ArrowLeft" => key(123, "\u{f702}", "\u{f702}", arrow),
        "ArrowRight" => key(124, "\u{f703}", "\u{f703}", arrow),
        "ArrowUp" => key(126, "\u{f700}", "\u{f700}", arrow),
        "ArrowDown" => key(125, "\u{f701}", "\u{f701}", arrow),
        "Home" => key(115, "\u{f729}", "\u{f729}", function),
        "End" => key(119, "\u{f72b}", "\u{f72b}", function),
        "PageUp" => key(116, "\u{f72c}", "\u{f72c}", function),
        "PageDown" => key(121, "\u{f72d}", "\u{f72d}", function),
        "Space" => key(49, " ", " ", plain),
        "Control+A" => key(0, "\u{1}", "a", NSEventModifierFlags::Control),
        "Meta+A" => key(0, "a", "a", NSEventModifierFlags::Command),
        _ => return None,
    })
}

fn press(wk: &WKWebView, name: &str) -> Result<(), String> {
    let key = key(name).ok_or("A supported key is required.")?;
    let window = window_number(wk)?;
    let event = |kind| {
        NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind,
            NSPoint::new(0.0, 0.0),
            key.flags,
            uptime(),
            window,
            None,
            &NSString::from_str(key.characters),
            &NSString::from_str(key.ignoring),
            false,
            key.code,
        )
        .ok_or_else(|| "Could not create a key event".to_string())
    };
    let down = event(NSEventType::KeyDown)?;
    // Command shortcuts are key equivalents in AppKit, not ordinary key presses.
    if key.flags.contains(NSEventModifierFlags::Command) {
        wk.performKeyEquivalent(&down);
    } else {
        wk.keyDown(&down);
    }
    let up = event(NSEventType::KeyUp)?;
    wk.keyUp(&up);
    Ok(())
}

/// Text input as the input method would deliver it: one trusted `input` event.
fn insert_text(wk: &WKWebView, text: &str) {
    let text = NSString::from_str(text);
    let range = NSRange::new(NSNotFound as usize, 0);
    let _: () = unsafe { msg_send![wk, insertText: &*text, replacementRange: range] };
}
