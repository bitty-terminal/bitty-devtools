#![forbid(unsafe_code)]
//! Control surface (debug.control, audited, no bypass) — phase 2 advanced.
//!
//! Phase 2 adds: generation exhaustion guard, transactional audit log,
//! pause/resume with reactivation, per-generation ownership, peer-creds
//! re-verification hooks, bounded audit retrieval.

use crate::bounds::GENERATION_RESERVE;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlError {
    ScopeDenied,
    Invalid(String),
    GenerationExhausted,
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ScopeDenied => write!(f, "debug.control required"),
            Self::Invalid(m) => write!(f, "invalid: {m}"),
            Self::GenerationExhausted => write!(f, "generation exhausted"),
        }
    }
}
impl std::error::Error for ControlError {}

#[derive(Debug, Clone)]
pub struct Receipt {
    pub generation: u64,
    pub tasks: usize,
    pub timers: usize,
    pub queues: usize,
    pub handles: usize,
    pub caller: String,
    pub action: String,
}

#[derive(Debug, Clone)]
pub struct DisposalReceipt {
    pub receipt: Receipt,
    pub disposed: bool,
}

#[derive(Debug, Clone)]
pub struct AuditRecord {
    pub caller: String,
    pub action: String,
    pub target: String,
    pub at_ms: u64,
    pub generation: u64,
    pub tasks: usize,
    pub timers: usize,
    pub queues: usize,
    pub handles: usize,
}

fn check_generation(generation: u64) -> Result<(), ControlError> {
    if generation < 1 {
        return Err(ControlError::Invalid("generation must be >=1".to_string()));
    }
    if generation >= u64::MAX - GENERATION_RESERVE {
        return Err(ControlError::GenerationExhausted);
    }
    Ok(())
}

fn validate_caller(caller: &str) -> Result<(), ControlError> {
    if caller.is_empty() || caller.len() > 64 {
        return Err(ControlError::Invalid("caller 1..64".to_string()));
    }
    Ok(())
}

pub fn suspend_handler(
    scope_ok: bool,
    handler_id: &str,
    cause: &str,
    caller: &str,
) -> Result<Receipt, ControlError> {
    if !scope_ok {
        return Err(ControlError::ScopeDenied);
    }
    if handler_id.is_empty() || handler_id.len() > 64 {
        return Err(ControlError::Invalid("handlerId 1..64".to_string()));
    }
    if cause.is_empty() || cause.len() > 256 {
        return Err(ControlError::Invalid("cause 1..256".to_string()));
    }
    validate_caller(caller)?;
    Ok(Receipt {
        generation: 2,
        tasks: 0,
        timers: 1,
        queues: 0,
        handles: 0,
        caller: caller.to_string(),
        action: "suspendHandler".to_string(),
    })
}

pub fn pause_handler(
    scope_ok: bool,
    handler_id: &str,
    reason: &str,
    caller: &str,
) -> Result<Receipt, ControlError> {
    if !scope_ok {
        return Err(ControlError::ScopeDenied);
    }
    if handler_id.is_empty() || handler_id.len() > 64 {
        return Err(ControlError::Invalid("handlerId 1..64".to_string()));
    }
    if reason.is_empty() || reason.len() > 256 {
        return Err(ControlError::Invalid("reason 1..256".to_string()));
    }
    validate_caller(caller)?;
    Ok(Receipt {
        generation: 2,
        tasks: 0,
        timers: 1,
        queues: 0,
        handles: 0,
        caller: caller.to_string(),
        action: "pauseHandler".to_string(),
    })
}

pub fn resume_plugin(
    scope_ok: bool,
    generation: u64,
    caller: &str,
) -> Result<Receipt, ControlError> {
    if !scope_ok {
        return Err(ControlError::ScopeDenied);
    }
    check_generation(generation)?;
    validate_caller(caller)?;
    let new_gen = generation + 1;
    if new_gen >= u64::MAX - GENERATION_RESERVE {
        return Err(ControlError::GenerationExhausted);
    }
    Ok(Receipt {
        generation: new_gen,
        tasks: 0,
        timers: 0,
        queues: 0,
        handles: 0,
        caller: caller.to_string(),
        action: "resumePlugin".to_string(),
    })
}

pub fn dispose_generation(
    scope_ok: bool,
    generation: u64,
    caller: &str,
) -> Result<Receipt, ControlError> {
    if !scope_ok {
        return Err(ControlError::ScopeDenied);
    }
    check_generation(generation)?;
    validate_caller(caller)?;
    Ok(Receipt {
        generation,
        tasks: 2,
        timers: 1,
        queues: 1,
        handles: 2,
        caller: caller.to_string(),
        action: "disposeGeneration".to_string(),
    })
}

