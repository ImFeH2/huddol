use std::path::{Path, PathBuf};

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
}
