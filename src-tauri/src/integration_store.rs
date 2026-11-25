//! Sign-ins to the tools a project is connected to. They live in the OS credential store
//! and nowhere else; no file, log or window ever holds one.
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::AppHandle;

const SERVICE: &str = "dev.memcode.integrations";
/// Windows keeps at most 2,560 bytes in one credential.
const LIMIT: usize = 2_400;
static SERIAL: Mutex<()> = Mutex::new(());
const UNAVAILABLE: &str = "Unlock the OS credential store to connect integrations";

trait Secrets {
    fn read(&self, user: &str) -> Result<Option<String>, String>;
    fn write(&self, user: &str, value: &str) -> Result<(), String>;
    fn clear(&self, user: &str) -> Result<(), String>;
}
struct OsSecrets;
fn entry(user: &str) -> Result<keyring::v1::Entry, String> {
    keyring::v1::Entry::new(SERVICE, user).map_err(|_| UNAVAILABLE.to_string())
}
impl Secrets for OsSecrets {
    fn read(&self, user: &str) -> Result<Option<String>, String> {
        match entry(user)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::v1::Error::NoEntry) => Ok(None),
            Err(_) => Err(UNAVAILABLE.into()),
        }
    }
    fn write(&self, user: &str, value: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};
            let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
                .map_err(|_| UNAVAILABLE.to_string())?;
            crate::beta_store::macos_update_password(&keychain, SERVICE, user, value)
                .map_err(|_| UNAVAILABLE.to_string())
        }
        #[cfg(not(target_os = "macos"))]
        entry(user)?
            .set_password(value)
            .map_err(|_| UNAVAILABLE.to_string())
    }
    fn clear(&self, user: &str) -> Result<(), String> {
        match entry(user)?.delete_credential() {
            Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
            Err(_) => Err(UNAVAILABLE.into()),
        }
    }
}

/// The profile and the connection: two MemCode profiles never share a sign-in.
fn user(profile: &str, input: &Value) -> Result<String, String> {
    let id = input["id"].as_str().unwrap_or_default();
    if id.len() < 8
        || id.len() > 64
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("Unknown integration".into());
    }
    Ok(format!("{profile}:{id}"))
}

fn operate(secrets: &impl Secrets, profile: &str, method: &str, input: &Value) -> Result<Value, String> {
    let user = user(profile, input)?;
    match method {
        "integration_store_read" => {
            let Some(secret) = secrets.read(&user)? else {
                return Ok(Value::Null);
            };
            if secret.len() > LIMIT {
                return Ok(Value::Null);
            }
            match serde_json::from_str::<Value>(&secret) {
                Ok(value) if value.is_object() => Ok(value),
                _ => Ok(Value::Null),
            }
        }
        "integration_store_write" => {
            let value = input
                .get("tokens")
                .filter(|value| value.as_object().is_some_and(|object| !object.is_empty()))
                .ok_or("Missing sign-in")?;
            let secret = serde_json::to_string(value).map_err(|_| "Invalid sign-in")?;
            if secret.len() > LIMIT {
                return Err("The sign-in is too long to keep safely".into());
            }
            secrets.write(&user, &secret)?;
            Ok(json!({ "saved": true }))
        }
        "integration_store_clear" => {
            secrets.clear(&user)?;
            Ok(json!({ "cleared": true }))
        }
        _ => Err("Unknown integration storage call".into()),
    }
}

pub async fn call(app: AppHandle, method: &str, input: Value) -> Result<Value, String> {
    let method = method.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SERIAL.lock().map_err(|_| UNAVAILABLE)?;
        let profile = crate::beta_store::namespace(&crate::native::profile_dir(&app)?);
        operate(&OsSecrets, &profile, &method, &input)
    })
    .await
    .map_err(|_| UNAVAILABLE.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};
    #[derive(Default)]
    struct Fake(RefCell<HashMap<String, String>>, bool);
    impl Secrets for Fake {
        fn read(&self, user: &str) -> Result<Option<String>, String> {
            if self.1 { Err(UNAVAILABLE.into()) } else { Ok(self.0.borrow().get(user).cloned()) }
        }
        fn write(&self, user: &str, value: &str) -> Result<(), String> {
            if self.1 { return Err(UNAVAILABLE.into()); }
            self.0.borrow_mut().insert(user.into(), value.into());
            Ok(())
        }
        fn clear(&self, user: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(user);
            Ok(())
        }
    }
    const ID: &str = "0b6c1c1e-0000-4000-8000-000000000001";
    fn at(method: &str, secrets: &Fake, profile: &str, input: Value) -> Result<Value, String> {
        operate(secrets, profile, method, &input)
    }
    #[test]
    fn a_sign_in_is_kept_per_profile_and_connection_and_can_be_forgotten() {
        let secrets = Fake::default();
        let tokens = json!({ "kind": "sign-in", "access": "a", "refresh": "r" });
        at("integration_store_write", &secrets, "one", json!({ "id": ID, "tokens": tokens })).unwrap();
        assert_eq!(at("integration_store_read", &secrets, "one", json!({ "id": ID })).unwrap(), tokens);
        assert_eq!(at("integration_store_read", &secrets, "two", json!({ "id": ID })).unwrap(), Value::Null);
        at("integration_store_clear", &secrets, "one", json!({ "id": ID })).unwrap();
        assert_eq!(at("integration_store_read", &secrets, "one", json!({ "id": ID })).unwrap(), Value::Null);
    }
    #[test]
    fn nothing_but_a_bounded_sign_in_is_kept() {
        let secrets = Fake::default();
        for id in ["", "short", "../../../etc", &"x".repeat(80), "has space here"] {
            assert!(at("integration_store_read", &secrets, "one", json!({ "id": id })).is_err());
        }
        for tokens in [json!(null), json!({}), json!("token"), json!({ "access": "x".repeat(3000) })] {
            assert!(at("integration_store_write", &secrets, "one", json!({ "id": ID, "tokens": tokens })).is_err());
        }
        assert!(at("integration_store_dump", &secrets, "one", json!({ "id": ID })).is_err());
        secrets.0.borrow_mut().insert(format!("one:{ID}"), "not json".into());
        assert_eq!(at("integration_store_read", &secrets, "one", json!({ "id": ID })).unwrap(), Value::Null);
    }
    #[test]
    fn a_locked_store_says_so_without_what_it_was_asked_to_keep() {
        let secrets = Fake(RefCell::default(), true);
        let error = at("integration_store_write", &secrets, "one", json!({ "id": ID, "tokens": { "access": "secret-value" } })).unwrap_err();
        assert!(!error.contains("secret-value"));
    }
}
