pub const PROTOCOL_MAJOR: u32 = 1;
pub const PROTOCOL_MINOR: u32 = 0;

pub const CONTROL_PORT: u16 = 100;
pub const TEXT_PORT: u16 = 101;
pub const FILE_PORT: u16 = 102;
pub const RESERVED_DIR_PORT: u16 = 103;

pub const MAX_CONTROL_FRAME_SIZE: usize = 1024 * 1024; // 1 MiB
pub const MAX_TEXT_PAYLOAD_SIZE: u64 = 1024 * 1024; // 1 MiB
pub const MAX_FILES_PER_OFFER: usize = 128;
pub const MAX_FILENAME_BYTES: usize = 1024;
pub const MAX_INVITATION_CBOR_BYTES: usize = 1024;
pub const MAX_INVITATION_B64_BYTES: usize = 1300;
pub const MAX_QR_URL_BYTES: usize = 1500;
pub const CHUNK_SIZE_BYTES: usize = 64 * 1024; // 64 KiB
pub const DEFAULT_INVITE_LIFETIME_SECS: u64 = 600; // 10 minutes
pub const MAX_INVITE_LIFETIME_SECS: u64 = 3600; // 60 minutes
pub const CLOCK_SKEW_TOLERANCE_SECS: u64 = 60;
