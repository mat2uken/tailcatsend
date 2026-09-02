use thiserror::Error;

use crate::limits::*;

pub const TEXT_HEADER_MAGIC: &[u8; 4] = b"TST1";
pub const TEXT_HEADER_LEN: usize = 48;

pub const FILE_HEADER_MAGIC: &[u8; 4] = b"TSF1";
pub const FILE_HEADER_LEN: usize = 60;

#[derive(Debug, Error)]
pub enum DataHeaderError {
    #[error("Buffer too short for text header (expected {TEXT_HEADER_LEN}, got {0})")]
    TextHeaderTooShort(usize),
    #[error("Buffer too short for file header (expected {FILE_HEADER_LEN}, got {0})")]
    FileHeaderTooShort(usize),
    #[error("Invalid magic: expected {expected:?}, got {actual:?}")]
    InvalidMagic { expected: &'static [u8], actual: Vec<u8> },
    #[error("Invalid header version: {0}")]
    InvalidVersion(u8),
    #[error("Nonzero reserved field: {0}")]
    NonzeroReserved(u16),
    #[error("Text payload size exceeds limit ({0} > {MAX_TEXT_PAYLOAD_SIZE})")]
    TextSizeTooLarge(u64),
    #[error("Unsupported non-zero offset for P0: {0}")]
    NonZeroOffset(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextDataHeader {
    pub version: u8,
    pub flags: u8,
    pub session_id: [u8; 16],
    pub transfer_id: [u8; 16],
    pub byte_length: u64,
}

impl TextDataHeader {
    pub fn new(session_id: [u8; 16], transfer_id: [u8; 16], byte_length: u64) -> Result<Self, DataHeaderError> {
        if byte_length > MAX_TEXT_PAYLOAD_SIZE {
            return Err(DataHeaderError::TextSizeTooLarge(byte_length));
        }
        Ok(Self {
            version: 1,
            flags: 0,
            session_id,
            transfer_id,
            byte_length,
        })
    }

    pub fn encode(&self) -> [u8; TEXT_HEADER_LEN] {
        let mut buf = [0u8; TEXT_HEADER_LEN];
        buf[0..4].copy_from_slice(TEXT_HEADER_MAGIC);
        buf[4] = self.version;
        buf[5] = self.flags;
        buf[6..8].copy_from_slice(&0u16.to_be_bytes());
        buf[8..24].copy_from_slice(&self.session_id);
        buf[24..40].copy_from_slice(&self.transfer_id);
        buf[40..48].copy_from_slice(&self.byte_length.to_be_bytes());
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, DataHeaderError> {
        if bytes.len() < TEXT_HEADER_LEN {
            return Err(DataHeaderError::TextHeaderTooShort(bytes.len()));
        }
        if &bytes[0..4] != TEXT_HEADER_MAGIC {
            return Err(DataHeaderError::InvalidMagic {
                expected: TEXT_HEADER_MAGIC,
                actual: bytes[0..4].to_vec(),
            });
        }
        let version = bytes[4];
        if version != 1 {
            return Err(DataHeaderError::InvalidVersion(version));
        }
        let flags = bytes[5];
        let reserved = u16::from_be_bytes([bytes[6], bytes[7]]);
        if reserved != 0 {
            return Err(DataHeaderError::NonzeroReserved(reserved));
        }
        let mut session_id = [0u8; 16];
        session_id.copy_from_slice(&bytes[8..24]);
        let mut transfer_id = [0u8; 16];
        transfer_id.copy_from_slice(&bytes[24..40]);
        let byte_length = u64::from_be_bytes(bytes[40..48].try_into().unwrap());
        if byte_length > MAX_TEXT_PAYLOAD_SIZE {
            return Err(DataHeaderError::TextSizeTooLarge(byte_length));
        }
        Ok(Self {
            version,
            flags,
            session_id,
            transfer_id,
            byte_length,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDataHeader {
    pub version: u8,
    pub flags: u8,
    pub session_id: [u8; 16],
    pub transfer_id: [u8; 16],
    pub item_id: u32,
    pub offset: u64,
    pub payload_size: u64,
}

impl FileDataHeader {
    pub fn new(
        session_id: [u8; 16],
        transfer_id: [u8; 16],
        item_id: u32,
        offset: u64,
        payload_size: u64,
    ) -> Result<Self, DataHeaderError> {
        if offset != 0 {
            return Err(DataHeaderError::NonZeroOffset(offset));
        }
        Ok(Self {
            version: 1,
            flags: 0,
            session_id,
            transfer_id,
            item_id,
            offset,
            payload_size,
        })
    }

    pub fn encode(&self) -> [u8; FILE_HEADER_LEN] {
        let mut buf = [0u8; FILE_HEADER_LEN];
        buf[0..4].copy_from_slice(FILE_HEADER_MAGIC);
        buf[4] = self.version;
        buf[5] = self.flags;
        buf[6..8].copy_from_slice(&0u16.to_be_bytes());
        buf[8..24].copy_from_slice(&self.session_id);
        buf[24..40].copy_from_slice(&self.transfer_id);
        buf[40..44].copy_from_slice(&self.item_id.to_be_bytes());
        buf[44..52].copy_from_slice(&self.offset.to_be_bytes());
        buf[52..60].copy_from_slice(&self.payload_size.to_be_bytes());
        buf
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, DataHeaderError> {
        if bytes.len() < FILE_HEADER_LEN {
            return Err(DataHeaderError::FileHeaderTooShort(bytes.len()));
        }
        if &bytes[0..4] != FILE_HEADER_MAGIC {
            return Err(DataHeaderError::InvalidMagic {
                expected: FILE_HEADER_MAGIC,
                actual: bytes[0..4].to_vec(),
            });
        }
        let version = bytes[4];
        if version != 1 {
            return Err(DataHeaderError::InvalidVersion(version));
        }
        let flags = bytes[5];
        let reserved = u16::from_be_bytes([bytes[6], bytes[7]]);
        if reserved != 0 {
            return Err(DataHeaderError::NonzeroReserved(reserved));
        }
        let mut session_id = [0u8; 16];
        session_id.copy_from_slice(&bytes[8..24]);
        let mut transfer_id = [0u8; 16];
        transfer_id.copy_from_slice(&bytes[24..40]);
        let item_id = u32::from_be_bytes(bytes[40..44].try_into().unwrap());
        let offset = u64::from_be_bytes(bytes[44..52].try_into().unwrap());
        if offset != 0 {
            return Err(DataHeaderError::NonZeroOffset(offset));
        }
        let payload_size = u64::from_be_bytes(bytes[52..60].try_into().unwrap());
        Ok(Self {
            version,
            flags,
            session_id,
            transfer_id,
            item_id,
            offset,
            payload_size,
        })
    }
}
