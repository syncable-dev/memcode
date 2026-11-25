//! Host-only beta credentials. Refresh secrets stay in the OS credential store;
//! only the short-lived signed access proof is written to a private app-data file.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

const SERVICE: &str = "dev.memcode.beta";
const LIMIT: usize = 16_384;
static SERIAL: Mutex<()> = Mutex::new(());

struct Paths {
    dir: PathBuf,
    user: String,
}
impl Paths {
    fn marker(&self) -> PathBuf {
        self.dir.join("configured.json")
    }
    fn access(&self) -> PathBuf {
        self.dir.join("access.jwt")
    }
}
pub(crate) fn namespace(profile: &Path) -> String {
    let text = profile.to_string_lossy();
    #[cfg(windows)]
    let text = text.replace('/', "\\").to_lowercase();
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn paths(app: &AppHandle) -> Result<Paths, String> {
    let profile = crate::native::profile_dir(app)?;
    let user = namespace(&profile);
    let root = app
        .path()
        .app_config_dir()
        .map_err(|_| "Private app storage is unavailable")?
        .join("beta");
    private_dir(&root)?;
    let dir = root.join(&user);
    private_dir(&dir)?;
    Ok(Paths { dir, user })
}
fn ordinary(path: &Path, directory: bool) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta)
            if !redirected(&meta)
                && (if directory {
                    meta.is_dir()
                } else {
                    meta.is_file()
                }) =>
        {
            Ok(())
        }
        Ok(_) => Err("Private beta storage has an unsupported file type".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Private beta storage could not be inspected".into()),
    }
}
fn redirected(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}
fn private_dir(path: &Path) -> Result<(), String> {
    ordinary(path, true)?;
    fs::create_dir_all(path).map_err(|_| "Private beta storage could not be created")?;
    protect(path, true)
}
#[cfg(unix)]
fn protect(path: &Path, directory: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
    )
    .map_err(|_| "Private beta permissions could not be applied".into())
}
#[cfg(windows)]
fn protect(path: &Path, directory: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    static SID: OnceLock<Result<String, String>> = OnceLock::new();
    let sid = SID
        .get_or_init(|| {
            let output = std::process::Command::new(system_tool("whoami.exe")?)
                .args(["/user", "/fo", "csv", "/nh"])
                .creation_flags(0x08000000)
                .output()
                .map_err(|_| "The Windows account could not be verified".to_string())?;
            if !output.status.success() {
                return Err("The Windows account could not be verified".into());
            }
            let text = String::from_utf8_lossy(&output.stdout);
            let sid = text
                .split([',', '"', '\r', '\n'])
                .find(|part| {
                    part.starts_with("S-1-")
                        && part
                            .bytes()
                            .all(|c| c.is_ascii_digit() || c == b'S' || c == b'-')
                })
                .ok_or("The Windows account could not be verified")?;
            Ok(sid.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)?;
    let grant = format!("*{sid}:{}F", if directory { "(OI)(CI)" } else { "" });
    // Drop pre-existing explicit grants before removing inherited access.
    let reset = std::process::Command::new(system_tool("icacls.exe")?)
        .arg(path)
        .arg("/reset")
        .creation_flags(0x08000000)
        .output()
        .map_err(|_| "Private beta permissions could not be applied")?;
    if !reset.status.success() {
        return Err("Private beta permissions could not be applied".into());
    }
    let output = std::process::Command::new(system_tool("icacls.exe")?)
        .arg(path)
        .args(["/inheritance:r", "/grant:r", &grant])
        .creation_flags(0x08000000)
        .output()
        .map_err(|_| "Private beta permissions could not be applied")?;
    if !output.status.success() {
        return Err("Private beta permissions could not be applied".into());
    }
    Ok(())
}
#[cfg(windows)]
fn system_tool(name: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(
        std::env::var_os("SystemRoot").ok_or("Windows system tools are unavailable")?,
    );
    if !root.is_absolute() {
        return Err("Windows system tools are unavailable".into());
    }
    Ok(root.join("System32").join(name))
}
#[cfg(not(any(unix, windows)))]
fn protect(_: &Path, _: bool) -> Result<(), String> {
    Err("Protected beta storage is unsupported on this platform".into())
}

fn atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    ordinary(path, false)?;
    let name = format!(
        ".beta-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let temporary = path
        .parent()
        .ok_or("Private beta storage is unavailable")?
        .join(name);
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "The private beta file could not be created")?;
        protect(&temporary, false)?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "The private beta file could not be saved")?;
        drop(file);
        fs::rename(&temporary, path).map_err(|_| "The private beta file could not be replaced")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
fn remove(path: &Path) -> Result<(), String> {
    ordinary(path, false)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("The private beta file could not be removed".into()),
    }
}
fn access_token(value: &Value) -> Result<&str, String> {
    let token = value.as_str().ok_or("Missing beta access proof")?;
    if token.len() > LIMIT
        || token.split('.').count() != 3
        || token.split('.').any(str::is_empty)
        || !token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
    {
        return Err("Invalid beta access proof".into());
    }
    Ok(token)
}
trait Credentials {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, value: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}
struct OsCredentials(String);
impl OsCredentials {
    fn entry(&self) -> Result<keyring::v1::Entry, String> {
        keyring::v1::Entry::new(SERVICE, &self.0)
            .map_err(|_| "OS-protected beta credential storage is unavailable".into())
    }
}
impl Credentials for OsCredentials {
    fn read(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::v1::Error::NoEntry) => Ok(None),
            Err(_) => Err("Unlock the OS credential store to reconnect MemCode beta".into()),
        }
    }
    fn write(&self, value: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};
            // keyring's legacy set_password first decrypts the old password.
            // Rotation already has the replacement: update only its value in
            // the same User/login Keychain, preserving the item's existing ACL.
            let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
                .map_err(|_| "OS-protected beta credential storage is unavailable")?;
            macos_update_password(&keychain, SERVICE, &self.0, value).map_err(|_| {
                "The beta credential could not be saved in the OS credential store".into()
            })
        }
        #[cfg(not(target_os = "macos"))]
        self.entry()?
            .set_password(value)
            .map_err(|_| "The beta credential could not be saved in the OS credential store".into())
    }
    fn clear(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
            Err(_) => {
                Err("The beta credential could not be removed from the OS credential store".into())
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_update_password(
    keychain: &security_framework::os::macos::keychain::SecKeychain,
    service: &str,
    user: &str,
    value: &str,
) -> security_framework::base::Result<()> {
    use core_foundation::data::CFData;
    use security_framework::item::{
        update_item, ItemClass, ItemSearchOptions, ItemUpdateOptions, ItemUpdateValue,
    };
    let mut query = ItemSearchOptions::new();
    query
        .keychains(std::slice::from_ref(keychain))
        .class(ItemClass::generic_password())
        .service(service)
        .account(user);
    let mut replacement = ItemUpdateOptions::new();
    replacement.set_value(ItemUpdateValue::Data(CFData::from_buffer(value.as_bytes())));
    match update_item(&query, &replacement) {
        Ok(()) => Ok(()),
        // Only a genuinely absent item may be created. Never delete/recreate
        // an existing credential, loosen its ACL, or fall back after denial.
        Err(error) if error.code() == -25300 => {
            keychain.add_generic_password(service, user, value.as_bytes())
        }
        Err(error) => Err(error),
    }
}
fn stored(paths: &Paths, credentials: &impl Credentials) -> Result<Value, String> {
    ordinary(&paths.marker(), false)?;
    let configured = paths.marker().exists();
    let mut result = json!({ "configured": configured, "signedOut": signed_out(paths)?, "credentials": null, "accessFile": paths.access() });
    match credentials.read() {
        Ok(Some(secret)) if secret.len() <= LIMIT => match serde_json::from_str::<Value>(&secret) {
            Ok(value) if value.is_object() => {
                result["configured"] = json!(true);
                result["credentials"] = value;
            }
            _ => {
                result["storageError"] =
                    json!("The protected beta credential is invalid; reconnect beta access")
            }
        },
        Ok(None) => {
            if configured && result["signedOut"] != true {
                result["storageError"] =
                    json!("The protected beta credential is missing; reconnect beta access");
            }
        }
        _ => {
            result["storageError"] =
                json!("Unlock the OS credential store to reconnect MemCode beta")
        }
    }
    ordinary(&paths.access(), false)?;
    if result["signedOut"] != true {
        if let Ok(meta) = fs::metadata(paths.access()) {
            if meta.len() <= LIMIT as u64 {
                if let Ok(token) = fs::read_to_string(paths.access()) {
                    if access_token(&json!(&token)).is_ok() {
                        result["accessToken"] = json!(token);
                    }
                }
            }
        }
    }
    Ok(result)
}
fn signed_out(paths: &Paths) -> Result<bool, String> {
    ordinary(&paths.marker(), false)?;
    if !paths.marker().exists() {
        return Ok(false);
    }
    if fs::metadata(paths.marker())
        .map_err(|_| "Private beta status is unavailable")?
        .len()
        > 512
    {
        return Err("Private beta status is invalid".into());
    }
    let marker: Value = serde_json::from_slice(
        &fs::read(paths.marker()).map_err(|_| "Private beta status is unavailable")?,
    )
    .map_err(|_| "Private beta status is invalid")?;
    Ok(marker["signedOut"].as_bool().unwrap_or(false))
}
fn marker(paths: &Paths, signed_out: bool) -> Result<(), String> {
    atomic(
        &paths.marker(),
        &serde_json::to_vec(&json!({"configured":true,"version":1,"signedOut":signed_out}))
            .unwrap(),
    )
}
fn operate(
    paths: Paths,
    credentials: &impl Credentials,
    method: &str,
    input: Value,
) -> Result<Value, String> {
    match method {
        "beta_store_read" => stored(&paths, credentials),
        "beta_store_write" => {
            let value = input
                .get("credentials")
                .filter(|v| v.is_object() && v.as_object().is_some_and(|o| !o.is_empty()))
                .ok_or("Missing beta credentials")?;
            let secret = serde_json::to_string(value).map_err(|_| "Invalid beta credentials")?;
            if secret.len() > LIMIT {
                return Err("Beta credentials exceed the storage limit".into());
            }
            // Marker first: a failed OS write must never silently restore normal quota billing.
            let pending_sign_out = value["signedOut"].as_bool().unwrap_or(false);
            marker(&paths, signed_out(&paths)? || pending_sign_out)?;
            credentials.write(&secret)?;
            marker(&paths, pending_sign_out)?;
            Ok(json!({ "configured": true }))
        }
        "beta_store_clear" | "beta_store_forget_session" => {
            marker(&paths, true)?;
            remove(&paths.access())?;
            credentials.clear()?;
            if method == "beta_store_clear" {
                remove(&paths.marker())?;
            }
            Ok(
                json!({ "configured": method != "beta_store_clear", "signedOut": method != "beta_store_clear" }),
            )
        }
        "beta_store_mark_signed_out" => {
            marker(&paths, true)?;
            remove(&paths.access())?;
            Ok(json!({"configured":true,"signedOut":true}))
        }
        "beta_access_write" => {
            if signed_out(&paths)? {
                return Err("Reconnect beta access before writing its access proof".into());
            }
            let token = access_token(&input["accessToken"])?;
            atomic(&paths.access(), token.as_bytes())?;
            Ok(json!({ "accessFile": paths.access() }))
        }
        "beta_access_clear" => {
            remove(&paths.access())?;
            Ok(json!({}))
        }
        _ => Err("Unknown beta storage operation".into()),
    }
}
pub async fn call(app: AppHandle, method: &str, input: Value) -> Result<Value, String> {
    let method = method.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SERIAL.lock().map_err(|_| "Private beta storage is busy")?;
        let paths = paths(&app)?;
        let credentials = OsCredentials(paths.user.clone());
        operate(paths, &credentials, &method, input)
    })
    .await
    .map_err(|_| "Private beta storage could not complete".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    struct Fake {
        value: RefCell<Option<String>>,
        fail: bool,
    }
    impl Credentials for Fake {
        fn read(&self) -> Result<Option<String>, String> {
            if self.fail {
                Err("secret backend failure".into())
            } else {
                Ok(self.value.borrow().clone())
            }
        }
        fn write(&self, value: &str) -> Result<(), String> {
            if self.fail {
                Err("OS store unavailable".into())
            } else {
                *self.value.borrow_mut() = Some(value.into());
                Ok(())
            }
        }
        fn clear(&self) -> Result<(), String> {
            *self.value.borrow_mut() = None;
            Ok(())
        }
    }
    fn fixture() -> Paths {
        static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "memcode-beta-store-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        private_dir(&dir).unwrap();
        Paths {
            dir,
            user: "synthetic-storage-test".into(),
        }
    }
    fn copy(paths: &Paths) -> Paths {
        Paths {
            dir: paths.dir.clone(),
            user: paths.user.clone(),
        }
    }
    #[test]
    fn beta_store_keeps_refresh_credentials_out_of_files_and_clears_marker_and_access() {
        let paths = fixture();
        let backend = Fake {
            value: RefCell::new(None),
            fail: false,
        };
        operate(
            copy(&paths),
            &backend,
            "beta_store_write",
            json!({"credentials":{"refreshToken":"synthetic-secret-only-in-memory"}}),
        )
        .unwrap();
        assert!(!fs::read_to_string(paths.marker())
            .unwrap()
            .contains("synthetic-secret"));
        operate(
            copy(&paths),
            &backend,
            "beta_access_write",
            json!({"accessToken":"synthetic.signed.proof"}),
        )
        .unwrap();
        let value = stored(&paths, &backend).unwrap();
        assert_eq!(value["configured"], true);
        assert_eq!(value["accessToken"], "synthetic.signed.proof");
        assert_eq!(
            value["credentials"]["refreshToken"],
            "synthetic-secret-only-in-memory"
        );
        operate(copy(&paths), &backend, "beta_store_clear", Value::Null).unwrap();
        assert!(!paths.marker().exists());
        assert!(!paths.access().exists());
        assert_eq!(stored(&paths, &backend).unwrap()["configured"], false);
        fs::remove_dir(paths.dir).unwrap();
    }
    #[test]
    fn beta_store_failed_protected_write_stays_configured_and_errors_are_redacted() {
        let paths = fixture();
        let backend = Fake {
            value: RefCell::new(None),
            fail: true,
        };
        assert!(operate(
            copy(&paths),
            &backend,
            "beta_store_write",
            json!({"credentials":{"refreshToken":"synthetic-secret"}})
        )
        .is_err());
        let value = stored(&paths, &backend).unwrap();
        assert_eq!(value["configured"], true);
        assert!(value["credentials"].is_null());
        assert!(!value.to_string().contains("secret backend failure"));
        assert!(!value.to_string().contains("synthetic-secret"));
        fs::remove_file(paths.marker()).unwrap();
        fs::remove_dir(paths.dir).unwrap();
    }
    #[test]
    fn beta_store_namespace_and_proof_input_are_bounded() {
        assert_ne!(
            namespace(Path::new("/profile/a")),
            namespace(Path::new("/profile/b"))
        );
        for value in ["", "not a JWT", "a.b.c\n", "../some/file"] {
            assert!(access_token(&json!(value)).is_err());
        }
        assert!(access_token(&json!("a.b.c")).is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_rotation_updates_in_place_without_decrypting_or_changing_acl() {
        // Never create a test Keychain on a user's Mac. This mandatory release
        // gate runs only on GitHub's disposable native macOS runner.
        if std::env::var("MEMCODE_MAC_KEYCHAIN_TEST").as_deref() != Ok("1")
            || std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
        {
            return;
        }
        use core_foundation::{base::TCFType, data::CFData};
        use security_framework::{
            item::{ItemClass, ItemSearchOptions, Reference, SearchResult},
            os::macos::keychain::{CreateOptions, SecKeychain},
        };
        use std::{ffi::c_void, process::Command};
        extern "C" {
            fn SecKeychainItemCreatePersistentReference(
                item: *const c_void,
                reference: *mut *const c_void,
            ) -> i32;
        }
        fn security(args: &[&str]) -> String {
            let output = Command::new("/usr/bin/security")
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "Synthetic Keychain operation failed"
            );
            String::from_utf8(output.stdout).unwrap()
        }
        fn listing() -> Vec<String> {
            security(&["list-keychains", "-d", "user"])
                .lines()
                .map(|line| line.trim().trim_matches('"').to_owned())
                .filter(|line| !line.is_empty())
                .collect()
        }
        struct IsolatedKeychain {
            dir: PathBuf,
            path: PathBuf,
            original_list: Vec<String>,
            original_default: String,
            restored: bool,
        }
        impl IsolatedKeychain {
            fn restore(&mut self) {
                if self.restored {
                    return;
                }
                let _ = Command::new("/usr/bin/security")
                    .args(["delete-keychain", self.path.to_str().unwrap()])
                    .output();
                let mut args = vec!["list-keychains", "-d", "user", "-s"];
                args.extend(self.original_list.iter().map(String::as_str));
                security(&args);
                if !self.original_default.is_empty() {
                    security(&[
                        "default-keychain",
                        "-d",
                        "user",
                        "-s",
                        &self.original_default,
                    ]);
                }
                self.restored = true;
                let _ = fs::remove_dir_all(&self.dir);
            }
        }
        impl Drop for IsolatedKeychain {
            fn drop(&mut self) {
                self.restore();
            }
        }
        fn identity(keychain: &SecKeychain, user: &str) -> Vec<u8> {
            let mut query = ItemSearchOptions::new();
            let found = query
                .keychains(std::slice::from_ref(keychain))
                .class(ItemClass::generic_password())
                .service(SERVICE)
                .account(user)
                .load_refs(true)
                .search()
                .unwrap();
            assert_eq!(found.len(), 1);
            let SearchResult::Ref(Reference::KeychainItem(item)) = &found[0] else {
                panic!("Expected the unique synthetic Keychain item reference");
            };
            let mut reference = std::ptr::null();
            let status = unsafe {
                SecKeychainItemCreatePersistentReference(item.as_CFTypeRef(), &mut reference)
            };
            assert_eq!(status, 0);
            assert!(!reference.is_null());
            unsafe { CFData::wrap_under_create_rule(reference.cast()).to_vec() }
        }
        fn acl(path: &Path) -> String {
            // -a reads ACL metadata only, never -d decrypted secret data.
            let dump = security(&["dump-keychain", "-a", path.to_str().unwrap()]);
            let (_, entries) = dump
                .split_once("access:")
                .expect("Synthetic item has an ACL");
            assert!(entries.contains("authorizations"));
            assert!(entries.contains("/usr/bin/security"));
            entries.trim().to_owned()
        }
        let _serial = SERIAL.lock().unwrap();
        let original_list = listing();
        let original_default = security(&["default-keychain", "-d", "user"])
            .trim()
            .trim_matches('"')
            .to_owned();
        let paths = fixture();
        let mut isolated = IsolatedKeychain {
            path: paths.dir.join("synthetic.keychain"),
            dir: paths.dir,
            original_list: original_list.clone(),
            original_default: original_default.clone(),
            restored: false,
        };
        let mut keychain = CreateOptions::new()
            .password("synthetic-keychain-password-never-used-for-an-account")
            .create(&isolated.path)
            .unwrap();
        keychain
            .unlock(Some(
                "synthetic-keychain-password-never-used-for-an-account",
            ))
            .unwrap();
        let user = "synthetic-mac-rotation-test";
        // The Rust test process is deliberately NOT trusted to decrypt this
        // item. A regression to read-before-write must fail with UI disabled.
        security(&[
            "add-generic-password",
            "-a",
            user,
            "-s",
            SERVICE,
            "-w",
            "synthetic-original-value",
            "-T",
            "/usr/bin/security",
            isolated.path.to_str().unwrap(),
        ]);
        let identity_before = identity(&keychain, user);
        let acl_before = acl(&isolated.path);
        {
            let _no_prompt = SecKeychain::disable_user_interaction().unwrap();
            assert!(
                keychain.find_generic_password(SERVICE, user).is_err(),
                "The test must reject the old decrypt-before-write behavior"
            );
            for pass in 1..=8 {
                macos_update_password(&keychain, SERVICE, user, &format!("synthetic-rotation-{pass}"))
                    .unwrap();
            }
            assert!(
                keychain.find_generic_password(SERVICE, user).is_err(),
                "Rotation must not grant new decrypt access"
            );
            assert_eq!(
                identity(&keychain, user),
                identity_before,
                "Credential rotation must preserve the same Keychain item"
            );
        }
        assert_eq!(
            acl(&isolated.path),
            acl_before,
            "Value-only rotation must preserve every existing ACL entry"
        );
        let actual = security(&[
            "find-generic-password",
            "-a",
            user,
            "-s",
            SERVICE,
            "-w",
            isolated.path.to_str().unwrap(),
        ]);
        assert_eq!(actual.trim(), "synthetic-rotation-8");
        drop(keychain);
        isolated.restore();
        assert_eq!(listing(), original_list);
        assert_eq!(
            security(&["default-keychain", "-d", "user"])
                .trim()
                .trim_matches('"'),
            original_default
        );
        println!("MAC_KEYCHAIN_ROTATION_PASS: 8 value-only updates; decrypt denied; item and ACL preserved; final value verified; runner search list and default restored; no account credentials used.");
    }
    #[test]
    fn beta_store_update_keeps_profile_and_account_namespace_across_package_versions() {
        // Resolve the real native profile path for two app package versions.
        // MockRuntime creates no webview and this test never opens a keyring.
        let resolve = |version: &str| {
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().identifier = "com.memtrace.memcode".into();
            context.package_info_mut().version = version.parse().unwrap();
            let app = tauri::test::mock_builder().build(context).unwrap();
            let profile = crate::native::profile_dir(app.handle()).unwrap();
            (profile.clone(), namespace(&profile))
        };
        let before = resolve("0.4.0-beta.7");
        let after = resolve("0.4.0-beta.8");
        assert_eq!(
            before, after,
            "Updating the app must retain the account and WebView profile namespace"
        );
    }
    #[test]
    fn beta_store_logout_tombstone_survives_locked_keyring_and_failed_reconnect() {
        let paths = fixture();
        let backend = Fake {
            value: RefCell::new(None),
            fail: true,
        };
        operate(
            copy(&paths),
            &backend,
            "beta_store_mark_signed_out",
            Value::Null,
        )
        .unwrap();
        assert_eq!(stored(&paths, &backend).unwrap()["signedOut"], true);
        assert!(operate(
            copy(&paths),
            &backend,
            "beta_store_write",
            json!({"credentials":{"refreshToken":"synthetic-secret"}})
        )
        .is_err());
        assert_eq!(stored(&paths, &backend).unwrap()["signedOut"], true);
        let working = Fake {
            value: RefCell::new(None),
            fail: false,
        };
        operate(
            copy(&paths),
            &working,
            "beta_store_write",
            json!({"credentials":{"refreshToken":"fresh-synthetic-secret"}}),
        )
        .unwrap();
        assert_eq!(stored(&paths, &working).unwrap()["signedOut"], false);
        operate(copy(&paths), &working, "beta_store_clear", Value::Null).unwrap();
        fs::remove_dir(paths.dir).unwrap();
    }
    #[test]
    fn beta_store_forgetting_a_revoked_session_keeps_beta_mode_signed_out_after_restart() {
        let paths = fixture();
        let backend = Fake {
            value: RefCell::new(None),
            fail: false,
        };
        operate(
            copy(&paths),
            &backend,
            "beta_store_write",
            json!({"credentials":{"refreshToken":"synthetic-revoked-secret"}}),
        )
        .unwrap();
        operate(
            copy(&paths),
            &backend,
            "beta_access_write",
            json!({"accessToken":"synthetic.signed.proof"}),
        )
        .unwrap();
        operate(
            copy(&paths),
            &backend,
            "beta_store_forget_session",
            Value::Null,
        )
        .unwrap();
        let read = stored(&paths, &backend).unwrap();
        assert_eq!(read["configured"], true);
        assert_eq!(read["signedOut"], true);
        assert!(read["credentials"].is_null());
        assert!(read["storageError"].is_null());
        assert!(!paths.access().exists());
        assert!(operate(
            copy(&paths),
            &backend,
            "beta_access_write",
            json!({"accessToken":"synthetic.signed.proof"})
        )
        .is_err());
        operate(copy(&paths), &backend, "beta_store_clear", Value::Null).unwrap();
        fs::remove_dir(paths.dir).unwrap();
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "Explicit synthetic Windows Credential Manager acceptance; never accesses a real profile entry"]
    fn beta_store_os_credential_roundtrip_uses_only_a_unique_synthetic_entry() {
        let user = format!(
            "synthetic-beta-store-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = OsCredentials(self.0.clone()).clear();
            }
        }
        let _cleanup = Cleanup(user.clone());
        let store = OsCredentials(user);
        assert!(store.read().unwrap().is_none());
        let synthetic = serde_json::to_string(&json!({"synthetic":true,"refreshToken":"this-is-not-an-authentication-credential","account":{"id":"synthetic-test-only","name":"Storage acceptance"}})).unwrap();
        store.write(&synthetic).unwrap();
        assert_eq!(store.read().unwrap().as_deref(), Some(synthetic.as_str()));
        store.clear().unwrap();
        assert!(store.read().unwrap().is_none());
    }
    #[cfg(unix)]
    #[test]
    fn beta_store_files_are_owner_only_and_symlinks_are_refused() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let paths = fixture();
        atomic(&paths.access(), b"synthetic.signed.proof").unwrap();
        assert_eq!(
            fs::metadata(&paths.dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(paths.access()).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_file(paths.access()).unwrap();
        symlink(paths.marker(), paths.access()).unwrap();
        assert!(atomic(&paths.access(), b"synthetic.signed.proof").is_err());
        fs::remove_file(paths.access()).unwrap();
        fs::remove_dir(paths.dir).unwrap();
    }
}
