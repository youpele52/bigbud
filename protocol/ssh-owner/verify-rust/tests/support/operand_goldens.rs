//! Normalized operand preimage goldens, split from `goldens.rs` for length.

use sha2::{Digest, Sha256};

use super::v1::Empty;
use super::v1::request::Operation;
use super::{PICKER_PATH, approve, goldens, list, operand_preimage, take};

#[test]
fn normalized_operand_goldens() {
    let mut values = goldens(include_str!("../../../v1.golden.operands"));
    for (name, operation) in [
        ("inspect", Operation::InspectTrust(Empty {})),
        ("connect", Operation::Connect(Empty {})),
        ("disconnect", Operation::Disconnect(Empty {})),
        ("approve", approve([0, 0xfe, 0xff])),
        ("approve_changed", approve([0, 0xfe, 0])),
        ("list_home_omitted", list(None)),
        ("list_home_empty", list(Some(""))),
        ("list_path", list(Some(PICKER_PATH))),
        ("list_changed", list(Some("~/café/資料/other"))),
        ("list_utf8_decomposed", list(Some("~/cafe\u{301}/資料"))),
        ("list_whitespace", list(Some("~/café/資料 "))),
    ] {
        let preimage = operand_preimage(operation);
        assert_eq!(
            preimage,
            take(&mut values, &format!("{name}.canonical")),
            "{name}"
        );
        assert_eq!(
            Sha256::digest(preimage).as_slice(),
            take(&mut values, &format!("{name}.sha256")),
            "{name}"
        );
    }
    assert!(values.is_empty(), "unused goldens: {values:?}");
}
