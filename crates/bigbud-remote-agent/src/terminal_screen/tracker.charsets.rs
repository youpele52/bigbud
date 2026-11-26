//! Character sets as xterm.js handles them (`CharsetService`, `InputHandler.selectCharset`,
//! `setgLevel`, `saveCursor`/`restoreCursor` and `data/Charsets.ts`):
//!
//! - G0–G3 are designated by `ESC ( ) * +` (and `ESC - .` for G1/G2) with one of the finals
//!   xterm.js registers; any other final has no handler and changes nothing. `ESC /` is
//!   accepted and ignored.
//! - SI, SO, `ESC n`, `ESC o` and the GR shifts `ESC ~ } |` only select which set prints
//!   (xterm.js does not distinguish GL from GR).
//! - xterm.js keeps the sets in an array that only grows (until RIS or DECSTR): DECSC saves a
//!   copy of it, and DECRC restores just the sets in that copy, so a set designated after
//!   the save but beyond the copy's length survives the restore.

/// A character set xterm.js can designate (`CHARSETS`; aliases share one variant).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Charset {
    #[default]
    Ascii,
    DecSpecial,
    British,
    Dutch,
    Finnish,
    French,
    FrenchCanadian,
    German,
    Italian,
    NorwegianDanish,
    Spanish,
    Swedish,
    Swiss,
}

const DEC_SPECIAL: [char; 31] = [
    '\u{25c6}', '\u{2592}', '\u{2409}', '\u{240c}', '\u{240d}', '\u{240a}', '\u{00b0}', '\u{00b1}',
    '\u{2424}', '\u{240b}', '\u{2518}', '\u{2510}', '\u{250c}', '\u{2514}', '\u{253c}', '\u{23ba}',
    '\u{23bb}', '\u{2500}', '\u{23bc}', '\u{23bd}', '\u{251c}', '\u{2524}', '\u{2534}', '\u{252c}',
    '\u{2502}', '\u{2264}', '\u{2265}', '\u{03c0}', '\u{2260}', '\u{00a3}', '\u{00b7}',
];

// National replacement sets. xterm.js prints the first UTF-16 unit of a replacement, so
// Dutch `[` (`'ij'`) prints `i`.
const BRITISH: &[(u8, char)] = &[(b'#', '£')];
const DUTCH: &[(u8, char)] = &[
    (b'#', '£'),
    (b'@', '¾'),
    (b'[', 'i'),
    (b'\\', '½'),
    (b']', '|'),
    (b'{', '¨'),
    (b'|', 'f'),
    (b'}', '¼'),
    (b'~', '´'),
];
const FINNISH: &[(u8, char)] = &[
    (b'[', 'Ä'),
    (b'\\', 'Ö'),
    (b']', 'Å'),
    (b'^', 'Ü'),
    (b'`', 'é'),
    (b'{', 'ä'),
    (b'|', 'ö'),
    (b'}', 'å'),
    (b'~', 'ü'),
];
const FRENCH: &[(u8, char)] = &[
    (b'#', '£'),
    (b'@', 'à'),
    (b'[', '°'),
    (b'\\', 'ç'),
    (b']', '§'),
    (b'{', 'é'),
    (b'|', 'ù'),
    (b'}', 'è'),
    (b'~', '¨'),
];
const FRENCH_CANADIAN: &[(u8, char)] = &[
    (b'@', 'à'),
    (b'[', 'â'),
    (b'\\', 'ç'),
    (b']', 'ê'),
    (b'^', 'î'),
    (b'`', 'ô'),
    (b'{', 'é'),
    (b'|', 'ù'),
    (b'}', 'è'),
    (b'~', 'û'),
];
const GERMAN: &[(u8, char)] = &[
    (b'@', '§'),
    (b'[', 'Ä'),
    (b'\\', 'Ö'),
    (b']', 'Ü'),
    (b'{', 'ä'),
    (b'|', 'ö'),
    (b'}', 'ü'),
    (b'~', 'ß'),
];
const ITALIAN: &[(u8, char)] = &[
    (b'#', '£'),
    (b'@', '§'),
    (b'[', '°'),
    (b'\\', 'ç'),
    (b']', 'é'),
    (b'`', 'ù'),
    (b'{', 'à'),
    (b'|', 'ò'),
    (b'}', 'è'),
    (b'~', 'ì'),
];
const NORWEGIAN_DANISH: &[(u8, char)] = &[
    (b'@', 'Ä'),
    (b'[', 'Æ'),
    (b'\\', 'Ø'),
    (b']', 'Å'),
    (b'^', 'Ü'),
    (b'`', 'ä'),
    (b'{', 'æ'),
    (b'|', 'ø'),
    (b'}', 'å'),
    (b'~', 'ü'),
];
const SPANISH: &[(u8, char)] = &[
    (b'#', '£'),
    (b'@', '§'),
    (b'[', '¡'),
    (b'\\', 'Ñ'),
    (b']', '¿'),
    (b'{', '°'),
    (b'|', 'ñ'),
    (b'}', 'ç'),
];
const SWEDISH: &[(u8, char)] = &[
    (b'@', 'É'),
    (b'[', 'Ä'),
    (b'\\', 'Ö'),
    (b']', 'Å'),
    (b'^', 'Ü'),
    (b'`', 'é'),
    (b'{', 'ä'),
    (b'|', 'ö'),
    (b'}', 'å'),
    (b'~', 'ü'),
];
const SWISS: &[(u8, char)] = &[
    (b'#', 'ù'),
    (b'@', 'à'),
    (b'[', 'é'),
    (b'\\', 'ç'),
    (b']', 'ê'),
    (b'^', 'î'),
    (b'_', 'è'),
    (b'`', 'ô'),
    (b'{', 'ä'),
    (b'|', 'ö'),
    (b'}', 'ü'),
    (b'~', 'û'),
];

