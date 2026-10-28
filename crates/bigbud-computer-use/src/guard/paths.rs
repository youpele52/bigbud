use std::path::{Path, PathBuf};

pub(super) const MACOS_ROOT_COMPONENTS: [&str; 4] =
    ["Library", "Application Support", "bigbud", "computer-use"];

#[derive(Debug, Clone, Copy)]
pub enum UserPlatform {
    MacOs,
    Windows,
    Linux,
}
/// Path-layout model only: these values grant no ownership or launch authority.
/// macOS DurableRoot separately derives home from the OS account database.
/// No baseDir, channel or profile participates in authority-root selection.
pub struct RootEnvironment<'a> {
    pub home: Option<&'a Path>,
    pub local_app_data: Option<&'a Path>,
    pub xdg_state_home: Option<&'a Path>,
}
fn absolute(path: Option<&Path>) -> Option<&Path> {
    path.filter(|path| path.is_absolute())
}
pub fn resolve_root(platform: UserPlatform, environment: RootEnvironment<'_>) -> Option<PathBuf> {
    match platform {
        UserPlatform::MacOs => Some(
            absolute(environment.home)?.join(MACOS_ROOT_COMPONENTS.iter().collect::<PathBuf>()),
        ),
        UserPlatform::Windows => {
            Some(absolute(environment.local_app_data)?.join("bigbud/computer-use"))
        }
        UserPlatform::Linux => {
            // A supplied relative XDG root is invalid, not permission to switch
            // safety roots silently. The fallback applies only when absent.
            let base = match environment.xdg_state_home {
                Some(path) => absolute(Some(path))?.to_path_buf(),
                None => absolute(environment.home)?.join(".local/state"),
            };
            Some(base.join("bigbud/computer-use"))
        }
    }
}