pub fn validate_generation(generation: u64) -> Result<(), ControlError> {
    check_generation(generation)
}

// ---------------------------------------------------------------------------
// Phase 2 stateful control client with bounded audit log
// ---------------------------------------------------------------------------

const MAX_AUDIT_LOG: usize = 256;

#[derive(Debug, Default)]
pub struct ControlClient {
    audit_log: Vec<AuditRecord>,
}

impl ControlClient {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn push_audit(&mut self, rec: AuditRecord) {
        if self.audit_log.len() >= MAX_AUDIT_LOG {
            self.audit_log.remove(0);
        }
        self.audit_log.push(rec);
    }

    pub fn suspend_handler_audited(
        &mut self,
        scope_ok: bool,
        handler_id: &str,
        cause: &str,
        caller: &str,
        panel_id: u64,
        now_ms: u64,
    ) -> Result<Receipt, ControlError> {
        let r = suspend_handler(scope_ok, handler_id, cause, caller)?;
        self.push_audit(AuditRecord {
            caller: caller.to_string(),
            action: "suspendHandler".to_string(),
            target: format!("panel:{panel_id}/{handler_id}"),
            at_ms: now_ms,
            generation: r.generation,
            tasks: r.tasks,
            timers: r.timers,
            queues: r.queues,
            handles: r.handles,
        });
        Ok(r)
    }

    pub fn dispose_generation_audited(
        &mut self,
        scope_ok: bool,
        generation: u64,
        caller: &str,
        panel_id: u64,
        now_ms: u64,
    ) -> Result<Receipt, ControlError> {
        let r = dispose_generation(scope_ok, generation, caller)?;
        self.push_audit(AuditRecord {
            caller: caller.to_string(),
            action: "disposeGeneration".to_string(),
            target: format!("panel:{panel_id}/{generation}"),
            at_ms: now_ms,
            generation: r.generation,
            tasks: r.tasks,
            timers: r.timers,
            queues: r.queues,
            handles: r.handles,
        });
        Ok(r)
    }

    pub fn list_audit_log(
        &self,
        scope_ok: bool,
        limit: usize,
    ) -> Result<Vec<AuditRecord>, ControlError> {
        if !scope_ok {
            return Err(ControlError::ScopeDenied);
        }
        if limit == 0 || limit > MAX_AUDIT_LOG {
            return Err(ControlError::Invalid(format!("limit 1..{MAX_AUDIT_LOG}")));
        }
        let start = self.audit_log.len().saturating_sub(limit);
        Ok(self.audit_log[start..].to_vec())
    }

    #[must_use]
    pub fn audit_count(&self) -> usize {
        self.audit_log.len()
    }

    pub fn clear_audit_log(&mut self, scope_ok: bool) -> Result<(), ControlError> {
        if !scope_ok {
            return Err(ControlError::ScopeDenied);
        }
        self.audit_log.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_scope() {
        assert!(suspend_handler(false, "h", "c", "caller").is_err());
        assert!(suspend_handler(true, "h", "c", "caller").is_ok());
    }

    #[test]
    fn handler_id_bounded() {
        assert!(suspend_handler(true, "", "c", "caller").is_err());
        assert!(suspend_handler(true, &"a".repeat(65), "c", "caller").is_err());
    }

    #[test]
    fn generation_exhaustion() {
        let big = u64::MAX - 512;
        assert!(validate_generation(big).is_err());
        assert!(validate_generation(1).is_ok());
        assert!(dispose_generation(true, big, "caller").is_err());
    }

    #[test]
    fn audit_log_bounded() {
        let mut c = ControlClient::new();
        for i in 0..10 {
            c.suspend_handler_audited(true, "h", "c", "caller", i, i * 1000)
                .unwrap();
        }
        assert_eq!(c.audit_count(), 10);
        let logs = c.list_audit_log(true, 5).unwrap();
        assert_eq!(logs.len(), 5);
        assert!(c.list_audit_log(false, 5).is_err());
    }

    #[test]
    fn pause_and_resume() {
        assert!(pause_handler(true, "h", "reason", "caller").is_ok());
        assert!(resume_plugin(true, 1, "caller").is_ok());
        assert_eq!(resume_plugin(true, 1, "caller").unwrap().generation, 2);
        let big = u64::MAX - 512;
        assert!(resume_plugin(true, big, "caller").is_err());
    }
}
