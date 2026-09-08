use std::process::Command;

#[test]
fn prints_banner_and_exits() {
    let output = Command::new(env!("CARGO_BIN_EXE_huddol-cli"))
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(output.stdout, b"Huddol CLI\n");
    assert!(output.stderr.is_empty());
}
