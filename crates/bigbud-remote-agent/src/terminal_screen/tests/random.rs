//! Deterministic randomized streams built from common sequences: chunk-split invariance, no
//! panics, bounded held state, and zero-diff round trips including later output.

use super::super::scanner::TAIL_CAP;
use super::super::{ScreenModel, SnapshotLimits};
use super::corpus::restore_from_snapshot;
use super::dump::{diff, dump};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound.max(1)
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        let index = usize::try_from(self.below(items.len() as u64)).unwrap_or(0);
        items.get(index).copied().unwrap_or("")
    }
}

fn token(rng: &mut Rng, cols: u16, rows: u16, unmodelled: bool) -> String {
    let words = [
        "hello", "bigbud", "a", "──", "中文", "😀", "e\u{301}", "     ", "x",
    ];
    match rng.below(24) {
        0..=5 => rng.pick(&words).to_owned(),
        6 => "\r\n".to_owned(),
        7 => rng.pick(&["\r", "\n", "\x08", "\t"]).to_owned(),
        8 => format!(
            "\x1b[{}m",
            rng.pick(&[
                "0",
                "1",
                "2",
                "3",
                "4",
                "7",
                "22",
                "31",
                "42",
                "38;5;208",
                "48;2;1;2;3",
                "9",
                "29",
                "1;2"
            ])
        ),
        9 => format!(
            "\x1b[{};{}H",
            rng.below(u64::from(rows) + 2),
            rng.below(u64::from(cols) + 2)
        ),
        10 => format!("\x1b[{}{}", rng.below(3), rng.pick(&["J", "K"])),
        11 => format!(
            "\x1b[{}{}",
            rng.below(4),
            rng.pick(&["A", "B", "C", "D", "L", "M", "@", "P", "X", "S", "T"])
        ),
        12 => {
            let top = rng.below(u64::from(rows)) + 1;
            format!("\x1b[{top};{}r", top + rng.below(u64::from(rows)))
        }
        13 => rng
            .pick(&[
                "\x1bM", "\x1b7", "\x1b8", "\x1b[s", "\x1b[u", "\x1bD", "\x1bE", "\x1bH",
                "\x1b[3g", "\x1b[g", "\x1b[2I", "\x1b[Z",
            ])
            .to_owned(),
        14 => rng
            .pick(&[
                "\x1b[?1049h",
                "\x1b[?1049l",
                "\x1b[?47h",
                "\x1b[?47l",
                "\x1b[?1047h",
                "\x1b[?1047l",
            ])
            .to_owned(),
        15 => rng
            .pick(&["\x1b(0", "\x1b(B", "\x1b)0", "\x0e", "\x0f"])
            .to_owned(),
        16 => rng
            .pick(&[
                "\x1b]8;;https://e.x\x1b\\",
                "\x1b]8;;\x07",
                "\x1b]0;title\x07",
            ])
            .to_owned(),
        17 => rng
            .pick(&[
                "\x1b[>1u",
                "\x1b[<u",
                "\x1b[=3;1u",
                "\x1b[?1004h",
                "\x1b[?2026h",
                "\x1b[?2026l",
            ])
            .to_owned(),
        18 => rng
            .pick(&[
                "\x1b[?25l",
                "\x1b[?25h",
                "\x1b[?2004h",
                "\x1b[?1000h",
                "\x1b[?1006h",
                "\x1b[5 q",
                "\x1b=",
            ])
            .to_owned(),
        19 => "y".repeat(usize::from(cols) + 3),
        20 if unmodelled => rng.pick(&["\x1b[4h", "\x1b[?7l", "\x1b[?6h"]).to_owned(),
        20 => rng.pick(&["\x1b[4l", "\x1b[?7h", "\x1b[?6l"]).to_owned(),
        21 => rng
            .pick(&[
                "\x1b[4:3m",
                "\x1b[58;5;3m",
                "\x1b[38:2::9:8:7m",
                "\x1b[21m",
                "\x1b[24m",
            ])
            .to_owned(),
        // ED 3 between DECSC and DECRC makes xterm.js restore to a row below the screen,
        // which no snapshot can express; it is only exercised for chunk invariance.
        22 if unmodelled => rng
            .pick(&["\x1bc", "\x1b[3J", "\x1b[?5h", "\x1bP1$qm\x1b\\"])
            .to_owned(),
        22 => rng
            .pick(&["\x1bc", "\x1b[?5h", "\x1bP1$qm\x1b\\"])
            .to_owned(),
        _ => format!("{}", rng.below(1_000_000)),
    }
}

