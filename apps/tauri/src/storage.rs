use std::collections::HashSet;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FileAccessMode, PickerMode};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
#[cfg(desktop)]
use tauri_plugin_opener::OpenerExt;

use tailsend_platform_api::{
    FileMetadata, FileSource, IncomingFileSink, ReceivedItem, StorageError,
};

use crate::model::{hex_id, new_id, FileRequest, UiReceivedItem};

pub struct NativeFileSource {
    file: tokio::fs::File,
    metadata: FileMetadata,
    next_offset: u64,
}

impl NativeFileSource {
    pub async fn open(app: &AppHandle, request: FileRequest) -> Result<Self, String> {
        let path = request
            .path
            .parse::<FilePath>()
            .expect("FilePath parsing is infallible");
        let mut options = OpenOptions::new();
        options.read(true);
        let file = app
            .fs()
            .open(path, options)
            .map_err(|error| error.to_string())?;
        let file = tokio::fs::File::from_std(file);
        let actual = file.metadata().await.map_err(|error| error.to_string())?;
        if actual.len() != request.size {
            return Err(format!(
                "file size changed: {} != {}",
                actual.len(),
                request.size
            ));
        }
        Ok(Self {
            file,
            metadata: FileMetadata {
                name: request.name,
                size: request.size,
                mime: request.mime,
                modified_unix_ms: None,
            },
            next_offset: 0,
        })
    }
}

#[async_trait]
impl FileSource for NativeFileSource {
    fn metadata(&self) -> FileMetadata {
        self.metadata.clone()
    }

    async fn read_at(&mut self, offset: u64, max_len: usize) -> Result<bytes::Bytes, StorageError> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        self.file
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        let mut bytes = vec![0u8; max_len];
        let count = self
            .file
            .read(&mut bytes)
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        self.next_offset = offset.saturating_add(count as u64);
        bytes.truncate(count);
        Ok(bytes::Bytes::from(bytes))
    }

    async fn read_into(
        &mut self,
        offset: u64,
        destination: &mut [u8],
    ) -> Result<usize, StorageError> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        if self.next_offset != offset {
            self.file
                .seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|error| StorageError::Io(error.to_string()))?;
        }
        let count = self
            .file
            .read(destination)
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        self.next_offset = offset.saturating_add(count as u64);
        Ok(count)
    }

    async fn close(&mut self) {}
}

pub struct NativeFileSink {
    temp_path: PathBuf,
    final_path: PathBuf,
    file: Option<tokio::fs::File>,
    size: u64,
}

impl NativeFileSink {
    pub async fn prepare(dir: &Path, name: &str) -> Result<Self, StorageError> {
        std::fs::create_dir_all(dir).map_err(|error| StorageError::Io(error.to_string()))?;
        let safe = tailsend_protocol::filename::sanitize_filename(name)
            .map_err(|error| StorageError::Io(error.to_string()))?;
        let suffix = format!(".ponlet-{}.part", hex_id(new_id()));
        let final_path = dir.join(&safe);
        let temp_path = dir.join(format!(".{safe}{suffix}"));
        let file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        Ok(Self {
            temp_path,
            final_path,
            file: Some(file),
            size: 0,
        })
    }
}

#[async_trait]
impl IncomingFileSink for NativeFileSink {
    async fn write(&mut self, chunk: &[u8]) -> Result<(), StorageError> {
        use tokio::io::AsyncWriteExt;
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| StorageError::Io("sink closed".into()))?;
        file.write_all(chunk)
            .await
            .map_err(|error| StorageError::Io(error.to_string()))?;
        self.size = self.size.saturating_add(chunk.len() as u64);
        Ok(())
    }

    async fn commit(mut self: Box<Self>) -> Result<ReceivedItem, StorageError> {
        use tokio::io::AsyncWriteExt;
        let result = async {
            if let Some(mut file) = self.file.take() {
                file.flush()
                    .await
                    .map_err(|error| StorageError::Io(error.to_string()))?;
                file.sync_all()
                    .await
                    .map_err(|error| StorageError::Io(error.to_string()))?;
            }
            self.final_path = commit_received_file(&self.temp_path, &self.final_path).await?;
            Ok(ReceivedItem {
                name: self
                    .final_path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                size: self.size,
                local_path_or_handle: self.final_path.to_string_lossy().into_owned(),
            })
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&self.temp_path).await;
        }
        result
    }

    async fn abort(mut self: Box<Self>) -> Result<(), StorageError> {
        self.file.take();
        let _ = tokio::fs::remove_file(&self.temp_path).await;
        Ok(())
    }
}

