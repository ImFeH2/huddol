use std::sync::Mutex;

use crate::bridge_diagnostics::os_error_code;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

#[derive(Default)]
struct ActivationFlags {
    startup_ready: bool,
    activation_requested: bool,
}

#[derive(Default)]
pub struct ActivationState {
    flags: Mutex<ActivationFlags>,
}

impl ActivationState {
    fn latch_request(&self) {
        let mut flags = self.flags.lock().unwrap_or_else(|error| error.into_inner());
        flags.activation_requested = true;
    }

    pub fn request<R: Runtime>(&self, app: &AppHandle<R>) {
        self.latch_request();

        let app = app.clone();
        std::thread::spawn(move || {
            let scheduler = app.clone();
            if let Err(error) = scheduler.run_on_main_thread(move || {
                let drain = app.state::<ActivationState>().take_ready_activation();
                eprintln!("[Huddol] single_instance.activation_drain={drain}");
                if drain {
                    activate_main_window(&app);
                }
            }) {
                record_activation_failure("schedule", "runtime", &error.to_string());
            }
        });
    }

    pub fn finish_startup(&self) -> bool {
        let mut flags = self.flags.lock().unwrap_or_else(|error| error.into_inner());
        flags.startup_ready = true;
        std::mem::take(&mut flags.activation_requested)
    }

    fn take_ready_activation(&self) -> bool {
        let mut flags = self.flags.lock().unwrap_or_else(|error| error.into_inner());
        if !flags.startup_ready {
            return false;
        }
        std::mem::take(&mut flags.activation_requested)
    }
}

pub fn activate_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        record_activation_failure("window_lookup", "unavailable", "main window unavailable");
        return;
    };
    #[cfg(windows)]
    restore_and_activate_windows(&window);
    #[cfg(not(windows))]
    restore_and_activate(&window);
}

#[cfg(windows)]
fn restore_and_activate_windows<R: Runtime>(window: &WebviewWindow<R>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GA_ROOT, GetAncestor, IsIconic, IsWindow, SW_RESTORE, SW_SHOW, SetForegroundWindow,
        ShowWindow,
    };

    let webview_hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd.0,
        Err(error) => {
            record_activation_failure("window_lookup", "runtime", &error.to_string());
            return;
        }
    };
    let hwnd = unsafe { GetAncestor(webview_hwnd, GA_ROOT) };
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        record_activation_failure("window_lookup", "unavailable", "invalid native window");
        return;
    }
    if unsafe { IsIconic(hwnd) } != 0 {
        unsafe { ShowWindow(hwnd, SW_RESTORE) };
    }
    unsafe { ShowWindow(hwnd, SW_SHOW) };
    if unsafe { SetForegroundWindow(hwnd) } == 0 {
        record_activation_failure(
            "foreground",
            "os",
            &std::io::Error::last_os_error().to_string(),
        );
    }
}

#[cfg(any(not(windows), test))]
trait ActivatableWindow {
    type Error: std::fmt::Display;

    fn is_minimized(&self) -> Result<bool, Self::Error>;
    fn unminimize(&self) -> Result<(), Self::Error>;
    fn show(&self) -> Result<(), Self::Error>;
    fn foreground(&self) -> Result<(), String>;
}

#[cfg(not(windows))]
impl<R: Runtime> ActivatableWindow for WebviewWindow<R> {
    type Error = tauri::Error;

    fn is_minimized(&self) -> Result<bool, Self::Error> {
        self.is_minimized()
    }

    fn unminimize(&self) -> Result<(), Self::Error> {
        self.unminimize()
    }

    fn show(&self) -> Result<(), Self::Error> {
        self.show()
    }

    fn foreground(&self) -> Result<(), String> {
        self.set_focus().map_err(|error| error.to_string())
    }
}

#[cfg(any(not(windows), test))]
fn restore_and_activate<W: ActivatableWindow>(window: &W) {
    match window.is_minimized() {
        Ok(true) => {
            if let Err(error) = window.unminimize() {
                record_activation_failure("restore", "window_operation", &error.to_string());
            }
        }
        Ok(false) => {}
        Err(error) => {
            record_activation_failure("minimized_state", "window_state", &error.to_string())
        }
    }
    if let Err(error) = window.show() {
        record_activation_failure("show", "window_operation", &error.to_string());
    }
    if let Err(error) = window.foreground() {
        record_activation_failure("foreground", "os", &error);
    }
}

