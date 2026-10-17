#[cfg(windows)]
pub(super) fn own_fixture(root: &std::path::Path) -> std::io::Result<()> {
    use std::{io, process::Command};
    let user = Command::new("whoami.exe")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()?;
    let text = String::from_utf8(user.stdout).map_err(io::Error::other)?;
    let sid = text
        .split('"')
        .find(|field| field.starts_with("S-1-5-"))
        .ok_or_else(|| io::Error::other("fixture user unavailable"))?;
    let status = Command::new("icacls.exe")
        .arg(root)
        .args(["/setowner", &format!("*{sid}"), "/T", "/Q"])
        .status()?;
    if !user.status.success() || !status.success() {
        return Err(io::Error::other("fixture ownership failed"));
    }
    Ok(())
}
