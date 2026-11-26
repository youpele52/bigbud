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

/// The exact target a grant is bound to. A grant never satisfies a request for
/// another target or a stale generation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Binding {
    pub(super) target_id: String,
    pub(super) generation: Vec<u8>,
}

struct Grant {
    request_id: Vec<u8>,
    operands: Token,
    class: Class,
    scope: String,
    expires: Instant,
    binding: Binding,
}

/// The grant-issuance bound is enforced twice: once for the whole owner and
/// once per target. One noisy target can exhaust its own background share
/// without consuming another target's interactive reserve.
#[derive(Default)]
pub(super) struct Grants {
    pending: HashMap<Token, Grant>,
    consumed: HashSet<Vec<u8>>,
    pub(super) budget: Budget,
    target_budgets: HashMap<String, Budget>,
}

/// Owner-scoped operations (alias discovery) share one bucket, so an arbitrary
/// request target id cannot grow the per-target map without bound. The map holds
/// at most `MAX_TARGET_SCOPES` real targets plus the owner bucket.
const OWNER_SCOPE: &str = "";
const MAX_TARGET_SCOPES: usize = 8;

impl Grants {
    pub(super) fn new(budget: Budget) -> Self {
        Self {
            budget,
            pending: HashMap::new(),
            consumed: HashSet::new(),
            target_budgets: HashMap::new(),
        }
    }

    fn release(&mut self, scope: &str, class: Class) {
        self.budget.release(class);
        if let Some(budget) = self.target_budgets.get_mut(scope) {
            budget.release(class);
        }
    }

    /// Resolves the accounting bucket for one target. Real targets are capped by
    /// the target registry; anything beyond the cap shares the owner bucket.
    fn scope_for(&self, target: &str) -> String {
        if target.is_empty() {
            return OWNER_SCOPE.to_owned();
        }
        if self.target_budgets.contains_key(target) || self.target_budgets.len() < MAX_TARGET_SCOPES
        {
            target.to_owned()
        } else {
            OWNER_SCOPE.to_owned()
        }
    }

    pub(super) fn revoke_pending(&mut self) {
        let scopes: Vec<(String, Class)> = self
            .pending
            .values()
            .map(|grant| (grant.scope.clone(), grant.class))
            .collect();
        for (scope, class) in scopes {
            self.release(&scope, class);
        }
        self.pending.clear();
    }

