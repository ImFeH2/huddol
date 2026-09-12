use std::{
    fmt::Write as _,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Launcher {
    pub program: PathBuf,
    pub args: Vec<String>,
}

pub fn launcher(development: bool, project: &Path, resources: &Path) -> Launcher {
    if development {
        Launcher {
            program: "uv".into(),
            args: vec![
                "run".into(),
                "--project".into(),
                project.to_string_lossy().into_owned(),
                "python".into(),
                "-m".into(),
                "huddol".into(),
            ],
        }
    } else {
        Launcher {
            program: resources.join(if cfg!(windows) {
                "core/huddol.exe"
            } else {
                "core/huddol"
            }),
            args: Vec::new(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Ready {
    pub port: u16,
    pub token: String,
}

pub fn parse_ready(line: &str) -> Result<Ready, String> {
    let message: Value =
        serde_json::from_str(line).map_err(|error| format!("Invalid ready line: {error}"))?;
    if message.get("type").and_then(Value::as_str) != Some("ready") {
        return Err("Invalid ready line: type is not ready".to_string());
    }
    let port = message
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .ok_or("Invalid ready line: missing port")?;
    let token = message
        .get("token")
        .and_then(Value::as_str)
        .ok_or("Invalid ready line: missing token")?
        .to_string();
    Ok(Ready { port, token })
}

pub fn window_url(outcome: Result<&Ready, &str>) -> String {
    match outcome {
        Ok(ready) => format!(
            "index.html?ws=ws://127.0.0.1:{}/ws&token={}",
            ready.port,
            url_encode(&ready.token)
        ),
        Err(message) => format!("index.html?error={}", url_encode(message)),
    }
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

struct Kernel(Mutex<Option<Child>>);

fn spawn_kernel(launcher: Launcher) -> Result<(Child, Ready), String> {
    let mut command = Command::new(&launcher.program);
    command
        .args(&launcher.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Huddol: {error}"))?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut lines = BufReader::new(stdout).lines();
        let _ = sender.send(lines.next().and_then(Result::ok));
        for _ in lines {}
    });
    let ready = match receiver.recv_timeout(READY_TIMEOUT) {
        Ok(Some(line)) => parse_ready(&line),
        Ok(None) => Err("Huddol exited before it was ready".to_string()),
        Err(_) => Err("Huddol did not start within 30 seconds".to_string()),
    };
    match ready {
        Ok(ready) => Ok((child, ready)),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}

fn shutdown_kernel(child: &mut Child) {
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"{\"method\":\"system.shutdown\"}\n");
    }
    let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../core");
            let launcher = launcher(tauri::is_dev(), &project, &app.path().resource_dir()?);
            let (child, url) = match spawn_kernel(launcher) {
                Ok((child, ready)) => (Some(child), window_url(Ok(&ready))),
                Err(error) => (None, window_url(Err(&error))),
            };
            app.manage(Kernel(Mutex::new(child)));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.into()))
                .title("Huddol")
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let kernel = app.state::<Kernel>();
                if let Some(child) = kernel.0.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                    shutdown_kernel(child);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_launcher_runs_the_core_project_with_uv() {
        let launcher = launcher(true, Path::new("repo/core"), Path::new("resources"));
        assert_eq!(launcher.program, Path::new("uv"));
        assert_eq!(
            launcher.args,
            ["run", "--project", "repo/core", "python", "-m", "huddol"]
        );
    }

    #[test]
    fn bundled_launcher_runs_the_packaged_kernel() {
        let launcher = launcher(false, Path::new("repo/core"), Path::new("resources"));
        let expected = if cfg!(windows) {
            "core/huddol.exe"
        } else {
            "core/huddol"
        };
        assert_eq!(launcher.program, Path::new("resources").join(expected));
        assert!(launcher.args.is_empty());
    }

    #[test]
    fn parses_a_valid_ready_line() {
        let ready = parse_ready(
            r#"{"type":"ready","port":4567,"token":"abc-_","url":"http://127.0.0.1:4567/?token=abc-_"}"#,
        )
        .unwrap();
        assert_eq!(
            ready,
            Ready {
                port: 4567,
                token: "abc-_".to_string()
            }
        );
    }

    #[test]
    fn rejects_ready_lines_with_missing_fields() {
        assert_eq!(
            parse_ready(r#"{"type":"ready","token":"abc"}"#).unwrap_err(),
            "Invalid ready line: missing port"
        );
        assert_eq!(
            parse_ready(r#"{"type":"ready","port":1}"#).unwrap_err(),
            "Invalid ready line: missing token"
        );
        assert_eq!(
            parse_ready(r#"{"type":"log","port":1,"token":"abc"}"#).unwrap_err(),
            "Invalid ready line: type is not ready"
        );
    }

    #[test]
    fn rejects_non_json_ready_lines() {
        assert!(
            parse_ready("Traceback (most recent call last)")
                .unwrap_err()
                .starts_with("Invalid ready line:")
        );
    }

    #[test]
    fn builds_the_window_url_from_the_ready_line() {
        let ready = Ready {
            port: 4567,
            token: "abc-_".to_string(),
        };
        assert_eq!(
            window_url(Ok(&ready)),
            "index.html?ws=ws://127.0.0.1:4567/ws&token=abc-_"
        );
    }

    #[test]
    fn builds_an_encoded_error_url_on_failure() {
        assert_eq!(
            window_url(Err(
                "Failed to start Huddol: No such file (os error 2) &x=1"
            )),
            "index.html?error=Failed%20to%20start%20Huddol%3A%20No%20such%20file%20%28os%20error%202%29%20%26x%3D1"
        );
    }

    #[test]
    fn app_url_with_query_resolves_under_both_base_urls() {
        let path = window_url(Err("boom"));
        let dev = tauri::Url::parse("http://localhost:1420")
            .unwrap()
            .join(&path)
            .unwrap();
        let bundled = tauri::Url::parse("tauri://localhost")
            .unwrap()
            .join(&path)
            .unwrap();
        assert_eq!(dev.as_str(), "http://localhost:1420/index.html?error=boom");
        assert_eq!(bundled.as_str(), "tauri://localhost/index.html?error=boom");
    }
}
