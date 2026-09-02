use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::limits::*;

#[derive(Debug, Error)]
pub enum ControlCodecError {
    #[error("Frame size exceeds maximum allowed ({0} > {MAX_CONTROL_FRAME_SIZE})")]
    FrameTooLarge(usize),
    #[error("Frame length is zero")]
    ZeroLengthFrame,
    #[error("CBOR serialization error: {0}")]
    Serialization(String),
    #[error("CBOR deserialization error: {0}")]
    Deserialization(String),
    #[error("Protocol major mismatch: expected {expected}, got {actual}")]
    ProtocolMajorMismatch { expected: u32, actual: u32 },
    #[error("Session ID mismatch: expected {expected:?}, got {actual:?}")]
    SessionIdMismatch { expected: Vec<u8>, actual: Vec<u8> },
    #[error("Invalid sequence number: expected {expected}, got {actual}")]
    InvalidSequence { expected: u64, actual: u64 },
    #[error("Unknown or unsupported message type: {0}")]
    UnsupportedMessageType(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u32)]
pub enum MessageType {
    ClientHello = 1,
    ServerHello = 2,
    SessionReady = 3,
    SessionReadyAck = 4,
    Ping = 5,
    Pong = 6,
    Goodbye = 7,
    Error = 8,
    TextOffer = 20,
    TextDecision = 21,
    TextResult = 22,
    FileOffer = 30,
    FileDecision = 31,
    FileItemResult = 32,
    TransferComplete = 33,
    TransferResult = 34,
    TransferCancel = 35,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u32)]
pub enum PlatformKind {
    Web = 1,
    Windows = 2,
    MacOS = 3,
    Android = 4,
    IOS = 5,
    Linux = 6,
    Unknown = 255,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u32)]
pub enum RuntimeKind {
    Native = 1,
    Browser = 2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u32)]
pub enum BrowserFamily {
    Chrome = 1,
    Edge = 2,
    Safari = 3,
    Firefox = 4,
    Other = 255,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerInfo {
    #[serde(rename = "1")]
    pub display_name: String,
    #[serde(rename = "2")]
    pub platform: u32,
    #[serde(rename = "3")]
    pub runtime: u32,
    #[serde(rename = "4")]
    pub app_version: String,
    #[serde(rename = "5", default, skip_serializing_if = "Option::is_none")]
    pub browser_family: Option<u32>,
}

impl PeerInfo {
    pub fn new_native(display_name: String, platform: PlatformKind, app_version: String) -> Self {
        Self {
            display_name,
            platform: platform as u32,
            runtime: RuntimeKind::Native as u32,
            app_version,
            browser_family: None,
        }
    }

