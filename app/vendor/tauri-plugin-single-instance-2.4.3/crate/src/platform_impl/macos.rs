// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT
// Modified by Huddol: OS-released ownership, framed acknowledged IPC, and fail-closed handling.

use std::{
    fs::{File, OpenOptions, Permissions},
    io::{Error, ErrorKind, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

#[cfg(feature = "semver")]
use crate::semver_compat::semver_compat_string;
use crate::SingleInstanceCallback;
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{self, TauriPlugin},
    AppHandle, Config, Manager, RunEvent, Runtime,
};

const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
const NOTIFICATION_TIMEOUT: Duration = Duration::from_secs(10);
const NOTIFICATION_RETRY_INTERVAL: Duration = Duration::from_millis(25);
const SOCKET_IO_TIMEOUT: Duration = Duration::from_secs(5);
const ACK: u8 = 1;

struct Ownership(File);

#[derive(Deserialize, Serialize)]
struct Payload {
    args: Vec<String>,
    cwd: String,
}

pub fn init<R: Runtime>(callback: Box<SingleInstanceCallback<R>>) -> TauriPlugin<R> {
    plugin::Builder::new("single-instance")
        .setup(|app, _api| {
            let socket = socket_path(app.config(), app.package_info());
            let lock = lock_path(app.config(), app.package_info());
            match acquire_ownership(&lock)? {
                Some(ownership) => {
                    socket_cleanup(&socket)?;
                    let listener = UnixListener::bind(&socket)?;
                    std::fs::set_permissions(&socket, Permissions::from_mode(0o600))?;
                    app.manage(ownership);
                    listen_for_other_instances(listener, app.clone(), callback);
                    Ok(())
                }
                None => {
                    notify_primary_bounded(&socket)?;
                    app.cleanup_before_exit();
                    std::process::exit(0);
                }
            }
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                destroy(app);
            }
        })
        .build()
}

pub fn destroy<R: Runtime, M: Manager<R>>(manager: &M) {
    if manager.try_state::<Ownership>().is_some() {
        let _ = socket_cleanup(&socket_path(manager.config(), manager.package_info()));
    }
}

fn identity(config: &Config, _package_info: &tauri::PackageInfo) -> String {
    let identifier = config.identifier.replace(['.', '-'].as_ref(), "_");
    #[cfg(feature = "semver")]
    let identifier = format!(
        "{identifier}_{}",
        semver_compat_string(&_package_info.version),
    );
    identifier
}

fn socket_path(config: &Config, package_info: &tauri::PackageInfo) -> PathBuf {
    PathBuf::from(format!("/tmp/{}_si.sock", identity(config, package_info)))
}

fn lock_path(config: &Config, package_info: &tauri::PackageInfo) -> PathBuf {
    PathBuf::from(format!("/tmp/{}_si.lock", identity(config, package_info)))
}

fn acquire_ownership(path: &Path) -> Result<Option<Ownership>, Error> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(Ownership(file)));
    }
    let error = Error::last_os_error();
    if error
        .raw_os_error()
        .is_some_and(|code| code == libc::EWOULDBLOCK || code == libc::EAGAIN)
    {
        Ok(None)
    } else {
        Err(error)
    }
}

fn socket_cleanup(socket: &Path) -> Result<(), Error> {
    match std::fs::remove_file(socket) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn notify_primary_bounded(socket: &Path) -> Result<(), Error> {
    let deadline = Instant::now() + NOTIFICATION_TIMEOUT;
    loop {
        match notify_singleton(socket) {
            Ok(()) => return Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::NotFound | ErrorKind::ConnectionRefused
                ) && Instant::now() < deadline =>
            {
                thread::sleep(NOTIFICATION_RETRY_INTERVAL);
            }
            Err(error) => return Err(error),
        }
    }
}

fn notify_singleton(socket: &Path) -> Result<(), Error> {
    let mut stream = UnixStream::connect(socket)?;
    configure_stream(&stream)?;
    let payload = Payload {
        args: std::env::args().collect(),
        cwd: std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    };
    write_payload(&mut stream, &payload)?;
    let mut ack = [0];
    stream.read_exact(&mut ack)?;
    if ack != [ACK] {
        return Err(Error::other("single-instance acknowledgement rejected"));
    }
    Ok(())
}

fn configure_stream(stream: &UnixStream) -> Result<(), Error> {
    stream.set_read_timeout(Some(SOCKET_IO_TIMEOUT))?;
    stream.set_write_timeout(Some(SOCKET_IO_TIMEOUT))
}

fn write_payload(stream: &mut UnixStream, payload: &Payload) -> Result<(), Error> {
    let encoded = serde_json::to_vec(payload).map_err(Error::other)?;
    if encoded.len() > MAX_PAYLOAD_BYTES {
        return Err(Error::other("single-instance payload exceeds limit"));
    }
    let length = u32::try_from(encoded.len())
        .map_err(Error::other)?
        .to_be_bytes();
    stream.write_all(&length)?;
    stream.write_all(&encoded)?;
    stream.flush()
}

fn read_payload(stream: &mut UnixStream) -> Result<Payload, Error> {
    let mut length = [0; 4];
    stream.read_exact(&mut length)?;
    let length = usize::try_from(u32::from_be_bytes(length)).map_err(Error::other)?;
    if length == 0 || length > MAX_PAYLOAD_BYTES {
        return Err(Error::other("single-instance payload length is invalid"));
    }
    let mut encoded = vec![0; length];
    stream.read_exact(&mut encoded)?;
    serde_json::from_slice(&encoded).map_err(Error::other)
}

fn listen_for_other_instances<R: Runtime>(
    listener: UnixListener,
    app: AppHandle<R>,
    mut callback: Box<SingleInstanceCallback<R>>,
) {
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                break;
            };
            if configure_stream(&stream).is_err() {
                continue;
            }
            let Ok(payload) = read_payload(&mut stream) else {
                continue;
            };
            callback(app.app_handle(), payload.args, payload.cwd);
            let _ = stream.write_all(&[ACK]);
            let _ = stream.flush();
        }
    });
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::{fs::PermissionsExt, net::UnixStream},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        acquire_ownership, configure_stream, read_payload, write_payload, Payload,
        MAX_PAYLOAD_BYTES,
    };

    #[test]
    fn ownership_is_exclusive_and_released_on_drop() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("huddol-single-instance-{nonce}.lock"));

        let owner = acquire_ownership(&path).unwrap().unwrap();
        assert!(acquire_ownership(&path).unwrap().is_none());
        drop(owner);
        assert!(acquire_ownership(&path).unwrap().is_some());
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn framed_payload_round_trips() {
        let (mut sender, mut receiver) = UnixStream::pair().unwrap();
        configure_stream(&sender).unwrap();
        configure_stream(&receiver).unwrap();
        let payload = Payload {
            args: vec!["Huddol 测试".to_string()],
            cwd: "/tmp/space path".to_string(),
        };

        write_payload(&mut sender, &payload).unwrap();
        let decoded = read_payload(&mut receiver).unwrap();

        assert_eq!(decoded.args, payload.args);
        assert_eq!(decoded.cwd, payload.cwd);
    }

    #[test]
    fn oversized_payload_is_rejected_before_write() {
        let (mut sender, _receiver) = UnixStream::pair().unwrap();
        let payload = Payload {
            args: vec!["x".repeat(MAX_PAYLOAD_BYTES)],
            cwd: String::new(),
        };

        assert!(write_payload(&mut sender, &payload).is_err());
    }
}
