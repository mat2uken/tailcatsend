use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::limits::*;

#[derive(Debug, Error)]
pub enum InvitationError {
    #[error("Serialization error: {0}")]
    Serialization(String),
    #[error("Deserialization error: {0}")]
    Deserialization(String),
    #[error("Base64 decode error: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("Payload exceeds maximum CBOR size ({0} > {MAX_INVITATION_CBOR_BYTES})")]
    CborTooLarge(usize),
    #[error("Payload exceeds maximum Base64 size ({0} > {MAX_INVITATION_B64_BYTES})")]
    Base64TooLarge(usize),
    #[error("Completed QR URL exceeds maximum length ({0} > {MAX_QR_URL_BYTES})")]
    UrlTooLarge(usize),
    #[error("Invalid format version: {0}")]
    InvalidFormatVersion(u32),
    #[error("Invalid protocol major version: {0}")]
    InvalidProtocolMajor(u32),
    #[error("Invalid host address prefix (must start with 'tc')")]
    InvalidHostAddressPrefix,
    #[error("Host address too long ({0} > 768)")]
    HostAddressTooLong(usize),
    #[error("Invitation expired: expires_at {expires_at} < current_time {now}")]
    Expired { expires_at: u64, now: u64 },
    #[error("Invitation issued in the future: issued_at {issued_at} > current_time {now}")]
    FutureIssued { issued_at: u64, now: u64 },
    #[error("Invalid URL format (missing #i= parameter)")]
    InvalidUrlFormat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvitationV1 {
    #[serde(rename = "1")]
    pub format_version: u32,
    #[serde(rename = "2")]
    pub protocol_major: u32,
    #[serde(rename = "3")]
    pub host_address: String,
    #[serde(rename = "4", with = "serde_bytes")]
    pub session_id: [u8; 16],
    #[serde(rename = "5", with = "serde_bytes")]
    pub invite_secret: [u8; 32],
    #[serde(rename = "6")]
    pub issued_at: u64,
    #[serde(rename = "7")]
    pub expires_at: u64,
}

impl InvitationV1 {
    pub fn new(
        host_address: String,
        session_id: [u8; 16],
        invite_secret: [u8; 32],
        now_unix_secs: u64,
        lifetime_secs: u64,
    ) -> Self {
        let lifetime = lifetime_secs.min(MAX_INVITE_LIFETIME_SECS);
        Self {
            format_version: 1,
            protocol_major: PROTOCOL_MAJOR,
            host_address,
            session_id,
            invite_secret,
            issued_at: now_unix_secs,
            expires_at: now_unix_secs + lifetime,
        }
    }

    pub fn to_cbor_bytes(&self) -> Result<Vec<u8>, InvitationError> {
        let mut bytes = Vec::new();
        ciborium::into_writer(self, &mut bytes)
            .map_err(|e| InvitationError::Serialization(e.to_string()))?;

        if bytes.len() > MAX_INVITATION_CBOR_BYTES {
            return Err(InvitationError::CborTooLarge(bytes.len()));
        }
        Ok(bytes)
    }

    pub fn from_cbor_bytes(bytes: &[u8], now_unix_secs: u64) -> Result<Self, InvitationError> {
        if bytes.len() > MAX_INVITATION_CBOR_BYTES {
            return Err(InvitationError::CborTooLarge(bytes.len()));
        }
        let inv: Self = ciborium::from_reader(bytes)
            .map_err(|e| InvitationError::Deserialization(e.to_string()))?;
        inv.validate(now_unix_secs)?;
        Ok(inv)
    }

    pub fn to_base64url(&self) -> Result<String, InvitationError> {
        let cbor = self.to_cbor_bytes()?;
        let encoded = URL_SAFE_NO_PAD.encode(&cbor);
        if encoded.len() > MAX_INVITATION_B64_BYTES {
            return Err(InvitationError::Base64TooLarge(encoded.len()));
        }
        Ok(encoded)
    }

    pub fn to_qr_url(&self, base_app_url: &str) -> Result<String, InvitationError> {
        let b64 = self.to_base64url()?;
        let trimmed_base = base_app_url.trim_end_matches('/');
        let url = format!("{}/#i={}", trimmed_base, b64);
        if url.len() > MAX_QR_URL_BYTES {
            return Err(InvitationError::UrlTooLarge(url.len()));
        }
        Ok(url)
    }

    pub fn from_base64url(encoded: &str, now_unix_secs: u64) -> Result<Self, InvitationError> {
        if encoded.len() > MAX_INVITATION_B64_BYTES {
            return Err(InvitationError::Base64TooLarge(encoded.len()));
        }
        let bytes = URL_SAFE_NO_PAD.decode(encoded.trim())?;
        Self::from_cbor_bytes(&bytes, now_unix_secs)
    }

    pub fn from_url(url: &str, now_unix_secs: u64) -> Result<Self, InvitationError> {
        let fragment = if let Some(idx) = url.find('#') {
            &url[idx + 1..]
        } else if url.starts_with("http://") || url.starts_with("https://") {
            return Err(InvitationError::InvalidUrlFormat);
        } else {
            url
        };

        let b64 = if let Some(stripped) = fragment.strip_prefix("i=") {
            stripped
        } else if fragment.contains('=') {
            return Err(InvitationError::InvalidUrlFormat);
        } else {
            fragment
        };

        Self::from_base64url(b64, now_unix_secs)
    }

    pub fn validate_fields(&self) -> Result<(), InvitationError> {
        if self.format_version != 1 {
            return Err(InvitationError::InvalidFormatVersion(self.format_version));
        }
        if self.protocol_major != PROTOCOL_MAJOR {
            return Err(InvitationError::InvalidProtocolMajor(self.protocol_major));
        }
        if !self.host_address.starts_with("tc") {
            return Err(InvitationError::InvalidHostAddressPrefix);
        }
        if self.host_address.len() > 768 {
            return Err(InvitationError::HostAddressTooLong(self.host_address.len()));
        }
        Ok(())
    }

    pub fn validate(&self, now_unix_secs: u64) -> Result<(), InvitationError> {
        self.validate_fields()?;
        if now_unix_secs + CLOCK_SKEW_TOLERANCE_SECS < self.issued_at {
            return Err(InvitationError::FutureIssued {
                issued_at: self.issued_at,
                now: now_unix_secs,
            });
        }
        if self.expires_at + CLOCK_SKEW_TOLERANCE_SECS < now_unix_secs {
            return Err(InvitationError::Expired {
                expires_at: self.expires_at,
                now: now_unix_secs,
            });
        }
        Ok(())
    }
}