    pub fn new_browser(
        display_name: String,
        platform: PlatformKind,
        app_version: String,
        browser_family: BrowserFamily,
    ) -> Self {
        Self {
            display_name,
            platform: platform as u32,
            runtime: RuntimeKind::Browser as u32,
            app_version,
            browser_family: Some(browser_family as u32),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    #[serde(rename = "1")]
    pub text: bool,
    #[serde(rename = "2")]
    pub files: bool,
    #[serde(rename = "3")]
    pub directories: bool,
    #[serde(rename = "4")]
    pub transfer_resume: bool,
    #[serde(rename = "5")]
    pub max_text_bytes: u64,
    #[serde(rename = "6")]
    pub max_control_frame: u64,
    #[serde(rename = "7")]
    pub max_files_per_offer: u64,
    #[serde(rename = "8")]
    pub max_filename_bytes: u64,
    #[serde(rename = "9")]
    pub streaming_receive: bool,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            text: true,
            files: true,
            directories: false,
            transfer_resume: false,
            max_text_bytes: MAX_TEXT_PAYLOAD_SIZE,
            max_control_frame: MAX_CONTROL_FRAME_SIZE as u64,
            max_files_per_offer: MAX_FILES_PER_OFFER as u64,
            max_filename_bytes: MAX_FILENAME_BYTES as u64,
            streaming_receive: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloPayload {
    #[serde(rename = "1", with = "serde_bytes")]
    pub nonce: Vec<u8>,
    #[serde(rename = "2")]
    pub tailcat_address: String,
    #[serde(rename = "3")]
    pub peer_info: PeerInfo,
    #[serde(rename = "4")]
    pub capabilities: Capabilities,
    #[serde(rename = "5", with = "serde_bytes")]
    pub proof: Vec<u8>,
}

pub type ClientHello = HelloPayload;
pub type ServerHello = HelloPayload;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionReady {
    #[serde(rename = "1", default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PingPong {
    #[serde(rename = "1")]
    pub token: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Goodbye {
    #[serde(rename = "1", default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<u32>,
    #[serde(rename = "2", default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    #[serde(rename = "1")]
    pub error_code: u32,
    #[serde(rename = "2", default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextOffer {
    #[serde(rename = "1")]
    pub byte_length: u64,
    #[serde(rename = "2")]
    pub character_count: u64,
    #[serde(rename = "3")]
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    #[serde(rename = "1")]
    pub accepted: bool,
    #[serde(rename = "2", default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<u32>,
    #[serde(rename = "3", default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub type ResultBody = Decision;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileItem {
    #[serde(rename = "1")]
    pub item_id: u32,
    #[serde(rename = "2")]
    pub name: String,
    #[serde(rename = "3")]
    pub size: u64,
    #[serde(rename = "4", default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(rename = "5", default, skip_serializing_if = "Option::is_none")]
    pub modified_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileOffer {
    #[serde(rename = "1")]
    pub items: Vec<FileItem>,
    #[serde(rename = "2")]
    pub total_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileItemResult {
    #[serde(rename = "1")]
    pub item_id: u32,
    #[serde(rename = "2")]
    pub success: bool,
    #[serde(rename = "3", default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<u32>,
    #[serde(rename = "4", default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferCancel {
    #[serde(rename = "1")]
    pub reason_code: u32,
    #[serde(rename = "2", default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageBody {
    Hello(HelloPayload),
    SessionReady(SessionReady),
    PingPong(PingPong),
    Goodbye(Goodbye),
    Error(ErrorBody),
    TextOffer(TextOffer),
    Decision(Decision),
    FileOffer(FileOffer),
    FileItemResult(FileItemResult),
    TransferCancel(TransferCancel),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlMessage {
    #[serde(rename = "1")]
    pub protocol_major: u32,
    #[serde(rename = "2")]
    pub protocol_minor: u32,
    #[serde(rename = "3")]
    pub message_type: u32,
    #[serde(rename = "4", with = "serde_bytes")]
    pub session_id: Vec<u8>,
    #[serde(rename = "5")]
    pub sequence_number: u64,
    #[serde(rename = "6", default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<serde_bytes::ByteBuf>,
    #[serde(rename = "7", default, skip_serializing_if = "Option::is_none")]
    pub body: Option<MessageBody>,
}

impl ControlMessage {
    pub fn new(
        message_type: MessageType,
        session_id: &[u8; 16],
        sequence_number: u64,
        correlation_id: Option<[u8; 16]>,
        body: Option<MessageBody>,
    ) -> Self {
        Self {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            message_type: message_type as u32,
            session_id: session_id.to_vec(),
            sequence_number,
            correlation_id: correlation_id.map(|id| serde_bytes::ByteBuf::from(id.to_vec())),
            body,
        }
    }

    pub fn encode_framed(&self) -> Result<Vec<u8>, ControlCodecError> {
        let mut cbor_bytes = Vec::new();
        ciborium::into_writer(self, &mut cbor_bytes)
            .map_err(|e| ControlCodecError::Serialization(e.to_string()))?;

        if cbor_bytes.is_empty() {
            return Err(ControlCodecError::ZeroLengthFrame);
        }
        if cbor_bytes.len() > MAX_CONTROL_FRAME_SIZE {
            return Err(ControlCodecError::FrameTooLarge(cbor_bytes.len()));
        }

        let len = cbor_bytes.len() as u32;
        let mut framed = Vec::with_capacity(4 + cbor_bytes.len());
        framed.extend_from_slice(&len.to_be_bytes());
        framed.extend_from_slice(&cbor_bytes);
        Ok(framed)
    }

    pub fn decode_payload(payload: &[u8]) -> Result<Self, ControlCodecError> {
        if payload.is_empty() {
            return Err(ControlCodecError::ZeroLengthFrame);
        }
        if payload.len() > MAX_CONTROL_FRAME_SIZE {
            return Err(ControlCodecError::FrameTooLarge(payload.len()));
        }
        let msg: Self = ciborium::from_reader(payload)
            .map_err(|e| ControlCodecError::Deserialization(e.to_string()))?;
        if msg.protocol_major != PROTOCOL_MAJOR {
            return Err(ControlCodecError::ProtocolMajorMismatch {
                expected: PROTOCOL_MAJOR,
                actual: msg.protocol_major,
            });
        }
        Ok(msg)
    }
}
