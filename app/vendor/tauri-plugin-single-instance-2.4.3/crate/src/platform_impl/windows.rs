// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT
// Modified by Huddol: race-safe receiver readiness, fail-closed IPC, and foreground handoff.

#[cfg(feature = "semver")]
use crate::semver_compat::semver_compat_string;

use crate::SingleInstanceCallback;
use serde::{Deserialize, Serialize};
use std::io;
use tauri::{
    plugin::{self, TauriPlugin},
    AppHandle, Manager, RunEvent, Runtime,
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, WAIT_OBJECT_0,
        WPARAM,
    },
    System::{
        DataExchange::COPYDATASTRUCT,
        LibraryLoader::GetModuleHandleW,
        Threading::{CreateEventW, CreateMutexW, ReleaseMutex, SetEvent, WaitForSingleObject},
    },
    UI::WindowsAndMessaging::{
        self as w32wm, AllowSetForegroundWindow, CreateWindowExW, DefWindowProcW, DestroyWindow,
        FindWindowW, GetWindowThreadProcessId, RegisterClassExW, SendMessageTimeoutW,
        CREATESTRUCTW, GWLP_USERDATA, GWL_STYLE, SMTO_ABORTIFHUNG, WINDOW_LONG_PTR_INDEX,
        WM_COPYDATA, WM_CREATE, WM_DESTROY, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_OVERLAPPED, WS_POPUP, WS_VISIBLE,
    },
};

const WMCOPYDATA_SINGLE_INSTANCE_DATA: usize = 1542;
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
const RECEIVER_READY_TIMEOUT_MS: u32 = 10_000;
const NOTIFICATION_TIMEOUT_MS: u32 = 5_000;

struct InstanceHandles {
    mutex: isize,
    ready: isize,
    window: isize,
}

#[derive(Deserialize, Serialize)]
struct Payload {
    args: Vec<String>,
    cwd: String,
}

struct UserData<R: Runtime> {
    app: AppHandle<R>,
    callback: Box<SingleInstanceCallback<R>>,
}

impl<R: Runtime> UserData<R> {
    unsafe fn from_hwnd_raw(hwnd: HWND) -> *mut Self {
        unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Self }
    }

    unsafe fn from_hwnd<'a>(hwnd: HWND) -> Option<&'a mut Self> {
        unsafe { Self::from_hwnd_raw(hwnd).as_mut() }
    }

    fn run_callback(&mut self, args: Vec<String>, cwd: String) {
        (self.callback)(&self.app, args, cwd)
    }
}

pub fn init<R: Runtime>(callback: Box<SingleInstanceCallback<R>>) -> TauriPlugin<R> {
    plugin::Builder::new("single-instance")
        .setup(|app, _api| {
            #[allow(unused_mut)]
            let mut id = app.config().identifier.clone();
            #[cfg(feature = "semver")]
            {
                id.push('_');
                id.push_str(semver_compat_string(&app.package_info().version).as_str());
            }

            let class_name = encode_wide(format!("{id}-sic"));
            let window_name = encode_wide(format!("{id}-siw"));
            let mutex_name = encode_wide(format!("{id}-sim"));
            let ready_name = encode_wide(format!("{id}-sir"));

            let hmutex =
                unsafe { CreateMutexW(std::ptr::null(), true.into(), mutex_name.as_ptr()) };
            if hmutex.is_null() {
                return Err(last_os_error("create single-instance mutex"));
            }
            let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
            let ready = unsafe {
                CreateEventW(
                    std::ptr::null(),
                    true.into(),
                    false.into(),
                    ready_name.as_ptr(),
                )
            };
            if ready.is_null() {
                unsafe { CloseHandle(hmutex) };
                return Err(last_os_error("create single-instance ready event"));
            }

            if already_exists {
                let result = notify_primary(&class_name, &window_name, ready);
                unsafe {
                    CloseHandle(ready);
                    CloseHandle(hmutex);
                }
                result?;
                app.cleanup_before_exit();
                std::process::exit(0);
            }

            let userdata = UserData {
                app: app.clone(),
                callback,
            };
            let userdata = Box::into_raw(Box::new(userdata));
            let hwnd = match create_event_target_window::<R>(&class_name, &window_name, userdata) {
                Ok(hwnd) => hwnd,
                Err(error) => {
                    unsafe {
                        drop(Box::from_raw(userdata));
                        CloseHandle(ready);
                        ReleaseMutex(hmutex);
                        CloseHandle(hmutex);
                    }
                    return Err(error);
                }
            };
            if unsafe { SetEvent(ready) } == 0 {
                unsafe {
                    DestroyWindow(hwnd);
                    CloseHandle(ready);
                    ReleaseMutex(hmutex);
                    CloseHandle(hmutex);
                }
                return Err(last_os_error("signal single-instance receiver readiness"));
            }

            app.manage(InstanceHandles {
                mutex: hmutex as _,
                ready: ready as _,
                window: hwnd as _,
            });
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                destroy(app);
            }
        })
        .build()
}