/// `unmodelled` adds origin mode, autowrap off, insert mode and ED 3: `vt100` keeps origin
/// per screen and implements neither autowrap off nor insert mode, so later output can
/// diverge without any visible difference at snapshot time (those rows are reported as
/// `unsupported_modes`).
pub(super) fn stream(seed: u64, cols: u16, rows: u16, length: usize, unmodelled: bool) -> Vec<u8> {
    let mut rng = Rng(seed | 1);
    let mut out = String::new();
    for _ in 0..length {
        out.push_str(&token(&mut rng, cols, rows, unmodelled));
    }
    out.into_bytes()
}

#[test]
fn random_streams_are_chunk_split_invariant() {
    for seed in 1..=60u64 {
        let (cols, rows) = (
            u16::try_from(10 + seed % 30).unwrap(),
            u16::try_from(3 + seed % 7).unwrap(),
        );
        let bytes = stream(seed, cols, rows, 400, true);
        let mut whole = ScreenModel::new(cols, rows, 50).unwrap();
        let _ = whole.feed(&bytes);
        let mut split = ScreenModel::new(cols, rows, 50).unwrap();
        let mut rng = Rng(seed.wrapping_mul(7919) | 1);
        let mut rest = bytes.as_slice();
        while !rest.is_empty() {
            let take = usize::try_from(rng.below(9) + 1).unwrap().min(rest.len());
            let (head, tail) = rest.split_at(take);
            let _ = split.feed(head);
            rest = tail;
        }
        assert!(diff(&dump(&whole), &dump(&split)).is_empty(), "seed {seed}");
        assert!(whole.scanner.held_bytes() <= 4 * TAIL_CAP, "seed {seed}");
    }
}

/// `BIGBUD_SCREEN_FUZZ_SEEDS` / `BIGBUD_SCREEN_FUZZ_TOKENS` widen the search locally.
fn setting(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

#[test]
fn random_streams_round_trip_and_continue_identically() {
    let seeds = setting("BIGBUD_SCREEN_FUZZ_SEEDS", 300);
    let tokens = usize::try_from(setting("BIGBUD_SCREEN_FUZZ_TOKENS", 250)).unwrap();
    let mut checked = 0;
    for seed in 1..=seeds {
        let (cols, rows) = (
            u16::try_from(8 + seed % 40).unwrap(),
            u16::try_from(2 + seed % 9).unwrap(),
        );
        let bytes = stream(seed, cols, rows, tokens, false);
        let continuation = stream(seed ^ 0xdead_beef, cols, rows, 60, false);
        checked += 1;
        let mut original = ScreenModel::new(cols, rows, 40).unwrap();
        let _ = original.feed(&bytes);
        let snapshot = original
            .snapshot(&SnapshotLimits::default())
            .expect("snapshot");
        assert!(snapshot.ansi.len() <= 3 * 1024 * 1024);
        let mut restored = restore_from_snapshot(&original);
        let differences = diff(&dump(&original), &dump(&restored));
        assert!(differences.is_empty(), "seed {seed}: {differences:#?}");
        let _ = original.feed(&continuation);
        let _ = restored.feed(&continuation);
        let differences = diff(&dump(&original), &dump(&restored));
        assert!(
            differences.is_empty(),
            "seed {seed} after continuation: {differences:#?}"
        );
    }
    assert_eq!(checked, seeds);
}