    pub(super) fn issue(
        &mut self,
        request: &Request,
        binding: Binding,
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
                expired.push((grant.scope.clone(), grant.class));
                false
            }
        });
        for (scope, class) in expired {
            self.release(&scope, class);
        }
        if self.pending.len() >= MAX_PENDING || self.consumed.len() >= MAX_CONSUMED {
            // Never evict consumed IDs within an epoch to make room for a replay.
            return Err(ErrorCode::OwnerUnavailable);
        }
        let class = Class::of(&operation);
        self.budget.admit(class)?;
        let scope = self.scope_for(&binding.target_id);
        let target_admitted = self
            .target_budgets
            .entry(scope.clone())
            .or_default()
            .admit(class);
        if let Err(error) = target_admitted {
            self.budget.release(class);
            return Err(error);
        }
        let token = match random_token() {
            Ok(token) => token,
            Err(_) => {
                self.release(&scope, class);
                return Err(ErrorCode::OwnerUnavailable);
            }
        };
        let Entry::Vacant(entry) = self.pending.entry(token) else {
            self.release(&scope, class);
            return Err(ErrorCode::OwnerUnavailable);
        };
        entry.insert(Grant {
            request_id: request.request_id.clone(),
            operands: operand_digest(operation),
            class,
            scope,
            expires: now + GRANT_TTL,
            binding,
        });
        Ok(token)
    }

    pub(super) fn consume(
        &mut self,
        request: &Request,
        operation: Operation,
        now: Instant,
    ) -> Result<Binding, ErrorCode> {
        let token =
            <&Token>::try_from(request.grant.as_slice()).map_err(|_| ErrorCode::OperationDenied)?;
        let Entry::Occupied(entry) = self.pending.entry(*token) else {
            return Err(ErrorCode::OperationDenied);
        };
        let grant = entry.get();
        if grant.expires <= now {
            let class = grant.class;
            let scope = grant.scope.clone();
            entry.remove();
            self.release(&scope, class);
            return Err(ErrorCode::OperationDenied);
        }
        // Target and generation are compared before the request is accepted, so a
        // grant issued for one target can never authorize another.
        if grant.binding.target_id != request.target_id {
            return Err(ErrorCode::TargetMismatch);
        }
        if grant.binding.generation != request.target_generation {
            return Err(ErrorCode::StaleGeneration);
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
        let grant = entry.remove();
        self.release(&grant.scope, grant.class);
        self.consumed.insert(request.request_id.clone());
        Ok(grant.binding)
    }

    #[cfg(test)]
    pub(super) fn target_active(&self, target: &str, class: Class) -> usize {
        self.target_budgets
            .get(target)
            .map_or(0, |budget| budget.active(class))
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

    fn binding(target: &str, generation: &[u8]) -> Binding {
        Binding {
            target_id: target.into(),
            generation: generation.to_vec(),
        }
    }

    #[test]
    fn grants_bind_request_and_operand_and_are_single_use() {
        let now = Instant::now();
        let mut grants = Grants::default();
        let mut req = Request {
            request_id: vec![1],
            target_id: "target-a".into(),
            ..Request::default()
        };
        req.grant = grants
            .issue(&req, binding("target-a", &[]), list(None), now)
            .unwrap()
            .to_vec();
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
        assert_eq!(
            grants.consume(&req, list(Some("")), now),
            Ok(binding("target-a", &[]))
        );
        assert_eq!(
            grants.consume(&req, list(None), now),
            Err(ErrorCode::OperationDenied)
        );
        req.grant.clear();
        grants.revoke_pending();
        assert_eq!(
            grants.issue(&req, binding("target-a", &[]), list(None), now),
            Err(ErrorCode::OperationDenied)
        );
    }

    #[test]
    fn grants_bind_the_exact_target_and_generation() {
        let now = Instant::now();
        let mut grants = Grants::default();
        let mut req = Request {
            request_id: vec![1],
            target_id: "target-a".into(),
            ..Request::default()
        };
        let generation = [9u8; 32];
        req.grant = grants
            .issue(&req, binding("target-a", &generation), list(None), now)
            .unwrap()
            .to_vec();
        // The same request id and operands under another target is refused typed.
        let other = Request {
            target_id: "target-b".into(),
            ..req.clone()
        };
        assert_eq!(
            grants.consume(&other, list(None), now),
            Err(ErrorCode::TargetMismatch)
        );
        let stale = Request {
            target_generation: vec![7; 32],
            ..req.clone()
        };
        assert_eq!(
            grants.consume(&stale, list(None), now),
            Err(ErrorCode::StaleGeneration)
        );
        req.target_generation = generation.to_vec();
        assert_eq!(
            grants.consume(&req, list(None), now),
            Ok(binding("target-a", &generation))
        );
    }

    #[test]
    fn expiration_is_exclusive_and_revocation_removes_pending_grants() {
        let now = Instant::now();
        let mut grants = Grants::default();
        let mut req = Request {
            request_id: vec![1],
            target_id: "target-a".into(),
            ..Request::default()
        };
        req.grant = grants
            .issue(&req, binding("target-a", &[]), list(None), now)
            .unwrap()
            .to_vec();
        assert_eq!(
            grants.consume(&req, list(None), now + GRANT_TTL),
            Err(ErrorCode::OperationDenied)
        );
        req.grant.clear();
        req.grant = grants
            .issue(&req, binding("target-a", &[]), list(None), now)
            .unwrap()
            .to_vec();
        grants.revoke_pending();
        assert_eq!(
            grants.consume(&req, list(None), now),
            Err(ErrorCode::OperationDenied)
        );
    }
}