async fn commit_received_file(source: &Path, path: &Path) -> Result<PathBuf, StorageError> {
    let parent = path
        .parent()
        .ok_or_else(|| StorageError::Io("received path has no parent".into()))?;
    let candidate = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| StorageError::Io("received path has no filename".into()))?;

    // Claim the destination atomically, including against other processes.
    // Checking existence before rename can overwrite a concurrent receive.
    // A hard link publishes the already flushed file without replacing any
    // existing entry. Filesystems without hard links use an exclusive create.
    // Avoid enumerating Downloads, which may block on a cloud file provider.
    let mut existing = HashSet::new();
    for _ in 0..10_000 {
        let unique = unique_received_name(&existing, candidate);
        let destination = parent.join(&unique);
        let claimed = match tokio::fs::hard_link(source, &destination).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(error),
            Err(_) => copy_received_file_exclusively(source, &destination).await,
        };
        match claimed {
            Ok(()) => {
                // The final file is durable. An orphaned temporary link must
                // not turn a successful receive into a failed/retried one.
                let _ = tokio::fs::remove_file(source).await;
                return Ok(destination);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                existing.insert(unique);
            }
            Err(error) => return Err(StorageError::Io(error.to_string())),
        }
    }

    Err(StorageError::Io(
        "too many files with the same received name".into(),
    ))
}

async fn copy_received_file_exclusively(source: &Path, destination: &Path) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut input = tokio::fs::File::open(source).await?;
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .await?;
    let result = async {
        tokio::io::copy(&mut input, &mut output).await?;
        output.flush().await?;
        output.sync_all().await
    }
    .await;
    drop(output);
    if result.is_err() {
        let _ = tokio::fs::remove_file(destination).await;
    }
    result
}

pub fn unique_received_name(existing: &HashSet<String>, candidate: &str) -> String {
    tailsend_protocol::filename::generate_unique_filename(existing, candidate)
}

pub fn pick_file_requests(app: &AppHandle) -> Result<Vec<FileRequest>, String> {
    let paths = app
        .dialog()
        .file()
        .set_title("Choose files to send")
        .set_picker_mode(PickerMode::Document)
        .set_file_access_mode(FileAccessMode::Copy)
        .blocking_pick_files();
    let Some(paths) = paths else {
        return Ok(Vec::new());
    };

    paths
        .into_iter()
        .enumerate()
        .map(|(index, path)| {
            let resolved_name = app.path().file_name(&path.to_string());
            let name = picker_file_name(&path, index, resolved_name.as_deref());
            let mut options = OpenOptions::new();
            options.read(true);
            let file = app
                .fs()
                .open(path.clone(), options)
                .map_err(|error| format!("cannot open selected file {path}: {error}"))?;
            let size = file
                .metadata()
                .map_err(|error| format!("cannot stat selected file {path}: {error}"))?
                .len();
            Ok(FileRequest {
                name,
                size,
                mime: None,
                path: path.to_string(),
            })
        })
        .collect()
}

pub fn picker_file_name(path: &FilePath, index: usize, resolved_name: Option<&str>) -> String {
    let candidate = resolved_name
        .and_then(normalize_picker_name)
        .or_else(|| {
            path.as_path()
                .and_then(Path::file_name)
                .and_then(|value| value.to_str())
                .and_then(normalize_picker_name)
        })
        .or_else(|| {
            let encoded = path.to_string();
            normalize_picker_name_with_scheme(&encoded, encoded.starts_with("content://"))
        });
    candidate
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("selected-file-{}", index + 1))
}

pub fn normalize_picker_name(value: &str) -> Option<String> {
    normalize_picker_name_with_scheme(value, false)
}

pub fn normalize_picker_name_with_scheme(value: &str, content_uri: bool) -> Option<String> {
    let decoded = percent_decode(value);
    let value = decoded.strip_prefix("raw:").unwrap_or(&decoded);
    let value = value.rsplit(['/', '\\']).next()?.split('?').next()?.trim();
    let value = if content_uri {
        value
            .rsplit_once(':')
            .map(|(_, name)| name)
            .unwrap_or(value)
    } else {
        value
    };
    (!value.is_empty()).then(|| value.to_owned())
}

pub fn percent_decode(value: &str) -> String {
    fn hex_digit(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_digit(bytes[index + 1]), hex_digit(bytes[index + 2]))
            {
                decoded.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

pub fn default_downloads_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        return PathBuf::from(home).join("Downloads").join("Ponlet");
    }
    PathBuf::from("Downloads").join("Ponlet")
}

pub fn app_storage_dir(app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "android")]
    {
        // Tauri's Android app_data_dir is Context.dataDir, not Context.filesDir.
        // Store documents under files/ so FileProvider can grant access to this folder only.
        return app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("Ponlet"))
            .join("files")
            .join("received");
    }
    #[cfg(target_os = "ios")]
    {
        return app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("Ponlet"))
            .join("received");
    }
    #[cfg(not(mobile))]
    {
        app.path()
            .download_dir()
            .unwrap_or_else(|_| default_downloads_dir())
            .join("Ponlet")
    }
}