fn notify_primary(
    class_name: &[u16],
    window_name: &[u16],
    ready: windows_sys::Win32::Foundation::HANDLE,
) -> Result<(), Box<dyn std::error::Error>> {
    if unsafe { WaitForSingleObject(ready, RECEIVER_READY_TIMEOUT_MS) } != WAIT_OBJECT_0 {
        return Err(io::Error::other("single-instance receiver did not become ready").into());
    }

    let hwnd = unsafe { FindWindowW(class_name.as_ptr(), window_name.as_ptr()) };
    if hwnd.is_null() {
        return Err(io::Error::other("single-instance receiver is unavailable").into());
    }

    let mut primary_pid = 0;
    if unsafe { GetWindowThreadProcessId(hwnd, &mut primary_pid) } == 0 || primary_pid == 0 {
        return Err(last_os_error("resolve primary process"));
    }
    if unsafe { AllowSetForegroundWindow(primary_pid) } == 0 {
        tracing::warn!(
            os_error = ?io::Error::last_os_error().raw_os_error(),
            "single-instance foreground handoff was not granted"
        );
    }

    let payload = Payload {
        args: std::env::args().collect(),
        cwd: std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    };
    let mut data = serde_json::to_vec(&payload)?;
    if data.len() > MAX_PAYLOAD_BYTES {
        return Err(io::Error::other("single-instance payload exceeds limit").into());
    }
    data.push(0);
    let cb_data = u32::try_from(data.len())?;
    let cds = COPYDATASTRUCT {
        dwData: WMCOPYDATA_SINGLE_INSTANCE_DATA,
        cbData: cb_data,
        lpData: data.as_ptr() as _,
    };
    let mut callback_result = 0;
    let delivered = unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_COPYDATA,
            0,
            &cds as *const _ as LPARAM,
            SMTO_ABORTIFHUNG,
            NOTIFICATION_TIMEOUT_MS,
            &mut callback_result,
        )
    };
    if delivered == 0 || callback_result != 1 {
        return Err(last_os_error("deliver single-instance notification"));
    }
    Ok(())
}

fn last_os_error(context: &str) -> Box<dyn std::error::Error> {
    io::Error::new(
        io::ErrorKind::Other,
        format!("{context}: {}", io::Error::last_os_error()),
    )
    .into()
}

pub fn destroy<R: Runtime, M: Manager<R>>(manager: &M) {
    if let Some(handles) = manager.try_state::<InstanceHandles>() {
        unsafe {
            DestroyWindow(handles.window as _);
            CloseHandle(handles.ready as _);
            ReleaseMutex(handles.mutex as _);
            CloseHandle(handles.mutex as _);
        }
    }
}

