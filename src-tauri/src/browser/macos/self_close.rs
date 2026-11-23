//! A page's `window.close()`. wry's UI delegate has no `webViewDidClose:`, so WebKit's
//! request to close a page went unheard and the page stayed open as a tab. This delegate
//! sits in front of wry's: it notes the request and passes every other UI delegate
//! message to wry's unchanged, so popups, uploads and the camera and microphone denial
//! work as before.
use std::cell::Cell;

use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool, NSObject, Sel},
    AllocAnyThread, DefinedClass,
};
use objc2_web_kit::WKWebView;

pub(super) struct Ivars {
    wry: Option<Retained<AnyObject>>,
    requested: Cell<bool>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "MemCodeSelfCloseListener"]
    #[ivars = Ivars]
    pub(super) struct SelfCloseListener;

    impl SelfCloseListener {
        #[unsafe(method(webViewDidClose:))]
        fn web_view_did_close(&self, _page: &AnyObject) {
            self.ivars().requested.set(true);
        }

        /// WebKit asks once, when the delegate is set, which messages it may send.
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> Bool {
            let own: Bool = unsafe { msg_send![super(self), respondsToSelector: selector] };
            Bool::new(own.as_bool() || self.wry_handles(selector))
        }

        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target_for_selector(&self, selector: Sel) -> *mut AnyObject {
            match &self.ivars().wry {
                Some(wry) if self.wry_handles(selector) => Retained::as_ptr(wry).cast_mut(),
                _ => std::ptr::null_mut(),
            }
        }
    }
);

impl SelfCloseListener {
    fn wry_handles(&self, selector: Sel) -> bool {
        self.ivars().wry.as_deref().is_some_and(|wry| {
            let answer: Bool = unsafe { msg_send![wry, respondsToSelector: selector] };
            answer.as_bool()
        })
    }

    fn new(wry: Option<Retained<AnyObject>>) -> Retained<Self> {
        let listener = Self::alloc().set_ivars(Ivars { wry, requested: Cell::new(false) });
        unsafe { msg_send![super(listener), init] }
    }

    /// Puts a listener in front of the view's UI delegate. The caller keeps it alive:
    /// WebKit holds UI delegates weakly.
    pub(super) fn install(wk: &WKWebView) -> Retained<Self> {
        let wry: Option<Retained<AnyObject>> = unsafe { msg_send![wk, UIDelegate] };
        let listener = Self::new(wry);
        let _: () = unsafe { msg_send![wk, setUIDelegate: &*listener] };
        listener
    }

    /// The page asked to close itself.
    pub(super) fn requested(&self) -> bool {
        self.ivars().requested.get()
    }
}

#[cfg(test)]
mod tests {
    use std::{ffi::CStr, rc::Rc};

    use block2::{Block, RcBlock};
    use objc2::{sel, ClassType};

    use super::*;

    const CAMERA: isize = 0;
    const DENY: isize = 2;
    const MEDIA_PERMISSION: &CStr =
        c"webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:";

    // Stands in for wry's delegate: denies camera and microphone, as MemCode's handler does.
    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "MemCodeTestWryUIDelegate"]
        struct FakeWryDelegate;

        impl FakeWryDelegate {
            #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
            fn request_media_capture_permission(
                &self,
                _page: &AnyObject,
                _origin: &AnyObject,
                _frame: &AnyObject,
                _kind: isize,
                decide: &Block<dyn Fn(isize)>,
            ) {
                decide.call((DENY,));
            }
        }
    );

    fn listener() -> Retained<SelfCloseListener> {
        let wry: Retained<AnyObject> = unsafe { msg_send![FakeWryDelegate::class(), new] };
        SelfCloseListener::new(Some(wry))
    }

    fn answers(delegate: &AnyObject, selector: Sel) -> bool {
        let answer: Bool = unsafe { msg_send![delegate, respondsToSelector: selector] };
        answer.as_bool()
    }

    /// Sends the request the way WebKit does. objc2's debug check would refuse it,
    /// because the listener's own class lacks the method; forwarding is what is tested.
    fn ask_for_camera(delegate: &AnyObject, decide: &Block<dyn Fn(isize)>) {
        type Send = unsafe extern "C-unwind" fn(
            &AnyObject,
            Sel,
            &AnyObject,
            &AnyObject,
            &AnyObject,
            isize,
            &Block<dyn Fn(isize)>,
        );
        let send: Send = unsafe { std::mem::transmute(objc2::ffi::objc_msgSend as *const ()) };
        let stand_in = NSObject::new();
        let selector = Sel::register(MEDIA_PERMISSION);
        unsafe { send(delegate, selector, &stand_in, &stand_in, &stand_in, CAMERA, decide) };
    }

    #[test]
    fn notes_a_page_closing_itself() {
        let listener = listener();
        assert!(!listener.requested());
        assert!(answers(&listener, sel!(webViewDidClose:)));

        let page = NSObject::new();
        let _: () = unsafe { msg_send![&*listener, webViewDidClose: &*page] };

        assert!(listener.requested());
    }

    #[test]
    fn camera_requests_still_reach_wrys_handler() {
        let listener = listener();
        assert!(answers(&listener, Sel::register(MEDIA_PERMISSION)));

        let decided = Rc::new(Cell::new(None));
        let record = decided.clone();
        let decide = RcBlock::new(move |decision: isize| record.set(Some(decision)));
        ask_for_camera(&listener, &decide);

        assert_eq!(decided.get(), Some(DENY));
    }

    #[test]
    fn claims_nothing_wry_does_not_handle() {
        let alerts = sel!(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:);
        assert!(!answers(&listener(), alerts));
    }
}
