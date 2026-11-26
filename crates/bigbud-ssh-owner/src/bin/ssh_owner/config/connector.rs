//! The only admitted `ProxyCommand` forms: `nc %h %p` or an absolute path to a
//! file named `nc` with exactly those operands. The owner never passes this
//! text to OpenSSH or a shell; it records the program and launches the
//! qualified image itself with structured argv. Shell syntax, wrappers, extra
//! flags, other programs and other expansions are unsupported policy.

use super::{ErrorCode, UNSUPPORTED};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ConnectorProgram {
    /// Resolved on the initiating profile's approved absolute PATH entries.
    Bare,
    Absolute(PathBuf),
}

impl ConnectorProgram {
    /// `Ok(None)` is the explicit `none` value, which keeps the route direct.
    pub(super) fn parse(value: &str) -> Result<Option<Self>, ErrorCode> {
        if value.eq_ignore_ascii_case("none") {
            return Ok(None);
        }
        // Single ASCII spaces or tabs only; any quoting, operator, variable or
        // redirection is outside the admitted grammar, not something to parse.
        let mut tokens = value.split([' ', '\t']).filter(|token| !token.is_empty());
        let (Some(program), Some("%h"), Some("%p"), None) =
            (tokens.next(), tokens.next(), tokens.next(), tokens.next())
        else {
            return Err(UNSUPPORTED);
        };
        if program == "nc" {
            return Ok(Some(Self::Bare));
        }
        let path = Path::new(program);
        let literal = program.len() <= 255
            && program.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-')
            })
            && path.is_absolute()
            && path.file_name().is_some_and(|name| name == "nc")
            && path
                .components()
                .all(|part| matches!(part, Component::RootDir | Component::Normal(_)));
        if literal {
            Ok(Some(Self::Absolute(path.to_path_buf())))
        } else {
            Err(UNSUPPORTED)
        }
    }

    pub(super) fn descriptor_operand(&self) -> &[u8] {
        match self {
            Self::Bare => b"nc",
            Self::Absolute(path) => path.as_os_str().as_encoded_bytes(),
        }
    }
}

#[cfg(test)]
#[test]
fn admits_only_the_exact_nc_connector_forms() {
    assert_eq!(
        ConnectorProgram::parse("nc %h %p"),
        Ok(Some(ConnectorProgram::Bare))
    );
    assert_eq!(
        ConnectorProgram::parse("nc\t%h  %p"),
        Ok(Some(ConnectorProgram::Bare))
    );
    assert_eq!(ConnectorProgram::parse("NONE"), Ok(None));
    assert_eq!(
        ConnectorProgram::parse("/usr/bin/nc %h %p"),
        Ok(Some(ConnectorProgram::Absolute("/usr/bin/nc".into())))
    );
    for denied in [
        "nc %p %h",
        "nc -w 3 %h %p",
        "nc %h %p -v",
        "nc -X connect %h %p",
        "nc %h",
        "ncat %h %p",
        "netcat %h %p",
        "/usr/bin/ncat %h %p",
        "bin/nc %h %p",
        "./nc %h %p",
        "/usr/../usr/bin/nc %h %p",
        "/usr/bin/env nc %h %p",
        "exec nc %h %p",
        "sh -c 'nc %h %p'",
        "nc %h %p; touch /tmp/marker",
        "nc %h %p && true",
        "nc %h %p | cat",
        "nc %h %p > /dev/null",
        "nc $HOST %p",
        "nc `id` %p",
        "\"nc\" %h %p",
        "'/usr/bin/nc' %h %p",
        "nc %n %p",
        "nc %h %r",
        "nc %h 22",
        "/opt/nc dir/nc %h %p",
        "",
        "-",
    ] {
        assert_eq!(
            ConnectorProgram::parse(denied),
            Err(UNSUPPORTED),
            "{denied}"
        );
    }
}
