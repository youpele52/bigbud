//! Which per-account durable root a guard elects.
//!
//! `Standard` is the fixed `~/Library/Application Support/bigbud/computer-use`
//! suffix shared by every packaged installation (cross-profile election).
//! `Development` exists only in debug builds, so a release (packaged) guard can
//! never be redirected. The local dev app passes `<BIGBUD_HOME>/dev/computer-use`
//! so it never contends with, or writes into, an installed app's root. Either
//! layout is walked with the same no-follow ownership/mode/ACL checks; the
//! development path must lie strictly below the account database home.
use crate::native_fs::invalid;
use std::{ffi::CString, io};

#[cfg(debug_assertions)]
use crate::native_fs::descriptor::absolute_components;
#[cfg(debug_assertions)]
use std::path::{Path, PathBuf};

/// The private leaf both layouts end in.
pub(super) const ROOT_LEAF: &str = "computer-use";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootLayout {
    Standard,
    #[cfg(debug_assertions)]
    Development(PathBuf),
}

impl RootLayout {
    /// Debug builds only. Refuses relative, aliased (`.`/`..`/`//`) or
    /// unbounded paths and any leaf other than `computer-use`; the home prefix
    /// is checked against the account database at acquisition.
    #[cfg(debug_assertions)]
    pub fn development(path: &Path) -> io::Result<Self> {
        let components = absolute_components(path)?;
        if components.last().map(|leaf| leaf.as_bytes()) != Some(ROOT_LEAF.as_bytes()) {
            return Err(invalid());
        }
        Ok(Self::Development(path.to_path_buf()))
    }

    /// Components below `home`, in creation order; only the last is private.
    #[cfg_attr(not(debug_assertions), allow(unused_variables))]
    pub(super) fn suffix(&self, home: &[CString]) -> io::Result<Vec<CString>> {
        match self {
            Self::Standard => crate::guard::paths::MACOS_ROOT_COMPONENTS
                .iter()
                .map(|name| CString::new(*name).map_err(|_| invalid()))
                .collect(),
            #[cfg(debug_assertions)]
            Self::Development(path) => {
                let all = absolute_components(path)?;
                // Strictly below the account home, never the home itself.
                if all.len() <= home.len() || all.get(..home.len()) != Some(home) {
                    return Err(invalid());
                }
                Ok(all.get(home.len()..).ok_or_else(invalid)?.to_vec())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_fs::descriptor::absolute_components as components;
    use std::path::Path;

    fn home() -> Vec<CString> {
        components(Path::new("/Users/fixture")).unwrap()
    }

    #[test]
    fn standard_layout_is_the_fixed_library_suffix() {
        let suffix = RootLayout::Standard.suffix(&home()).unwrap();
        let names: Vec<_> = suffix.iter().map(|n| n.to_str().unwrap()).collect();
        assert_eq!(
            names,
            ["Library", "Application Support", "bigbud", "computer-use"]
        );
    }

    #[test]
    fn development_layout_must_be_below_home_and_end_in_the_leaf() {
        let dev =
            RootLayout::development(Path::new("/Users/fixture/.bigbud/dev/computer-use")).unwrap();
        let names: Vec<_> = dev
            .suffix(&home())
            .unwrap()
            .into_iter()
            .map(|n| n.into_string().unwrap())
            .collect();
        assert_eq!(names, [".bigbud", "dev", "computer-use"]);

        for bad in [
            "relative/computer-use",
            "/Users/fixture/.bigbud/dev/other",
            "/Users/fixture/../fixture/computer-use",
            "/Users/fixture/./computer-use",
            "/Users/fixture//computer-use",
        ] {
            assert!(RootLayout::development(Path::new(bad)).is_err(), "{bad}");
        }
        // Outside, or equal to, the account home is refused at acquisition.
        for outside in ["/tmp/computer-use", "/Users/other/computer-use"] {
            let layout = RootLayout::development(Path::new(outside)).unwrap();
            assert!(layout.suffix(&home()).is_err(), "{outside}");
        }
        let short = components(Path::new("/Users/fixture/computer-use")).unwrap();
        let layout = RootLayout::development(Path::new("/Users/fixture/computer-use")).unwrap();
        assert!(layout.suffix(&short).is_err(), "home itself");
    }
}
