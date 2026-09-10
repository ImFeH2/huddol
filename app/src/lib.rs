mod bridge_diagnostics;
mod huddol;
mod single_instance;
mod startup;

use huddol::HuddolProcess;
use serde_json::Value;
use single_instance::{ActivationState, activate_main_window};
use tauri::{Manager, ipc::Channel};

fn validate_frontend_message(message: &Value) -> Result<(), String> {
    if message
        .get("method")
        .and_then(Value::as_str)
        .is_some_and(|method| method.starts_with("system."))
    {
        return Err("Internal Huddol method".to_string());
    }
    Ok(())
}

#[tauri::command]
fn send(huddol: tauri::State<'_, HuddolProcess>, message: Value) -> Result<(), String> {
    validate_frontend_message(&message)?;
    huddol.send(message)
}

#[tauri::command]
fn subscribe(
    huddol: tauri::State<'_, HuddolProcess>,
    channel: Channel<Value>,
) -> Result<(), String> {
    huddol.subscribe(channel)
}

pub fn run() {
    let builder = tauri::Builder::default()
        .manage(ActivationState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            app.state::<ActivationState>().request(app);
        }));
    let app = builder
        .plugin(tauri_plugin_shell::init())
        .manage(HuddolProcess::default())
        .invoke_handler(tauri::generate_handler![send, subscribe])
        .setup(|app| {
            if let Err(error) = app.state::<HuddolProcess>().start(app.handle()) {
                app.state::<HuddolProcess>()
                    .set_startup_error(error.to_string());
            }

            // Create the window hidden so the first show can preserve the existing foreground
            // application. With `focus: false`, Tauri uses a non-activating first show on Windows.
            let main_window = app
                .get_webview_window("main")
                .ok_or_else(|| std::io::Error::other("main window is unavailable"))?;
            if app.state::<ActivationState>().finish_startup() {
                activate_main_window(app.handle());
            } else {
                main_window.show()?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app_handle.state::<HuddolProcess>().stop();
        }
    });
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::validate_frontend_message;

    #[test]
    fn reserves_internal_huddol_methods() {
        assert!(validate_frontend_message(&json!({"method": "organization.get"})).is_ok());
        assert_eq!(
            validate_frontend_message(&json!({"method": "system.shutdown"})).unwrap_err(),
            "Internal Huddol method"
        );
    }

    #[test]
    fn single_instance_is_the_first_application_plugin() {
        let source = include_str!("lib.rs");
        let single_instance = source
            .find(".plugin(tauri_plugin_single_instance::init")
            .unwrap();
        let shell = source.find(".plugin(tauri_plugin_shell::init").unwrap();

        assert!(single_instance < shell);
    }

    #[test]
    fn startup_windows_are_shown_without_activation() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window: tauri::utils::config::WindowConfig =
            serde_json::from_value(config["app"]["windows"][0].clone()).unwrap();

        assert!(
            !window.visible,
            "the window must be created hidden before its first show"
        );
        assert!(!window.focus, "the window must not activate");
        assert!(
            window.focusable,
            "the window must remain activatable by a Human click"
        );
        assert!(!window.always_on_top, "the window must not be topmost");
        assert!(!window.maximized, "the window must not start maximized");
        assert!(
            !window.skip_taskbar,
            "the window must appear in the taskbar"
        );
    }
}
