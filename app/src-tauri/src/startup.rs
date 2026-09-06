use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn check_legacy_configuration(path: &Path) -> Result<(), String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Cannot read legacy App configuration".to_owned()),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Cannot read legacy App configuration".to_owned())?;
    if value.get("kind").and_then(serde_json::Value::as_str) != Some("native") {
        return Err(format!(
            "Legacy backend selection requires attention. Remove {} to use this system's data. Existing WSL data will not be moved.",
            path.display()
        ));
    }
    Ok(())
}

pub struct Launcher {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub kind: &'static str,
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
            kind: "development_python",
        }
    } else {
        Launcher {
            program: resources.join(if cfg!(windows) {
                "core/huddol.exe"
            } else {
                "core/huddol"
            }),
            args: vec![],
            kind: "bundled_core",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_only_the_local_business_backend() {
        let project = Path::new("project/core");
        let resources = Path::new("resources");
        let development = launcher(true, project, resources);
        assert_eq!(development.program, Path::new("uv"));
        assert_eq!(development.args.last().unwrap(), "huddol");
        let bundled = launcher(false, project, resources);
        assert!(bundled.program.starts_with(resources.join("core")));
        assert!(bundled.args.is_empty());
    }

    #[test]
    fn does_not_silently_replace_legacy_wsl_data() {
        let directory = std::env::temp_dir().join(format!("huddol-startup-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("backend.json");
        fs::write(&path, r#"{"kind":"wsl","distribution":"Debian"}"#).unwrap();
        assert!(
            check_legacy_configuration(&path)
                .unwrap_err()
                .contains("Existing WSL data will not be moved")
        );
        fs::write(&path, r#"{"kind":"native"}"#).unwrap();
        assert!(check_legacy_configuration(&path).is_ok());
        fs::remove_dir_all(directory).unwrap();
    }
}
