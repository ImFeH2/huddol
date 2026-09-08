use std::{
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process,
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value, json};

const LOG_FILE_NAME: &str = "huddol-bridge.jsonl";
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
const BACKUP_COUNT: usize = 5;

pub struct BridgeDiagnostics {
    path: Option<PathBuf>,
    started_at: Instant,
    session_id: String,
    max_bytes: u64,
    backup_count: usize,
    lock: Mutex<()>,
}

impl Default for BridgeDiagnostics {
    fn default() -> Self {
        let started_unix_ms = unix_timestamp_ms();
        let diagnostics = Self {
            path: resolve_data_directory()
                .map(|directory| directory.join("logs").join(LOG_FILE_NAME)),
            started_at: Instant::now(),
            session_id: format!("{}-{started_unix_ms}", process::id()),
            max_bytes: MAX_LOG_BYTES,
            backup_count: BACKUP_COUNT,
            lock: Mutex::new(()),
        };
        diagnostics.record(
            "INFO",
            "bridge.diagnostics.configured",
            json!({
                "log_file": LOG_FILE_NAME,
                "max_bytes": MAX_LOG_BYTES,
                "backup_count": BACKUP_COUNT,
            }),
        );
        diagnostics
    }
}

impl BridgeDiagnostics {
    pub fn record(&self, level: &str, event: &str, fields: Value) {
        let Some(path) = self.path.as_ref() else {
            return;
        };
        let mut payload = Map::new();
        payload.insert("timestamp_unix_ms".into(), json!(unix_timestamp_ms()));
        payload.insert(
            "elapsed_ms".into(),
            json!(self.started_at.elapsed().as_millis()),
        );
        payload.insert("level".into(), json!(level));
        payload.insert("event".into(), json!(event));
        payload.insert("process_id".into(), json!(process::id()));
        payload.insert("bridge_session_id".into(), json!(self.session_id));
        if let Value::Object(fields) = fields {
            payload.extend(fields);
        }
        let mut encoded = match serde_json::to_vec(&Value::Object(payload)) {
            Ok(encoded) => encoded,
            Err(_) => return,
        };
        encoded.push(b'\n');
        let result = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("bridge diagnostic lock poisoned"))
            .and_then(|_guard| self.write_record(path, &encoded));
        if let Err(error) = result {
            eprintln!(
                "[Huddol] Bridge diagnostic logging unavailable: {:?}",
                error.kind()
            );
        }
    }

    fn write_record(&self, path: &Path, encoded: &[u8]) -> io::Result<()> {
        let directory = path
            .parent()
            .ok_or_else(|| io::Error::other("bridge log path has no parent"))?;
        let data_directory = directory
            .parent()
            .ok_or_else(|| io::Error::other("bridge data path has no parent"))?;
        fs::create_dir_all(data_directory)?;
        set_private_directory_permissions(data_directory)?;
        fs::create_dir_all(directory)?;
        set_private_directory_permissions(directory)?;
        let current_bytes = path.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        if current_bytes.saturating_add(encoded.len() as u64) > self.max_bytes {
            rotate(path, self.backup_count)?;
        }
        let mut file = open_private_append(path)?;
        file.write_all(encoded)?;
        file.flush()
    }

    #[cfg(test)]
    fn for_test(path: PathBuf, max_bytes: u64, backup_count: usize) -> Self {
        Self {
            path: Some(path),
            started_at: Instant::now(),
            session_id: format!("test-{}", unix_timestamp_ms()),
            max_bytes,
            backup_count,
            lock: Mutex::new(()),
        }
    }
}

pub fn os_error_code(detail: &str) -> Option<i64> {
    let (_, suffix) = detail.rsplit_once("(os error ")?;
    let (code, _) = suffix.split_once(')')?;
    code.parse().ok()
}

fn resolve_data_directory() -> Option<PathBuf> {
    if let Some(directory) = env::var_os("HUDDOL_DATA_DIR").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(directory));
    }
    #[cfg(windows)]
    let home = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"));
    #[cfg(not(windows))]
    let home = env::var_os("HOME");
    home.map(PathBuf::from).map(|path| path.join(".huddol"))
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn rotate(path: &Path, backup_count: usize) -> io::Result<()> {
    if backup_count == 0 {
        if path.exists() {
            fs::remove_file(path)?;
        }
        return Ok(());
    }
    for index in (1..=backup_count).rev() {
        let source = if index == 1 {
            path.to_path_buf()
        } else {
            backup_path(path, index - 1)
        };
        if !source.exists() {
            continue;
        }
        let destination = backup_path(path, index);
        if destination.exists() {
            fs::remove_file(&destination)?;
        }
        fs::rename(source, destination)?;
    }
    Ok(())
}

fn backup_path(path: &Path, index: usize) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_owned();
    value.push(format!(".{index}"));
    PathBuf::from(value)
}

fn open_private_append(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    set_private_file_permissions(path)?;
    Ok(file)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory(name: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "huddol-bridge-{name}-{}-{}",
            process::id(),
            unix_timestamp_ms()
        ))
    }

    #[test]
    fn writes_structured_rotating_bridge_logs() {
        let directory = temporary_directory("logging");
        let path = directory.join("logs").join(LOG_FILE_NAME);
        let diagnostics = BridgeDiagnostics::for_test(path.clone(), 500, 2);

        for index in 0..12 {
            diagnostics.record(
                "ERROR",
                "bridge.disconnected",
                json!({"reason": "pipe_error", "index": index}),
            );
        }

        let records = fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert!(!records.is_empty());
        assert_eq!(records.last().unwrap()["event"], "bridge.disconnected");
        assert_eq!(records.last().unwrap()["reason"], "pipe_error");
        assert!(backup_path(&path, 1).exists());
        assert!(backup_path(&path, 2).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(
                path.parent()
                    .unwrap()
                    .metadata()
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                directory.metadata().unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn extracts_only_numeric_os_error_codes() {
        assert_eq!(
            os_error_code("The pipe has been ended. (os error 109)"),
            Some(109)
        );
        assert_eq!(os_error_code("private transport detail"), None);
    }
}
