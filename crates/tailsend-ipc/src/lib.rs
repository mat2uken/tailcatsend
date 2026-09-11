//! Small, allocation-conscious framing used by every Ponlet WebView bridge.
//!
//! Metadata is carried as UTF-8 JSON inside a binary envelope so the transport
//! never has to stringify an entire request or copy binary QR pixels through a
//! JSON value.  The JSON fallback uses the same opcode names through its
//! adapter.

use thiserror::Error;

pub const MAGIC: [u8; 4] = *b"PNLT";
pub const PROTOCOL_VERSION: u8 = 2;
pub const HEADER_LEN: usize = 32;
pub const MAX_PAYLOAD_LEN: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MessageKind {
    Request = 1,
    Response = 2,
    Event = 3,
    Subscribe = 4,
    Unsubscribe = 5,
    WaitEvent = 6,
}

impl TryFrom<u8> for MessageKind {
    type Error = IpcError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Request),
            2 => Ok(Self::Response),
            3 => Ok(Self::Event),
            4 => Ok(Self::Subscribe),
            5 => Ok(Self::Unsubscribe),
            6 => Ok(Self::WaitEvent),
            _ => Err(IpcError::UnknownKind(value)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum Opcode {
    Snapshot = 1,
    CreateInvite = 2,
    Join = 3,
    SendText = 4,
    SendFiles = 5,
    PickAndSendFiles = 6,
    SaveText = 7,
    QrCode = 8,
    CancelTransfer = 9,
    Disconnect = 10,
    OpenReceived = 11,
    Subscribe = 12,
    Unsubscribe = 13,
    WaitEvent = 14,
}

impl TryFrom<u16> for Opcode {
    type Error = IpcError;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Snapshot),
            2 => Ok(Self::CreateInvite),
            3 => Ok(Self::Join),
            4 => Ok(Self::SendText),
            5 => Ok(Self::SendFiles),
            6 => Ok(Self::PickAndSendFiles),
            7 => Ok(Self::SaveText),
            8 => Ok(Self::QrCode),
            9 => Ok(Self::CancelTransfer),
            10 => Ok(Self::Disconnect),
            11 => Ok(Self::OpenReceived),
            12 => Ok(Self::Subscribe),
            13 => Ok(Self::Unsubscribe),
            14 => Ok(Self::WaitEvent),
            _ => Err(IpcError::UnknownOpcode(value)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: MessageKind,
    pub opcode: Opcode,
    pub request_id: u64,
    pub sequence: u64,
    pub status: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn request(opcode: Opcode, request_id: u64, payload: Vec<u8>) -> Self {
        Self {
            kind: MessageKind::Request,
            opcode,
            request_id,
            sequence: 0,
            status: 0,
            payload,
        }
    }

    pub fn response(request: &Self, status: u32, payload: Vec<u8>) -> Self {
        Self {
            kind: MessageKind::Response,
            opcode: request.opcode,
            request_id: request.request_id,
            sequence: request.sequence,
            status,
            payload,
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, IpcError> {
        if self.payload.len() > MAX_PAYLOAD_LEN {
            return Err(IpcError::PayloadTooLarge(self.payload.len()));
        }
        let mut output = Vec::with_capacity(HEADER_LEN + self.payload.len());
        output.extend_from_slice(&MAGIC);
        output.push(PROTOCOL_VERSION);
        output.push(self.kind as u8);
        output.extend_from_slice(&(self.opcode as u16).to_le_bytes());
        output.extend_from_slice(&self.request_id.to_le_bytes());
        output.extend_from_slice(&self.sequence.to_le_bytes());
        output.extend_from_slice(&(self.payload.len() as u32).to_le_bytes());
        output.extend_from_slice(&self.status.to_le_bytes());
        output.extend_from_slice(&self.payload);
        Ok(output)
    }

    pub fn decode(input: &[u8]) -> Result<Self, IpcError> {
        if input.len() < HEADER_LEN {
            return Err(IpcError::TruncatedHeader(input.len()));
        }
        if input[..4] != MAGIC {
            return Err(IpcError::InvalidMagic);
        }
        if input[4] != PROTOCOL_VERSION {
            return Err(IpcError::UnsupportedVersion(input[4]));
        }
        let kind = MessageKind::try_from(input[5])?;
        let opcode = Opcode::try_from(u16::from_le_bytes([input[6], input[7]]))?;
        let request_id = u64::from_le_bytes(input[8..16].try_into().expect("header slice"));
        let sequence = u64::from_le_bytes(input[16..24].try_into().expect("header slice"));
        let payload_len =
            u32::from_le_bytes(input[24..28].try_into().expect("header slice")) as usize;
        if payload_len > MAX_PAYLOAD_LEN {
            return Err(IpcError::PayloadTooLarge(payload_len));
        }
        let expected = HEADER_LEN
            .checked_add(payload_len)
            .ok_or(IpcError::PayloadTooLarge(payload_len))?;
        if input.len() != expected {
            return Err(IpcError::LengthMismatch {
                expected,
                actual: input.len(),
            });
        }
        let status = u32::from_le_bytes(input[28..32].try_into().expect("header slice"));
        Ok(Self {
            kind,
            opcode,
            request_id,
            sequence,
            status,
            payload: input[HEADER_LEN..].to_vec(),
        })
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum IpcError {
    #[error("IPC frame header is truncated ({0} bytes)")]
    TruncatedHeader(usize),
    #[error("IPC frame magic is invalid")]
    InvalidMagic,
    #[error("IPC protocol version {0} is unsupported")]
    UnsupportedVersion(u8),
    #[error("IPC message kind {0} is unknown")]
    UnknownKind(u8),
    #[error("IPC opcode {0} is unknown")]
    UnknownOpcode(u16),
    #[error("IPC payload is too large ({0} bytes)")]
    PayloadTooLarge(usize),
    #[error("IPC frame length mismatch: expected {expected}, got {actual}")]
    LengthMismatch { expected: usize, actual: usize },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_preserves_binary_payload_and_identifiers() {
        let frame = Frame {
            kind: MessageKind::Event,
            opcode: Opcode::WaitEvent,
            request_id: 42,
            sequence: 99,
            status: 7,
            payload: vec![0, 1, 2, 255],
        };
        let encoded = frame.encode().unwrap();
        assert_eq!(encoded.len(), HEADER_LEN + 4);
        assert_eq!(Frame::decode(&encoded).unwrap(), frame);
    }

    #[test]
    fn rejects_trailing_and_truncated_bytes() {
        let encoded = Frame::request(Opcode::Snapshot, 1, vec![1])
            .encode()
            .unwrap();
        assert!(matches!(
            Frame::decode(&encoded[..HEADER_LEN - 1]),
            Err(IpcError::TruncatedHeader(_))
        ));
        let mut trailing = encoded.clone();
        trailing.push(9);
        assert!(matches!(
            Frame::decode(&trailing),
            Err(IpcError::LengthMismatch { .. })
        ));
    }

    #[test]
    fn rejects_bad_header_values() {
        let mut encoded = Frame::request(Opcode::Snapshot, 1, Vec::new())
            .encode()
            .unwrap();
        encoded[0] = b'X';
        assert_eq!(Frame::decode(&encoded), Err(IpcError::InvalidMagic));
        encoded[0] = MAGIC[0];
        encoded[4] = 1;
        assert_eq!(
            Frame::decode(&encoded),
            Err(IpcError::UnsupportedVersion(1))
        );
    }
}
