//! MemCode's own page scripts. They run in a separate WebKit content world: they share
//! the page's DOM but none of its JavaScript, so a page can neither see nor patch them.
use std::cell::RefCell;

use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::{WKContentWorld, WKWebView};
use serde_json::{json, Value};

use super::{surface::{owned, SURFACES}, Reply};

const WORLD: &str = "memcode";
const MAX_SCRIPT: usize = 512 * 1024;

thread_local! {
    /// WebKit drops a content world's JavaScript state once the API object is
    /// released, so the driver's per-page state lives only as long as this does.
    static MEMCODE_WORLD: RefCell<Option<Retained<WKContentWorld>>> = const { RefCell::new(None) };
}

fn memcode_world(mtm: MainThreadMarker) -> Retained<WKContentWorld> {
    MEMCODE_WORLD.with(|world| {
        world
            .borrow_mut()
            .get_or_insert_with(|| unsafe { WKContentWorld::worldWithName(&NSString::from_str(WORLD), mtm) })
            .clone()
    })
}

/// Runs an async function body; it must return a string (the runtime sends JSON).
pub(super) fn evaluate(input: &Value, reply: Reply) {
    let prepared = (|| -> Result<(Retained<WKWebView>, Retained<WKContentWorld>, String), String> {
        let body = input["script"].as_str().ok_or("Missing browser script")?;
        if body.len() > MAX_SCRIPT {
            return Err("Browser script is too large".into());
        }
        let wk = SURFACES.with(|surfaces| -> Result<_, String> {
            Ok(owned(&mut surfaces.borrow_mut(), input)?.wk.clone())
        })?;
        let mtm = MainThreadMarker::new().ok_or("Browser scripts must run on the main thread")?;
        Ok((wk, memcode_world(mtm), body.to_owned()))
    })();
    let (wk, world, body) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            let _ = reply.send(Err(error));
            return;
        }
    };
    let reply = RefCell::new(Some(reply));
    let finished = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
        let Some(reply) = reply.borrow_mut().take() else {
            return;
        };
        let _ = reply.send(answer(result, error));
    });
    unsafe {
        wk.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
            &NSString::from_str(&body),
            None,
            None,
            &world,
            Some(&finished),
        )
    };
}

fn answer(result: *mut AnyObject, error: *mut NSError) -> Result<Value, String> {
    if !error.is_null() {
        return Err(unsafe { &*error }.localizedDescription().to_string());
    }
    if result.is_null() {
        return Ok(Value::Null);
    }
    let result = unsafe { &*result };
    result
        .downcast_ref::<NSString>()
        .map(|text| json!(text.to_string()))
        .ok_or_else(|| "Browser scripts must return text".into())
}
