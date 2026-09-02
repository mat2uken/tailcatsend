use tailsend_core::snapshot::AppSnapshot;

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