pub fn received_path_allowed(items: &[UiReceivedItem], path: &str) -> bool {
    items.iter().any(|item| item.local_path_or_handle == path)
}

pub fn ponlet_open_received_impl(
    app: &AppHandle,
    received_items: &[UiReceivedItem],
    local_path_or_handle: &str,
) -> Result<(), String> {
    let allowed = received_path_allowed(received_items, local_path_or_handle);
    if !allowed {
        return Err("Received file is not registered by this session".to_string());
    }
    let path = PathBuf::from(local_path_or_handle);
    if !path.is_file() {
        return Err("Received file is no longer available".to_string());
    }
    #[cfg(mobile)]
    {
        use tauri_plugin_ponlet_platform::PonletPlatformExt;
        app.ponlet_platform().open_received(local_path_or_handle)
    }
    #[cfg(desktop)]
    app.opener()
        .open_path(local_path_or_handle, None::<String>)
        .map_err(|error| error.to_string())
}

pub async fn ponlet_save_text_impl(app: AppHandle, text: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_ponlet_platform::PonletPlatformExt;
        return app.ponlet_platform().save_text(&text);
    }
    #[cfg(not(target_os = "ios"))]
    {
        let path = app
            .dialog()
            .file()
            .set_title("Save message")
            .set_file_name("ponlet-message.txt")
            .set_picker_mode(PickerMode::Document)
            .blocking_save_file();
        let Some(path) = path else {
            return Ok(());
        };
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let mut file = app
            .fs()
            .open(path.clone(), options)
            .map_err(|error| format!("cannot open save destination {path}: {error}"))?;
        std::io::Write::write_all(&mut file, text.as_bytes())
            .map_err(|error| format!("cannot save message: {error}"))?;
        std::io::Write::flush(&mut file).map_err(|error| format!("cannot flush message: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ponlet-storage-{}", hex_id(new_id())));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn concurrent_received_files_keep_existing_contents_and_actual_names() {
        let directory = TestDirectory::new();
        let original = directory.0.join("photo.txt");
        tokio::fs::write(&original, b"previous receive")
            .await
            .unwrap();
        let count = 16;
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(count));
        let mut tasks = Vec::new();
        for index in 0..count {
            let mut sink = NativeFileSink::prepare(&directory.0, "photo.txt")
                .await
                .unwrap();
            let contents = format!("receive {index}");
            sink.write(contents.as_bytes()).await.unwrap();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                (Box::new(sink).commit().await.unwrap(), contents)
            }));
        }
        let mut paths = HashSet::new();
        for task in tasks {
            let (item, contents) = task.await.unwrap();
            let path = PathBuf::from(&item.local_path_or_handle);
            assert!(
                paths.insert(path.clone()),
                "two receives used the same path"
            );
            assert_eq!(path.file_name().unwrap().to_str().unwrap(), item.name);
            assert_eq!(tokio::fs::read_to_string(path).await.unwrap(), contents);
            assert_eq!(item.size, contents.len() as u64);
        }
        assert_eq!(
            tokio::fs::read(original).await.unwrap(),
            b"previous receive"
        );
        assert_eq!(std::fs::read_dir(&directory.0).unwrap().count(), count + 1);
    }

    #[tokio::test]
    async fn exclusive_copy_never_truncates_existing_destination() {
        let directory = TestDirectory::new();
        let source = directory.0.join("temporary.part");
        let destination = directory.0.join("received.txt");
        tokio::fs::write(&source, b"new receive").await.unwrap();
        tokio::fs::write(&destination, b"previous receive")
            .await
            .unwrap();
        let error = copy_received_file_exclusively(&source, &destination)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            tokio::fs::read(&destination).await.unwrap(),
            b"previous receive"
        );
        let available = directory.0.join("received (1).txt");
        copy_received_file_exclusively(&source, &available)
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(available).await.unwrap(), b"new receive");
        assert_eq!(tokio::fs::read(source).await.unwrap(), b"new receive");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn commit_preserves_directories_and_dangling_symlinks() {
        let directory = TestDirectory::new();
        let original = directory.0.join("photo.txt");
        let collision = directory.0.join("photo (1).txt");
        std::fs::create_dir(&original).unwrap();
        std::os::unix::fs::symlink(directory.0.join("missing"), &collision).unwrap();
        let mut sink = NativeFileSink::prepare(&directory.0, "photo.txt")
            .await
            .unwrap();
        sink.write(b"new receive").await.unwrap();
        let item = Box::new(sink).commit().await.unwrap();
        assert_eq!(item.name, "photo (2).txt");
        assert_eq!(
            tokio::fs::read(&item.local_path_or_handle).await.unwrap(),
            b"new receive"
        );
        assert!(original.is_dir());
        assert!(std::fs::symlink_metadata(collision).unwrap().is_symlink());
    }
}