impl Charset {
    /// The set a designation final selects; `None` when xterm.js has no handler for it.
    pub(crate) fn from_final(final_byte: u8) -> Option<Self> {
        Some(match final_byte {
            b'B' => Self::Ascii,
            b'0' => Self::DecSpecial,
            b'A' => Self::British,
            b'4' => Self::Dutch,
            b'C' | b'5' => Self::Finnish,
            b'R' => Self::French,
            b'Q' => Self::FrenchCanadian,
            b'K' => Self::German,
            b'Y' => Self::Italian,
            b'E' | b'6' => Self::NorwegianDanish,
            b'Z' => Self::Spanish,
            b'H' | b'7' => Self::Swedish,
            b'=' => Self::Swiss,
            _ => return None,
        })
    }

    /// A final that designates this set.
    pub(crate) fn final_byte(self) -> char {
        match self {
            Self::Ascii => 'B',
            Self::DecSpecial => '0',
            Self::British => 'A',
            Self::Dutch => '4',
            Self::Finnish => 'C',
            Self::French => 'R',
            Self::FrenchCanadian => 'Q',
            Self::German => 'K',
            Self::Italian => 'Y',
            Self::NorwegianDanish => 'E',
            Self::Spanish => 'Z',
            Self::Swedish => 'H',
            Self::Swiss => '=',
        }
    }

    /// What xterm.js prints for the ASCII `byte` in this set, when it is replaced.
    pub(crate) fn map(self, byte: u8) -> Option<char> {
        let table = match self {
            Self::Ascii => return None,
            Self::DecSpecial => {
                return byte
                    .checked_sub(0x60)
                    .and_then(|index| DEC_SPECIAL.get(usize::from(index)))
                    .copied();
            }
            Self::British => BRITISH,
            Self::Dutch => DUTCH,
            Self::Finnish => FINNISH,
            Self::French => FRENCH,
            Self::FrenchCanadian => FRENCH_CANADIAN,
            Self::German => GERMAN,
            Self::Italian => ITALIAN,
            Self::NorwegianDanish => NORWEGIAN_DANISH,
            Self::Spanish => SPANISH,
            Self::Swedish => SWEDISH,
            Self::Swiss => SWISS,
        };
        table
            .iter()
            .find(|(key, _)| *key == byte)
            .map(|(_, symbol)| *symbol)
    }
}

/// G0–G3 and the invoked set. `len` mirrors the length of xterm.js's `charsets` array (the
/// highest set designated since the last reset, plus one); sets at or beyond it are ASCII.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Charsets {
    sets: [Charset; 4],
    len: u8,
    level: u8,
}

impl Charsets {
    pub(crate) fn sets(&self) -> [Charset; 4] {
        self.sets
    }

    pub(crate) fn len(&self) -> u8 {
        self.len
    }

    pub(crate) fn level(&self) -> u8 {
        self.level
    }

    /// The set that prints now.
    pub(crate) fn active(&self) -> Charset {
        self.sets
            .get(usize::from(self.level))
            .copied()
            .unwrap_or_default()
    }

    /// `setgCharset`: designates `charset` into G`index`, growing the array to cover it.
    pub(crate) fn set(&mut self, index: u8, charset: Charset) {
        if let Some(slot) = self.sets.get_mut(usize::from(index)) {
            *slot = charset;
            self.len = self.len.max(index + 1);
        }
    }

    /// An `ESC` sequence: designations, `ESC % @`/`ESC % G`, and the locking shifts LS2, LS3
    /// and the GR shifts LS3R, LS2R, LS1R (xterm.js treats them alike). Others are ignored.
    pub(crate) fn escape(&mut self, intermediates: &[u8], final_byte: u8) {
        match (intermediates, final_byte) {
            ([intermediate], _) if *intermediate != b'%' => {
                self.designate(*intermediate, final_byte)
            }
            ([b'%'], b'@' | b'G') => self.select_default(),
            ([], b'n' | b'}') => self.invoke(2),
            ([], b'o' | b'|') => self.invoke(3),
            ([], b'~') => self.invoke(1),
            _ => {}
        }
    }

    /// `ESC <intermediate> <final>` designations (`ESC /` is accepted and ignored).
    fn designate(&mut self, intermediate: u8, final_byte: u8) {
        let index = match intermediate {
            b'(' => 0,
            b')' | b'-' => 1,
            b'*' | b'.' => 2,
            b'+' => 3,
            _ => return,
        };
        if let Some(charset) = Charset::from_final(final_byte) {
            self.set(index, charset);
        }
    }

    /// Locking shifts (`setgLevel`).
    pub(crate) fn invoke(&mut self, level: u8) {
        if level < 4 {
            self.level = level;
        }
    }

    /// `ESC % @` and `ESC % G`: G0 back to ASCII and invoked.
    fn select_default(&mut self) {
        self.level = 0;
        self.set(0, Charset::Ascii);
    }

    /// DECSET 2: every set back to ASCII (the array covers all four).
    pub(crate) fn designate_all_ascii(&mut self) {
        for index in 0..4 {
            self.set(index, Charset::Ascii);
        }
    }

    /// DECRC: only the sets in the saved copy are restored; the shift always is.
    pub(crate) fn restore(&mut self, saved: Self) {
        for index in 0..saved.len {
            self.set(
                index,
                saved
                    .sets
                    .get(usize::from(index))
                    .copied()
                    .unwrap_or_default(),
            );
        }
        self.level = saved.level;
    }
}
