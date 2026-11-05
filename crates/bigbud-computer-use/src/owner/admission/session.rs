//! Owner-issued caller session identity. Only `Ledger::open_caller` mints one
//! (from a never-reused counter) and only `Ledger::session` lends a live one,
//! so authority state can never be keyed by a retired or forged caller ID.
//! Not `Clone`: holding a reference proves the session was live when lent.
#[derive(Debug, PartialEq, Eq)]
#[must_use = "a retired session must be passed to AuthorityTable::forget"]
pub struct CallerSession(String);

impl CallerSession {
    pub(super) fn issued(id: String) -> Self {
        Self(id)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[cfg(test)]
    pub(crate) fn fixture(id: &str) -> Self {
        Self(id.into())
    }
}
