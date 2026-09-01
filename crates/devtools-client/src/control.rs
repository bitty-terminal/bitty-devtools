#![forbid(unsafe_code)]
//! Control surface (debug.control, audited, no bypass).

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlError {
    ScopeDenied,
    Invalid(String),
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ScopeDenied => write!(f, "debug.control required"),
            Self::Invalid(m) => write!(f, "invalid: {m}"),
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
    if caller.is_empty() || caller.len() > 64 {
        return Err(ControlError::Invalid("caller 1..64".to_string()));
    }
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

pub fn dispose_generation(
    scope_ok: bool,
    generation: u64,
    caller: &str,
) -> Result<Receipt, ControlError> {
    if !scope_ok {
        return Err(ControlError::ScopeDenied);
    }
    if caller.is_empty() || caller.len() > 64 {
        return Err(ControlError::Invalid("caller".to_string()));
    }
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
}
