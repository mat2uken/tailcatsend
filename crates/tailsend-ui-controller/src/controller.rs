use std::sync::Arc;
use tailsend_core::snapshot::AppSnapshot;
use tailsend_core::state::SessionState;

pub struct UiStateAdapter {
    pub current_snapshot: AppSnapshot,
}

impl Default for UiStateAdapter {
    fn default() -> Self {
        Self {
            current_snapshot: AppSnapshot::default(),
        }
    }
}
