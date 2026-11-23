//! Which addresses a card page may reach, and the WebKit storage each card gets.
use std::cell::RefCell;

use block2::RcBlock;
use objc2::{rc::Retained, MainThreadMarker};
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore};

const RULES_IDENTIFIER: &str = "memcode-card-address-policy-1";
/// Same rule as `browserURL` and the Playwright route: plaintext only to this machine.
/// WebKit's content-blocker patterns have no alternation, so each local host gets a rule.
const RULES: &str = r#"[
  {"trigger": {"url-filter": "^http:"}, "action": {"type": "block"}},
  {"trigger": {"url-filter": "^http://localhost[:/]"}, "action": {"type": "ignore-previous-rules"}},
  {"trigger": {"url-filter": "^http://127\\.0\\.0\\.1[:/]"}, "action": {"type": "ignore-previous-rules"}},
  {"trigger": {"url-filter": "^http://\\[::1\\][:/]"}, "action": {"type": "ignore-previous-rules"}}
]"#;
const PRIVILEGED_HOSTS: [&str; 3] = ["tauri.localhost", "ipc.localhost", "asset.localhost"];
const LOCAL_HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "[::1]", "::1"];

thread_local! {
    static COMPILED: RefCell<Option<Retained<WKContentRuleList>>> = const { RefCell::new(None) };
}

/// Every navigation, main frame or subframe. Frames also load `about:` and in-page
/// `blob:`/`data:` documents, which never leave the page's own origin.
pub(super) fn navigable(value: &str) -> bool {
    if value.is_empty()
        || value.starts_with("about:blank")
        || value == "about:srcdoc"
        || value.starts_with("blob:")
        || value.starts_with("data:")
    {
        return true;
    }
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    let local_plaintext = url.scheme() == "http" && LOCAL_HOSTS.contains(&host);
    !PRIVILEGED_HOSTS.contains(&host)
        && url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https" || local_plaintext)
}

/// The runtime names a card's profile `worker-<sha256 hex>`; WebKit wants 16 bytes.
pub(super) fn store_identifier(profile: &str) -> Result<[u8; 16], String> {
    let invalid = || "Invalid browser profile".to_string();
    let hex = profile.strip_prefix("worker-").ok_or_else(invalid)?;
    if hex.len() < 32 || hex.len() > 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let mut identifier = [0u8; 16];
    for (index, byte) in identifier.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).map_err(|_| invalid())?;
    }
    Ok(identifier)
}

/// Compiles the content rules once, then hands them to `then` on the main thread.
pub(super) fn with_rules(then: impl FnOnce(Result<Retained<WKContentRuleList>, String>) + 'static) {
    if let Some(rules) = COMPILED.with(|compiled| compiled.borrow().clone()) {
        return then(Ok(rules));
    }
    let Some(store) = MainThreadMarker::new().and_then(|mtm| unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
        return then(Err("WebKit content rules are unavailable".into()));
    };
    let then = RefCell::new(Some(then));
    let compiled = RcBlock::new(move |list: *mut WKContentRuleList, error: *mut NSError| {
        let Some(then) = then.borrow_mut().take() else {
            return;
        };
        if list.is_null() {
            let reason = if error.is_null() {
                "unknown error".to_string()
            } else {
                unsafe { &*error }.localizedDescription().to_string()
            };
            return then(Err(format!("Could not prepare the browser address policy: {reason}")));
        }
        let rules = unsafe { Retained::retain(list) }.expect("compiled rule list");
        COMPILED.with(|compiled| *compiled.borrow_mut() = Some(rules.clone()));
        then(Ok(rules));
    });
    unsafe {
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&NSString::from_str(RULES_IDENTIFIER)),
            Some(&NSString::from_str(RULES)),
            Some(&compiled),
        )
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_reach_https_and_this_machine_but_not_remote_plaintext_or_the_app() {
        assert!(navigable("https://www.google.com/search?q=x"));
        assert!(navigable("http://localhost:5173/"));
        assert!(navigable("http://127.0.0.1:8080/x"));
        assert!(navigable("http://[::1]:3000/"));
        assert!(navigable("about:blank"));
        assert!(navigable("about:srcdoc"));
        assert!(!navigable("http://example.com/"));
        assert!(!navigable("http://localhost.:3000/"));
        assert!(!navigable("ftp://example.com/"));
        assert!(!navigable("file:///etc/hosts"));
        assert!(!navigable("tauri://localhost/index.html"));
        assert!(!navigable("https://tauri.localhost/"));
        assert!(!navigable("https://user:secret@example.com/"));
    }

    #[test]
    fn a_card_profile_becomes_a_stable_webkit_store_identifier() {
        let profile = "worker-00112233445566778899aabbccddeeff0123456789";
        let identifier = store_identifier(profile).unwrap();
        assert_eq!(identifier[0], 0x00);
        assert_eq!(identifier[15], 0xff);
        assert_eq!(identifier, store_identifier(profile).unwrap());
        assert!(store_identifier("worker-short").is_err());
        assert!(store_identifier("../worker-00112233445566778899aabbccddeeff").is_err());
        assert!(store_identifier("worker-zz112233445566778899aabbccddeeff").is_err());
    }
}