unsafe extern "system" fn single_instance_window_proc<R: Runtime>(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CREATE => {
            let create_struct = unsafe { &*(lparam as *const CREATESTRUCTW) };
            let userdata = create_struct.lpCreateParams as *const UserData<R>;
            unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, userdata as _) };
            0
        }
        WM_COPYDATA => {
            let cds = unsafe { (lparam as *const COPYDATASTRUCT).as_ref() };
            let Some(cds) = cds else {
                return 0;
            };
            let payload_bytes = match usize::try_from(cds.cbData) {
                Ok(bytes) if bytes > 0 && bytes <= MAX_PAYLOAD_BYTES + 1 => bytes,
                _ => return 0,
            };
            if cds.dwData != WMCOPYDATA_SINGLE_INSTANCE_DATA || cds.lpData.is_null() {
                return 0;
            }
            let bytes =
                unsafe { std::slice::from_raw_parts(cds.lpData as *const u8, payload_bytes) };
            let bytes = bytes.strip_suffix(&[0]).unwrap_or(bytes);
            let Ok(payload) = serde_json::from_slice::<Payload>(bytes) else {
                return 0;
            };
            let Some(userdata) = (unsafe { UserData::<R>::from_hwnd(hwnd) }) else {
                return 0;
            };
            userdata.run_callback(payload.args, payload.cwd);
            1
        }
        WM_DESTROY => {
            let userdata = unsafe { UserData::<R>::from_hwnd_raw(hwnd) };
            if !userdata.is_null() {
                unsafe { drop(Box::from_raw(userdata)) };
                unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) };
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn create_event_target_window<R: Runtime>(
    class_name: &[u16],
    window_name: &[u16],
    userdata: *const UserData<R>,
) -> Result<HWND, Box<dyn std::error::Error>> {
    let module = unsafe { GetModuleHandleW(std::ptr::null()) };
    if module.is_null() {
        return Err(last_os_error("resolve single-instance module"));
    }
    let class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: 0,
        lpfnWndProc: Some(single_instance_window_proc::<R>),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: module,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        hbrBackground: std::ptr::null_mut(),
        lpszMenuName: std::ptr::null(),
        lpszClassName: class_name.as_ptr(),
        hIconSm: std::ptr::null_mut(),
    };
    if unsafe { RegisterClassExW(&class) } == 0 {
        return Err(last_os_error("register single-instance receiver class"));
    }
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW,
            class_name.as_ptr(),
            window_name.as_ptr(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            module,
            userdata as _,
        )
    };
    if hwnd.is_null() {
        return Err(last_os_error("create single-instance receiver window"));
    }
    unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, (WS_VISIBLE | WS_POPUP) as isize) };
    Ok(hwnd)
}

pub fn encode_wide(string: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    std::os::windows::prelude::OsStrExt::encode_wide(string.as_ref())
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(target_pointer_width = "32")]
#[allow(non_snake_case)]
unsafe fn SetWindowLongPtrW(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX, value: isize) -> isize {
    unsafe { w32wm::SetWindowLongW(hwnd, index, value as _) as _ }
}

#[cfg(target_pointer_width = "64")]
#[allow(non_snake_case)]
unsafe fn SetWindowLongPtrW(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX, value: isize) -> isize {
    unsafe { w32wm::SetWindowLongPtrW(hwnd, index, value) }
}

#[cfg(target_pointer_width = "32")]
#[allow(non_snake_case)]
unsafe fn GetWindowLongPtrW(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX) -> isize {
    unsafe { w32wm::GetWindowLongW(hwnd, index) as _ }
}

#[cfg(target_pointer_width = "64")]
#[allow(non_snake_case)]
unsafe fn GetWindowLongPtrW(hwnd: HWND, index: WINDOW_LONG_PTR_INDEX) -> isize {
    unsafe { w32wm::GetWindowLongPtrW(hwnd, index) }
}

#[cfg(test)]
mod tests {
    use super::Payload;

    #[test]
    fn payload_preserves_spaces_unicode_and_delimiters() {
        let payload = Payload {
            args: vec!["C:\\Program Files\\Huddol | 测试.exe".to_string()],
            cwd: "C:\\工作 目录".to_string(),
        };

        let encoded = serde_json::to_vec(&payload).unwrap();
        let decoded: Payload = serde_json::from_slice(&encoded).unwrap();

        assert_eq!(decoded.args, payload.args);
        assert_eq!(decoded.cwd, payload.cwd);
    }

    #[test]
    fn foreground_handoff_precedes_notification_without_synthetic_input() {
        let source = include_str!("windows.rs");
        let handoff = source
            .find("if unsafe { AllowSetForegroundWindow(primary_pid) }")
            .unwrap();
        let delivery = source.find("let delivered = unsafe").unwrap();

        assert!(handoff < delivery);
        assert!(!source.contains(concat!("Send", "Input")));
        assert!(!source.contains(concat!("keybd", "_event")));
    }
}
