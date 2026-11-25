use std::{
    collections::{HashMap, HashSet, hash_map::Entry},
    time::{Duration, Instant},
};

#[path = "owner_grants.budget.rs"]
pub(crate) mod budget;

use budget::{Budget, Class};
use prost::Message;
use sha2::{Digest, Sha256};

use crate::{
    Token, random_token,
    v1::{ErrorCode, Request, request::Operation},
};

const GRANT_TTL: Duration = Duration::from_secs(15);
const MAX_PENDING: usize = 32;
const MAX_CONSUMED: usize = 4096;

struct Grant {
    request_id: Vec<u8>,
    operands: Token,
    class: Class,
    expires: Instant,
}

// Lives only in the authenticated pipe session. Every use is also validated
// against that session's immutable profile/target/epoch and current generation.
#[derive(Default)]
pub(super) struct Grants {
    pending: HashMap<Token, Grant>,
    consumed: HashSet<Vec<u8>>,
    pub(super) budget: Budget,
}

impl Grants {
    pub(super) fn new(budget: Budget) -> Self {
        Self {
            budget,
            pending: HashMap::new(),
            consumed: HashSet::new(),
        }
    }

    pub(super) fn revoke_pending(&mut self) {
        for grant in self.pending.values() {
            self.budget.release(grant.class);
        }
        self.pending.clear();
    }

    pub(super) fn issue(
        &mut self,
        request: &Request,
        operation: Operation,
        now: Instant,
    ) -> Result<Token, ErrorCode> {
        if !request.grant.is_empty() || self.consumed.contains(&request.request_id) {
            return Err(ErrorCode::OperationDenied);
        }
        let mut expired = Vec::new();
        self.pending.retain(|_, grant| {
            if grant.expires > now {
                true
            } else {
                expired.push(grant.class);
                false
            }
        });
        for class in expired {
            self.budget.release(class);
        }
        if self.pending.len() >= MAX_PENDING || self.consumed.len() >= MAX_CONSUMED {
            // Never evict consumed IDs within an epoch to make room for a replay.
            return Err(ErrorCode::OwnerUnavailable);
        }
        let class = Class::of(&operation);
        self.budget.admit(class)?;
        let token = match random_token() {
            Ok(token) => token,
            Err(_) => {
                self.budget.release(class);
                return Err(ErrorCode::OwnerUnavailable);
            }
        };
        let Entry::Vacant(entry) = self.pending.entry(token) else {
            self.budget.release(class);
            return Err(ErrorCode::OwnerUnavailable);
        };
        entry.insert(Grant {
            request_id: request.request_id.clone(),
            operands: operand_digest(operation),
            class,
            expires: now + GRANT_TTL,
        });
        Ok(token)
    }

    pub(super) fn consume(
        &mut self,
        request: &Request,
        operation: Operation,
        now: Instant,
    ) -> Result<(), ErrorCode> {
        let token =
            <&Token>::try_from(request.grant.as_slice()).map_err(|_| ErrorCode::OperationDenied)?;
        let Entry::Occupied(entry) = self.pending.entry(*token) else {
            return Err(ErrorCode::OperationDenied);
        };
        let grant = entry.get();
        if grant.expires <= now {
            let class = grant.class;
            entry.remove();
            self.budget.release(class);
            return Err(ErrorCode::OperationDenied);
        }
        if grant.request_id != request.request_id
            || grant.operands != operand_digest(operation)
            || self.consumed.contains(&request.request_id)
        {
            return Err(ErrorCode::OperationDenied);
        }
        if self.consumed.len() >= MAX_CONSUMED {
            return Err(ErrorCode::OwnerUnavailable);
        }
        let class = entry.remove().class;
        self.budget.release(class);
        self.consumed.insert(request.request_id.clone());
        Ok(())
    }
}

fn operand_digest(mut operation: Operation) -> Token {
    if let Operation::ListFolders(operand) = &mut operation
        && operand.path.as_deref() == Some("")
    {
        operand.path = None;
    }
    // Canonical v1 encoding: only the normalized operation from a fresh request.
    let normalized = Request {
        operation: Some(operation),
        ..Request::default()
    };
    let mut digest = Sha256::new();
    digest.update(b"bigbud.ssh_owner.v1/operands\0");
    digest.update(normalized.encode_to_vec());
    digest.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v1::{Empty, ListFolders};

    fn list(path: Option<&str>) -> Operation {
        Operation::ListFolders(ListFolders {
            path: path.map(str::to_owned),
        })
    }

    #[test]
    fn grants_bind_request_and_operand_and_are_single_use() {
        let now = Instant::now();
        let mut grants = Grants::default();
        let mut req = Request {
            request_id: vec![1],
            ..Request::default()
        };
        req.grant = grants.issue(&req, list(None), now).unwrap().to_vec();
        assert_eq!(
            grants.consume(&req, list(Some("other")), now),
            Err(ErrorCode::OperationDenied)
        );
        assert_eq!(
            grants.consume(&req, Operation::Connect(Empty {}), now),
            Err(ErrorCode::OperationDenied)
        );
        req.request_id = vec![2];
        assert_eq!(
            grants.consume(&req, list(None), now),
            Err(ErrorCode::OperationDenied)
        );
        req.request_id = vec![1];
        assert_eq!(grants.consume(&req, list(Some("")), now), Ok(()));
        assert_eq!(
            grants.consume(&req, list(None), now),
            Err(ErrorCode::OperationDenied)
        );
        req.grant.clear();
        grants.revoke_pending();
        assert_eq!(
            grants.issue(&req, list(None), now),
            Err(ErrorCode::OperationDenied)
        );
    }

    #[test]
    fn expiration_is_exclusive_and_revocation_removes_pending_grants() {
        let now = Instant::now();
        let mut grants = Grants::default();
        let mut req = Request {
            request_id: vec![1],
            ..Request::default()
        };
        req.grant = grants.issue(&req, list(None), now).unwrap().to_vec();
        assert_eq!(
            grants.consume(&req, list(None), now + GRANT_TTL),
            Err(ErrorCode::OperationDenied)
        );
        req.grant.clear();
        req.grant = grants.issue(&req, list(None), now).unwrap().to_vec();
        grants.revoke_pending();
        assert_eq!(
            grants.consume(&req, list(None), now),
            Err(ErrorCode::OperationDenied)
        );
    }
}
