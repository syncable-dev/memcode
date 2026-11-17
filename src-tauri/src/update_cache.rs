//! Durable updater payloads. Only a signed payload is eligible for installation.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::Write,
    path::{Path, PathBuf},
};

const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct Manifest {
    schema: u8,
    directory: String,
    version: String,
    length: u64,
    release: Value,
}

#[derive(Clone)]
pub struct StagedDownload {
    pub version: String,
    pub release: Value,
    root: PathBuf,
    directory: PathBuf,
    path: PathBuf,
    length: u64,
}

fn private_directory(path: &Path) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|e| e.to_string())?;
    let info = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err("The update cache must be a local directory.".into());
    }
    Ok(())
}

fn create_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}

fn regular_file(path: &Path, max_length: u64) -> Result<std::fs::Metadata, String> {
    let info = std::fs::symlink_metadata(path)
        .map_err(|_| "The saved update is incomplete. Download it again.".to_owned())?;
    if !info.is_file() || info.file_type().is_symlink() || info.len() > max_length {
        return Err("The saved update changed. Download it again.".into());
    }
    Ok(info)
}

impl StagedDownload {
    pub fn create(
        root: &Path,
        version: String,
        release: Value,
        bytes: &[u8],
    ) -> Result<Self, String> {
        if bytes.is_empty() || bytes.len() as u64 > MAX_PACKAGE_BYTES {
            return Err("The update package has an invalid size.".into());
        }
        private_directory(root)?;
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let name = format!("download-{}-{nonce}", std::process::id());
        let directory = root.join(&name);
        private_directory(&directory)?;
        let staged = Self {
            version: version.clone(),
            release: release.clone(),
            root: root.to_owned(),
            path: directory.join("signed-update"),
            directory,
            length: bytes.len() as u64,
        };
        let temporary = root.join(format!("pending-{nonce}.tmp"));
        let save = (|| {
            create_file(&staged.path, bytes)?;
            let manifest = serde_json::to_vec(&Manifest {
                schema: 1,
                directory: name,
                version,
                length: staged.length,
                release,
            })
            .map_err(|e| e.to_string())?;
            if manifest.len() as u64 > MAX_MANIFEST_BYTES {
                return Err("The update manifest is too large.".into());
            }
            create_file(&temporary, &manifest)?;
            std::fs::rename(&temporary, root.join("pending.json")).map_err(|e| e.to_string())
        })();
        if let Err(error) = save {
            let _ = std::fs::remove_file(&temporary);
            let _ = std::fs::remove_file(&staged.path);
            let _ = std::fs::remove_dir(&staged.directory);
            return Err(error);
        }
        Ok(staged)
    }

    /// Loading the journal is not signature verification. The caller must restore
    /// it with the production updater and verify its bytes before marking ready.
    pub fn load(root: &Path) -> Result<Option<Self>, String> {
        let journal = root.join("pending.json");
        if !journal.try_exists().map_err(|e| e.to_string())? {
            return Ok(None);
        }
        private_directory(root)?;
        regular_file(&journal, MAX_MANIFEST_BYTES)?;
        let value: Manifest = serde_json::from_slice(
            &std::fs::read(journal).map_err(|e| e.to_string())?,
        )
        .map_err(|_| "The saved update record is invalid. Check for updates again.".to_owned())?;
        if value.schema != 1
            || !value.directory.starts_with("download-")
            || value.directory.len() > 90
            || !value.directory[9..]
                .bytes()
                .all(|b| b.is_ascii_digit() || b == b'-')
            || value.length == 0
            || value.length > MAX_PACKAGE_BYTES
        {
            return Err("The saved update record is invalid. Check for updates again.".into());
        }
        let directory = root.join(&value.directory);
        let info = std::fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
        if !info.is_dir() || info.file_type().is_symlink() {
            return Err("The saved update directory changed.".into());
        }
        Ok(Some(Self {
            version: value.version,
            release: value.release,
            root: root.to_owned(),
            path: directory.join("signed-update"),
            directory,
            length: value.length,
        }))
    }

    pub fn read(&self) -> Result<Vec<u8>, String> {
        if regular_file(&self.path, MAX_PACKAGE_BYTES)?.len() != self.length {
            return Err("The saved update changed. Download it again.".into());
        }
        std::fs::read(&self.path).map_err(|e| e.to_string())
    }

    /// Explicit cleanup after a successful upgrade or failed signature check.
    /// Dropping a handle or closing the app deliberately keeps the download.
    pub fn remove(&self) {
        let _ = std::fs::remove_file(self.root.join("pending.json"));
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir(&self.directory);
    }

    pub fn discard_manifest(root: &Path) {
        if let Ok(info) = std::fs::symlink_metadata(root) {
            if info.is_dir() && !info.file_type().is_symlink() {
                let _ = std::fs::remove_file(root.join("pending.json"));
            }
        }
    }
}
