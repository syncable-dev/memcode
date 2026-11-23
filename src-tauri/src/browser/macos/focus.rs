//! Worker input must not take the human's keyboard. WebKit makes a visible card the
//! window's first responder when a click lands in a text field, a moment after the
//! click. This hands the keyboard back to whatever had it, unless the human has
//! clicked somewhere since.
use std::{
    cell::RefCell,
    time::{Duration, Instant},
};

use objc2::{rc::Retained, runtime::AnyObject, Message};
use objc2_app_kit::{NSResponder, NSView};
use objc2_web_kit::WKWebView;

/// WebKit moves focus within a few hundred milliseconds of the click.
const WATCH: Duration = Duration::from_millis(1500);

struct Borrowed {
    card: Retained<WKWebView>,
    owner: Retained<NSResponder>,
    since: Instant,
}

thread_local! {
    static BORROWED: RefCell<Option<Borrowed>> = const { RefCell::new(None) };
}

fn within(responder: &NSResponder, card: &WKWebView) -> bool {
    let responder: &AnyObject = responder;
    responder
        .downcast_ref::<NSView>()
        .is_some_and(|view| view.isDescendantOf(card))
}

/// Before worker input: note who has the keyboard if it is not this card.
pub(super) fn remember(card: &WKWebView) {
    let Some(owner) = card.window().and_then(|window| window.firstResponder()) else {
        return;
    };
    if within(&owner, card) {
        return;
    }
    let card = card.retain();
    BORROWED.with(|borrowed| {
        *borrowed.borrow_mut() = Some(Borrowed { card, owner, since: Instant::now() })
    });
}

/// Runs on every browser call: returns the keyboard if the card took it.
pub(super) fn give_back() {
    BORROWED.with(|borrowed| {
        let Ok(mut slot) = borrowed.try_borrow_mut() else {
            return;
        };
        let Some(pending) = slot.as_ref() else {
            return;
        };
        let Some(window) = pending.card.window() else {
            *slot = None;
            return;
        };
        if window.firstResponder().is_some_and(|now| within(&now, &pending.card)) {
            window.makeFirstResponder(Some(&pending.owner));
            *slot = None;
        } else if pending.since.elapsed() > WATCH {
            *slot = None;
        }
    });
}

/// The human clicked: wherever focus goes now is their choice.
pub(super) fn forget() {
    BORROWED.with(|borrowed| {
        if let Ok(mut slot) = borrowed.try_borrow_mut() {
            *slot = None;
        }
    });
}