fn activation_failure_payload(stage: &str, category: &str, detail: &str) -> Value {
    json!({
        "level": "ERROR",
        "event": "single_instance.activation_failed",
        "stage": stage,
        "error_category": category,
        "os_error_code": os_error_code(detail),
    })
}

fn record_activation_failure(stage: &str, category: &str, detail: &str) {
    eprintln!(
        "[Huddol] {}",
        activation_failure_payload(stage, category, detail)
    );
}

#[cfg(test)]
mod tests {
    use std::{convert::Infallible, sync::Mutex};

    use super::{
        ActivatableWindow, ActivationState, activation_failure_payload, restore_and_activate,
    };

    struct TestWindow {
        minimized: bool,
        calls: Mutex<Vec<&'static str>>,
    }

    impl ActivatableWindow for TestWindow {
        type Error = Infallible;

        fn is_minimized(&self) -> Result<bool, Self::Error> {
            self.calls.lock().unwrap().push("is_minimized");
            Ok(self.minimized)
        }

        fn unminimize(&self) -> Result<(), Self::Error> {
            self.calls.lock().unwrap().push("unminimize");
            Ok(())
        }

        fn show(&self) -> Result<(), Self::Error> {
            self.calls.lock().unwrap().push("show");
            Ok(())
        }

        fn foreground(&self) -> Result<(), String> {
            self.calls.lock().unwrap().push("foreground");
            Ok(())
        }
    }

    #[test]
    fn startup_without_request_does_not_activate() {
        let state = ActivationState::default();

        assert!(!state.finish_startup());
        assert!(!state.take_ready_activation());
    }

    #[test]
    fn request_before_ready_is_latched_once() {
        let state = ActivationState::default();
        state.latch_request();

        assert!(!state.take_ready_activation());
        assert!(state.finish_startup());
        assert!(!state.take_ready_activation());
    }

    #[test]
    fn request_after_ready_is_drained_once() {
        let state = ActivationState::default();
        assert!(!state.finish_startup());
        state.latch_request();

        assert!(state.take_ready_activation());
        assert!(!state.take_ready_activation());
    }

    #[test]
    fn repeated_ready_requests_are_coalesced() {
        let state = ActivationState::default();
        assert!(!state.finish_startup());
        state.latch_request();
        state.latch_request();

        assert!(state.take_ready_activation());
        assert!(!state.take_ready_activation());
    }

    #[test]
    fn activation_failures_record_stable_stage_category_and_os_error() {
        let payload =
            activation_failure_payload("foreground", "os", "operation failed (os error 5)");

        assert_eq!(payload["event"], "single_instance.activation_failed");
        assert_eq!(payload["stage"], "foreground");
        assert_eq!(payload["error_category"], "os");
        assert_eq!(payload["os_error_code"], 5);
        assert!(payload.get("detail").is_none());
    }

    #[test]
    fn minimized_window_is_restored_before_activation() {
        let window = TestWindow {
            minimized: true,
            calls: Mutex::new(Vec::new()),
        };

        restore_and_activate(&window);

        assert_eq!(
            *window.calls.lock().unwrap(),
            ["is_minimized", "unminimize", "show", "foreground"]
        );
    }

    #[test]
    fn normal_window_is_not_unminimized() {
        let window = TestWindow {
            minimized: false,
            calls: Mutex::new(Vec::new()),
        };

        restore_and_activate(&window);

        assert_eq!(
            *window.calls.lock().unwrap(),
            ["is_minimized", "show", "foreground"]
        );
    }

    #[test]
    fn diagnostic_stages_are_frozen() {
        let source = include_str!("single_instance.rs");
        for stage in [
            "schedule",
            "window_lookup",
            "minimized_state",
            "restore",
            "show",
            "foreground",
        ] {
            assert!(source.contains(&format!("\"{stage}\"")));
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_foreground_path_does_not_call_tauri_focus() {
        let source = include_str!("single_instance.rs");
        let windows = source
            .split("fn restore_and_activate_windows")
            .nth(1)
            .unwrap();
        let windows = windows
            .split("#[cfg(any(not(windows), test))]")
            .next()
            .unwrap();

        assert!(windows.contains("SetForegroundWindow"));
        assert!(!windows.contains("set_focus"));
    }
}
