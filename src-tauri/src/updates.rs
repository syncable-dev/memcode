//! Only the application webview can request signed desktop updates.
use crate::bridge::RuntimeBridge;
use crate::update_cache::StagedDownload;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Webview};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

#[derive(Default)]
pub struct UpdateState {
    operation: tokio::sync::Mutex<()>,
    pending: Mutex<Option<Update>>,
    downloaded: Mutex<Option<StagedDownload>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    development: bool,
    previous_error: Option<String>,
    ready_release: Option<Release>,
}

#[derive(Serialize, Deserialize)]
struct PreviousFailure {
    version: String,
    message: String,
}

fn failure_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::native::profile_dir(app)?.join("last-update-failure.json"))
}

fn previous_failure(app: &AppHandle) -> Option<String> {
    let path = failure_path(app).ok()?;
    if std::fs::metadata(&path).ok()?.len() > 4096 {
        return None;
    }
    let failure: PreviousFailure =
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    (failure.version == app.package_info().version.to_string())
        .then(|| failure.message.chars().take(1000).collect())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    version: String,
    notes: String,
    published_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
}

fn main_only(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Only the MemCode application may manage updates.".into());
    }
    Ok(())
}

fn development() -> bool {
    cfg!(debug_assertions)
        || std::env::var_os("MEMCODE_NATIVE_TEST_PROFILE").is_some()
        || std::env::var_os("MEMCODE_APP_PATH").is_some()
        || std::env::var_os("MEMCODE_SERVICE_PATH").is_some()
}

fn installed_only() -> Result<(), String> {
    if development() {
        return Err("Development builds update through Git. Install a beta release to use signed app updates.".into());
    }
    if !crate::install_location::status().can_update {
        return Err("Move MemCode into Applications and open the installed copy before updating. Your projects and settings stay saved.".into());
    }
    Ok(())
}

fn update_cache(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::native::profile_dir(app)?.join("updates"))
}

fn updater(app: &AppHandle, runtime: &RuntimeBridge) -> Result<Updater, String> {
    let runtime = runtime.clone();
    app.updater_builder()
        .timeout(Duration::from_secs(20))
        .restart_after_install(true)
        .on_before_exit(move || tauri::async_runtime::block_on(runtime.shutdown()))
        .build()
        .map_err(|e| e.to_string())
}

fn secure_release(update: &Update) -> Result<(), String> {
    if update.download_url.scheme() != "https"
        || !update.download_url.username().is_empty()
        || update.download_url.password().is_some()
    {
        return Err("The release did not provide a secure download address.".into());
    }
    Ok(())
}

