use super::{ErrorCode, Folder, Folders};

const MAX_PATH_BYTES: usize = 4096;
const MAX_ENTRIES: usize = 1000;
const MARKER: &str = "BIGBUD_REMOTE_FOLDERS_V1\0";
// Fixed remote POSIX command. The operand is always one quoted positional arg.
const SCRIPT: &str = r#"
CDPATH=
case "$1" in
  ""|"~") cd || exit 3 ;;
  "~/"*) cd "$HOME/${1#\~/}" || exit 3 ;;
  /*) cd "$1" || exit 3 ;;
  *) cd "./$1" || exit 3 ;;
esac
printf '%s\0%s\0%s\0' BIGBUD_REMOTE_FOLDERS_V1 "$HOME" "$PWD"
for entry in ./*; do
  [ -d "$entry" ] || continue
  if [ -e "$entry/.git" ]; then kind=g; else kind=d; fi
  printf '%s\t%s\0' "$kind" "${entry#./}"
done
"#;

pub(super) fn command(path: Option<&str>) -> Result<String, ErrorCode> {
    let path = path.unwrap_or("");
    if path.len() > MAX_PATH_BYTES || path.contains('\0') {
        return Err(ErrorCode::InvalidOperands);
    }
    Ok(format!("/bin/sh -c {} sh {}", quote(SCRIPT), quote(path)))
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(super) fn parse(bytes: &[u8], output_truncated: bool) -> Result<Folders, ErrorCode> {
    let invalid = ErrorCode::ListInvalidOutput;
    let offset = bytes
        .windows(MARKER.len())
        .position(|window| window == MARKER.as_bytes())
        .ok_or(invalid)?;
    let payload = bytes.get(offset + MARKER.len()..).ok_or(invalid)?;
    let mut fields = payload.split_inclusive(|&byte| byte == 0);
    let home = text_field(fields.next().ok_or(invalid)?)?;
    let path = text_field(fields.next().ok_or(invalid)?)?;
    if !path.starts_with('/') || (!home.is_empty() && !home.starts_with('/')) {
        return Err(invalid);
    }
    let mut entries = Vec::new();
    for raw in fields {
        if !raw.ends_with(b"\0") && output_truncated {
            break;
        }
        let (kind, name) = text_field(raw)?.split_once('\t').ok_or(invalid)?;
        if !matches!(kind, "g" | "d")
            || name.is_empty()
            || name.starts_with('.')
            || name.contains('/')
        {
            return Err(invalid);
        }
        entries.push((
            name.to_lowercase(),
            Folder {
                name: name.to_owned(),
                has_git: kind == "g",
            },
        ));
    }
    entries.sort_unstable_by(|(left_folded, left), (right_folded, right)| {
        left_folded
            .cmp(right_folded)
            .then_with(|| left.name.cmp(&right.name))
    });
    let truncated = output_truncated || entries.len() > MAX_ENTRIES;
    Ok(Folders {
        path: path.to_owned(),
        entries: entries
            .into_iter()
            .take(MAX_ENTRIES)
            .map(|(_, entry)| entry)
            .collect(),
        home_path: Some(if home.is_empty() { path } else { home }.to_owned()),
        truncated: Some(truncated),
    })
}

fn text_field(bytes: &[u8]) -> Result<&str, ErrorCode> {
    let bytes = bytes
        .strip_suffix(b"\0")
        .ok_or(ErrorCode::ListInvalidOutput)?;
    std::str::from_utf8(bytes).map_err(|_| ErrorCode::ListInvalidOutput)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_remote_path_as_one_operand() {
        let path = "-x; $(touch sentinel) 'quote'\nnext";
        assert!(
            command(Some(path))
                .expect("valid quoted path")
                .ends_with(" sh '-x; $(touch sentinel) '\\''quote'\\''\nnext'")
        );
        assert!(matches!(
            command(Some("bad\0path")),
            Err(ErrorCode::InvalidOperands)
        ));
    }

    #[test]
    fn reports_truncation_without_parsing_partial_fields() {
        let listing = format!("banner\n{MARKER}/home/test\0/work/a\n\0d\tZ\0g\tAlpha\0d\tpartial");
        assert!(matches!(
            parse(listing.as_bytes(), false),
            Err(ErrorCode::ListInvalidOutput)
        ));
        let output = parse(listing.as_bytes(), true).expect("bounded truncated listing");
        assert_eq!(output.path, "/work/a\n");
        assert_eq!(output.home_path.as_deref(), Some("/home/test"));
        assert_eq!(output.truncated, Some(true));
        assert_eq!(
            output
                .entries
                .iter()
                .map(|entry| (entry.name.as_str(), entry.has_git))
                .collect::<Vec<_>>(),
            [("Alpha", true), ("Z", false)]
        );
    }

    #[test]
    fn caps_entries() {
        let mut listing = format!("{MARKER}/home/test\0/work\0");
        for i in (0..=MAX_ENTRIES).rev() {
            listing.push_str(&format!("d\tdir{i:04}\0"));
        }
        let output = parse(listing.as_bytes(), false).expect("complete listing");
        assert_eq!(output.entries.len(), MAX_ENTRIES);
        assert_eq!(output.truncated, Some(true));
        assert_eq!(
            output.entries.last().map(|entry| entry.name.as_str()),
            Some("dir0999")
        );
    }
}