fn restore_download(
    cache: &std::path::Path,
    updater: &Updater,
) -> Result<Option<(Update, StagedDownload)>, String> {
    let Some(staged) = StagedDownload::load(cache)? else {
        return Ok(None);
    };
    let restored = (|| {
        // The native plugin rejects obsolete versions and requires a version-bound
        // signature. Cached JSON is not trusted just because it is on disk.
        let Some(update) = updater
            .restore_update(staged.release.clone())
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        secure_release(&update)?;
        if update.version != staged.version {
            return Err("The saved update version changed.".into());
        }
        update.verify(&staged.read()?).map_err(|e| e.to_string())?;
        Ok(Some(update))
    })();
    match restored {
        Ok(Some(update)) => Ok(Some((update, staged))),
        Ok(None) => {
            staged.remove();
            Ok(None)
        }
        Err(error) => {
            staged.remove();
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn app_update_info(
    webview: Webview,
    app: AppHandle,
    state: tauri::State<'_, UpdateState>,
    runtime: tauri::State<'_, RuntimeBridge>,
) -> Result<UpdateInfo, String> {
    main_only(&webview)?;
    let _operation = state.operation.lock().await;
    let mut previous_error = previous_failure(&app);
    if !development()
        && state
            .downloaded
            .lock()
            .map_err(|_| "Update state is unavailable.")?
            .is_none()
    {
        let cache = update_cache(&app)?;
        let native = updater(&app, runtime.inner())?;
        let restore_cache = cache.clone();
        let restored =
            tauri::async_runtime::spawn_blocking(move || restore_download(&restore_cache, &native))
                .await
                .map_err(|e| e.to_string())?;
        match restored {
            Ok(Some((update, staged))) => {
                *state
                    .pending
                    .lock()
                    .map_err(|_| "Update state is unavailable.")? = Some(update);
                *state
                    .downloaded
                    .lock()
                    .map_err(|_| "Update state is unavailable.")? = Some(staged);
            }
            Ok(None) => {}
            Err(_) => {
                StagedDownload::discard_manifest(&cache);
                previous_error = Some("The saved update could not be verified. Check for updates to download a fresh copy.".into());
            }
        }
    }
    Ok(UpdateInfo {
        current_version: app.package_info().version.to_string(),
        development: development(),
        previous_error,
        ready_release: {
            let version = state
                .downloaded
                .lock()
                .map_err(|_| "Update state is unavailable.")?
                .as_ref()
                .map(|value| value.version.clone());
            state
                .pending
                .lock()
                .map_err(|_| "Update state is unavailable.")?
                .as_ref()
                .filter(|update| Some(&update.version) == version.as_ref())
                .map(release_summary)
        },
    })
}

#[tauri::command]
pub async fn app_update_context(
    webview: Webview,
    runtime: tauri::State<'_, RuntimeBridge>,
    terminals: tauri::State<'_, crate::terminal::TerminalState>,
) -> Result<Value, String> {
    main_only(&webview)?;
    let mut context = runtime.request("app:update-context", Value::Null).await?;
    context["activeTerminals"] = serde_json::json!(terminals.active_count()?);
    Ok(context)
}

#[tauri::command]
pub async fn app_update_history(
    webview: Webview,
    runtime: tauri::State<'_, RuntimeBridge>,
) -> Result<Value, String> {
    main_only(&webview)?;
    runtime.request("app:update-history", Value::Null).await
}

#[tauri::command]
pub async fn app_update_check(
    webview: Webview,
    app: AppHandle,
    state: tauri::State<'_, UpdateState>,
    runtime: tauri::State<'_, RuntimeBridge>,
) -> Result<Option<Release>, String> {
    main_only(&webview)?;
    installed_only()?;
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    if state
        .downloaded
        .lock()
        .map_err(|_| "Update state is unavailable.")?
        .is_some()
    {
        return Ok(state
            .pending
            .lock()
            .map_err(|_| "Update state is unavailable.")?
            .as_ref()
            .map(release_summary));
    }
    // A failed recheck must not leave an older announcement installable.
    *state
        .pending
        .lock()
        .map_err(|_| "Update state is unavailable.")? = None;
    let update = updater(&app, runtime.inner())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(update) = &update {
        secure_release(update)?;
    }
    let release = update.as_ref().map(release_summary);
    *state
        .pending
        .lock()
        .map_err(|_| "Update state is unavailable.")? = update;
    if let Ok(path) = failure_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    Ok(release)
}

fn release_summary(update: &Update) -> Release {
    Release {
        version: update.version.clone(),
        notes: update
            .body
            .as_deref()
            .unwrap_or("")
            .chars()
            .take(32_000)
            .collect(),
        published_at: update
            .raw_json
            .get("pub_date")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

#[tauri::command]
pub async fn app_update_download(
    webview: Webview,
    app: AppHandle,
    state: tauri::State<'_, UpdateState>,
    version: String,
    channel: tauri::ipc::Channel<Progress>,
) -> Result<(), String> {
    main_only(&webview)?;
    installed_only()?;
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    let mut update = state
        .pending
        .lock()
        .map_err(|_| "Update state is unavailable.")?
        .as_ref()
        .filter(|update| update.version == version)
        .cloned()
        .ok_or("Check for this update again before installing it.")?;
    if state
        .downloaded
        .lock()
        .map_err(|_| "Update state is unavailable.")?
        .as_ref()
        .is_some_and(|value| value.version == version)
    {
        let _ = channel.send(Progress {
            phase: "ready",
            downloaded: 0,
            total: None,
        });
        return Ok(());
    }
    update.timeout = Some(Duration::from_secs(300));
    let mut downloaded = 0_u64;
    let mut last = Instant::now();
    let progress = channel.clone();
    let _ = channel.send(Progress {
        phase: "downloading",
        downloaded: 0,
        total: None,
    });
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                if last.elapsed() >= Duration::from_millis(150) {
                    let _ = progress.send(Progress {
                        phase: "downloading",
                        downloaded,
                        total,
                    });
                    last = Instant::now();
                }
            },
            || {
                let _ = channel.send(Progress {
                    phase: "verifying",
                    downloaded: 0,
                    total: None,
                });
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let length = bytes.len() as u64;
    let cache = update_cache(&app)?;
    let manifest = update.raw_json.clone();
    let staged = tauri::async_runtime::spawn_blocking(move || {
        StagedDownload::create(&cache, version, manifest, &bytes)
    })
    .await
    .map_err(|e| e.to_string())??;
    *state
        .downloaded
        .lock()
        .map_err(|_| "Update state is unavailable.")? = Some(staged);
    let _ = channel.send(Progress {
        phase: "ready",
        downloaded: length,
        total: Some(length),
    });
    Ok(())
}

#[tauri::command]
pub async fn app_update_install(
    webview: Webview,
    app: AppHandle,
    state: tauri::State<'_, UpdateState>,
    runtime: tauri::State<'_, RuntimeBridge>,
    version: String,
    channel: tauri::ipc::Channel<Progress>,
) -> Result<(), String> {
    main_only(&webview)?;
    installed_only()?;
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    let update = state
        .pending
        .lock()
        .map_err(|_| "Update state is unavailable.")?
        .as_ref()
        .filter(|update| update.version == version)
        .cloned()
        .ok_or("Check for this update again before installing it.")?;
    // Re-read and re-verify private staged bytes immediately before installation.
    let staged = state
        .downloaded
        .lock()
        .map_err(|_| "Update state is unavailable.")?
        .as_ref()
        .filter(|value| value.version == version)
        .cloned()
        .ok_or("Download this update before restarting.")?;
    let (update, bytes) = tauri::async_runtime::spawn_blocking(move || {
        let bytes = staged.read()?;
        update.verify(&bytes).map_err(|e| e.to_string())?;
        Ok::<_, String>((update, bytes))
    })
    .await
    .map_err(|e| e.to_string())??;
    // Workers can continue during the download. Reserve an idle workspace only
    // after explicit Restart to update; never cancel a running worker.
    runtime.request("app:update-prepare", Value::Null).await?;
    let _ = channel.send(Progress {
        phase: "installing",
        downloaded: bytes.len() as u64,
        total: Some(bytes.len() as u64),
    });
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result.map_err(|e| e.to_string()));
    if let Err(error) = installed {
        if runtime.is_closing() {
            let version = app.package_info().version.to_string();
            let failure = PreviousFailure { version: version.clone(), message: format!("The update could not be installed. MemCode reopened version {version}; saved work is preserved. {}", error.chars().take(600).collect::<String>()) };
            if let (Ok(path), Ok(json)) = (failure_path(&app), serde_json::to_vec(&failure)) {
                let _ = std::fs::write(path, json);
            }
            app.restart();
        }
        let _ = runtime.request("app:update-release", Value::Null).await;
        return Err(error);
    }
    // Windows exits within install(); macOS/Linux must close and relaunch.
    runtime.shutdown().await;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture_updater(public_key: &str) -> Updater {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert("updater".into(), json!({
            "pubkey": public_key,
            "requireSignedVersion": true,
            "endpoints": ["https://www.memtrace.io/api/memcode/updates/{{target}}/{{arch}}/{{current_version}}"]
        }));
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        app.updater_builder().build().unwrap()
    }

    fn fixture_update(fixture: &Value, public_key: &str, version: &str) -> Update {
        fixture_updater(public_key)
            .restore_update(json!({
                "version": version,
                "url": "https://example.invalid/signed-test-fixture.exe",
                "signature": fixture["signature"],
                "notes": "Synthetic test fixture; never installed or downloaded."
            }))
            .unwrap()
            .unwrap()
    }

    #[test]
    fn updater_verifies_real_signature_and_rejects_tampering_wrong_key_and_manifest_version() {
        // Generated by the actual Tauri signer using a discarded ephemeral
        // test key. This exercises the real plugin verifier, never an installer.
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/updater-signature.json"))
                .unwrap();
        let bytes = fixture["payload"].as_str().unwrap().as_bytes();
        let key = fixture["publicKey"].as_str().unwrap();
        let version = fixture["version"].as_str().unwrap();
        let update = fixture_update(&fixture, key, version);
        update
            .verify(bytes)
            .expect("Actual signer and updater must interoperate");
        assert!(update.verify(b"Tampered updater payload").is_err());
        let changed_version = fixture_update(&fixture, key, "0.4.0-beta.3");
        assert!(
            changed_version.verify(bytes).is_err(),
            "A manifest cannot relabel a signed older payload"
        );
        let production: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let wrong_key = fixture_update(
            &fixture,
            production["plugins"]["updater"]["pubkey"].as_str().unwrap(),
            version,
        );
        assert!(
            wrong_key.verify(bytes).is_err(),
            "An unrelated signing key must not be trusted"
        );
    }

    #[test]
    fn staged_update_uses_disk_and_is_reverified_before_installation() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/updater-signature.json"))
                .unwrap();
        let bytes = fixture["payload"].as_str().unwrap().as_bytes();
        let update = fixture_update(
            &fixture,
            fixture["publicKey"].as_str().unwrap(),
            fixture["version"].as_str().unwrap(),
        );
        update.verify(bytes).unwrap();
        let cache = std::env::temp_dir().join(format!(
            "memcode-cache-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let staged = StagedDownload::create(
            &cache,
            update.version.clone(),
            update.raw_json.clone(),
            bytes,
        )
        .unwrap();
        let journal: Value =
            serde_json::from_slice(&std::fs::read(cache.join("pending.json")).unwrap()).unwrap();
        let path = cache
            .join(journal["directory"].as_str().unwrap())
            .join("signed-update");
        update.verify(&staged.read().unwrap()).unwrap();
        drop(staged);
        let restored = restore_download(
            &cache,
            &fixture_updater(fixture["publicKey"].as_str().unwrap()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            restored.1.read().unwrap(),
            bytes,
            "Dropping the original process state must keep the verified download"
        );
        let mut tampered = bytes.to_vec();
        tampered[0] ^= 1;
        std::fs::write(&path, tampered).unwrap();
        assert!(
            restore_download(
                &cache,
                &fixture_updater(fixture["publicKey"].as_str().unwrap())
            )
            .is_err(),
            "Tampering after download must not become an installable update"
        );
        assert!(!path.exists());
        assert!(!cache.join("pending.json").exists());
        std::fs::remove_dir(cache).unwrap();
    }

    #[test]
    fn staged_update_survives_an_actual_process_restart_without_a_download() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/updater-signature.json"))
                .unwrap();
        if let Some(cache) = std::env::var_os("MEMCODE_CACHE_RESTART_TEST") {
            let (_, staged) = restore_download(
                &PathBuf::from(cache),
                &fixture_updater(fixture["publicKey"].as_str().unwrap()),
            )
            .unwrap()
            .unwrap();
            assert_eq!(
                staged.read().unwrap(),
                fixture["payload"].as_str().unwrap().as_bytes()
            );
            return;
        }
        let cache = std::env::temp_dir().join(format!(
            "memcode-cache-restart-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let update = fixture_update(
            &fixture,
            fixture["publicKey"].as_str().unwrap(),
            fixture["version"].as_str().unwrap(),
        );
        let staged = StagedDownload::create(
            &cache,
            update.version.clone(),
            update.raw_json.clone(),
            fixture["payload"].as_str().unwrap().as_bytes(),
        )
        .unwrap();
        drop(staged);
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["updates::tests::staged_update_survives_an_actual_process_restart_without_a_download", "--exact", "--nocapture"])
            .env("MEMCODE_CACHE_RESTART_TEST", &cache).output().unwrap();
        assert!(
            result.status.success(),
            "A fresh native process must restore the signed download: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        StagedDownload::load(&cache).unwrap().unwrap().remove();
        std::fs::remove_dir(cache).unwrap();
    }

    #[test]
    fn cached_update_rejects_manifest_relabelling_and_cleans_completed_upgrades() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/updater-signature.json"))
                .unwrap();
        let cache = std::env::temp_dir().join(format!(
            "memcode-cache-version-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let updater = fixture_updater(fixture["publicKey"].as_str().unwrap());
        let mut update = fixture_update(
            &fixture,
            fixture["publicKey"].as_str().unwrap(),
            fixture["version"].as_str().unwrap(),
        );
        update.raw_json["version"] = json!("0.4.0-beta.999999");
        let staged = StagedDownload::create(
            &cache,
            "0.4.0-beta.999999".into(),
            update.raw_json.clone(),
            fixture["payload"].as_str().unwrap().as_bytes(),
        )
        .unwrap();
        drop(staged);
        assert!(restore_download(&cache, &updater).is_err());
        update.raw_json["version"] = json!("0.0.1");
        let staged = StagedDownload::create(
            &cache,
            "0.0.1".into(),
            update.raw_json.clone(),
            fixture["payload"].as_str().unwrap().as_bytes(),
        )
        .unwrap();
        drop(staged);
        assert!(restore_download(&cache, &updater).unwrap().is_none());
        assert!(!cache.join("pending.json").exists());
        std::fs::remove_dir(cache).unwrap();
    }

    #[test]
    #[ignore = "Explicit release-candidate check; requires a real updater payload and its .sig file"]
    fn updater_verifies_packaged_candidate() {
        let path = std::path::PathBuf::from(
            std::env::var_os("MEMCODE_CANDIDATE_UPDATER")
                .expect("Provide the actual candidate updater path"),
        );
        assert!(path.is_absolute(), "Use an absolute candidate path");
        let bytes = std::fs::read(&path).expect("Candidate payload must exist");
        assert!(!bytes.is_empty(), "Candidate payload cannot be empty");
        let signature = std::fs::read_to_string(format!("{}.sig", path.display()))
            .expect("Candidate signature must exist");
        let production: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let key = production["plugins"]["updater"]["pubkey"].as_str().unwrap();
        let version = env!("CARGO_PKG_VERSION");
        assert_eq!(production["version"], version);
        let fixture = json!({"signature":signature.trim()});
        let update = fixture_update(&fixture, key, version);
        update
            .verify(&bytes)
            .expect("Actual artifact must verify against this release's public key and version");
        let mut changed = bytes.clone();
        changed[0] ^= 1;
        assert!(
            update.verify(&changed).is_err(),
            "Altered artifact must fail verification"
        );
        let relabelled = fixture_update(&fixture, key, "0.4.0-beta.999999");
        assert!(
            relabelled.verify(&bytes).is_err(),
            "Signed artifact cannot be relabelled as a different version"
        );
        let other: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/updater-signature.json"))
                .unwrap();
        let wrong_key = fixture_update(&fixture, other["publicKey"].as_str().unwrap(), version);
        assert!(
            wrong_key.verify(&bytes).is_err(),
            "Unrelated key must fail verification"
        );
        println!("Verified actual candidate payload ({} bytes), version {}, tamper rejection, key binding and version binding; no installation performed.",bytes.len(),version);
    }
}
