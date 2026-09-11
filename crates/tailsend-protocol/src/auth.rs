use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use thiserror::Error;

use crate::control::{Capabilities, PeerInfo};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("HMAC initialization error: {0}")]
    Init(String),
    #[error("Serialization error during proof construction: {0}")]
    Serialization(String),
    #[error("Invalid proof length: expected 32 bytes, got {0}")]
    InvalidProofLength(usize),
    #[error("HMAC verification failed")]
    VerificationFailed,
}

pub fn compute_joiner_proof(
    invite_secret: &[u8],
    session_id: &[u8; 16],
    joiner_nonce: &[u8; 32],
    joiner_listener_addr: &str,
    peer_info: &PeerInfo,
    capabilities: &Capabilities,
) -> Result<[u8; 32], AuthError> {
    let mut mac =
        HmacSha256::new_from_slice(invite_secret).map_err(|e| AuthError::Init(e.to_string()))?;

    mac.update(b"tailsend/join/v1");
    mac.update(session_id);
    mac.update(joiner_nonce);

    let addr_bytes = joiner_listener_addr.as_bytes();
    let addr_len = (addr_bytes.len() as u32).to_be_bytes();
    mac.update(&addr_len);
    mac.update(addr_bytes);

    let mut peer_info_cbor = Vec::new();
    ciborium::into_writer(peer_info, &mut peer_info_cbor)
        .map_err(|e| AuthError::Serialization(e.to_string()))?;
    mac.update(&peer_info_cbor);

    let mut caps_cbor = Vec::new();
    ciborium::into_writer(capabilities, &mut caps_cbor)
        .map_err(|e| AuthError::Serialization(e.to_string()))?;
    mac.update(&caps_cbor);

    let result = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    Ok(out)
}

pub fn verify_joiner_proof(
    invite_secret: &[u8],
    session_id: &[u8; 16],
    joiner_nonce: &[u8; 32],
    joiner_listener_addr: &str,
    peer_info: &PeerInfo,
    capabilities: &Capabilities,
    expected_proof: &[u8],
) -> Result<(), AuthError> {
    if expected_proof.len() != 32 {
        return Err(AuthError::InvalidProofLength(expected_proof.len()));
    }
    let computed = compute_joiner_proof(
        invite_secret,
        session_id,
        joiner_nonce,
        joiner_listener_addr,
        peer_info,
        capabilities,
    )?;

    if computed.ct_eq(expected_proof).into() {
        Ok(())
    } else {
        Err(AuthError::VerificationFailed)
    }
}

// The argument list mirrors the authenticated wire fields and keeps the
// hashing call sites explicit; bundling them would make accidental field
// omission easier when the protocol evolves.
#[allow(clippy::too_many_arguments)]
pub fn compute_host_proof(
    invite_secret: &[u8],
    session_id: &[u8; 16],
    joiner_nonce: &[u8; 32],
    host_nonce: &[u8; 32],
    host_listener_addr: &str,
    joiner_listener_addr: &str,
    peer_info: &PeerInfo,
    capabilities: &Capabilities,
) -> Result<[u8; 32], AuthError> {
    let mut mac =
        HmacSha256::new_from_slice(invite_secret).map_err(|e| AuthError::Init(e.to_string()))?;

    mac.update(b"tailsend/host/v1");
    mac.update(session_id);
    mac.update(joiner_nonce);
    mac.update(host_nonce);

    let host_addr_bytes = host_listener_addr.as_bytes();
    let host_addr_len = (host_addr_bytes.len() as u32).to_be_bytes();
    mac.update(&host_addr_len);
    mac.update(host_addr_bytes);

    let joiner_addr_bytes = joiner_listener_addr.as_bytes();
    let joiner_addr_len = (joiner_addr_bytes.len() as u32).to_be_bytes();
    mac.update(&joiner_addr_len);
    mac.update(joiner_addr_bytes);

    let mut peer_info_cbor = Vec::new();
    ciborium::into_writer(peer_info, &mut peer_info_cbor)
        .map_err(|e| AuthError::Serialization(e.to_string()))?;
    mac.update(&peer_info_cbor);

    let mut caps_cbor = Vec::new();
    ciborium::into_writer(capabilities, &mut caps_cbor)
        .map_err(|e| AuthError::Serialization(e.to_string()))?;
    mac.update(&caps_cbor);

    let result = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub fn verify_host_proof(
    invite_secret: &[u8],
    session_id: &[u8; 16],
    joiner_nonce: &[u8; 32],
    host_nonce: &[u8; 32],
    host_listener_addr: &str,
    joiner_listener_addr: &str,
    peer_info: &PeerInfo,
    capabilities: &Capabilities,
    expected_proof: &[u8],
) -> Result<(), AuthError> {
    if expected_proof.len() != 32 {
        return Err(AuthError::InvalidProofLength(expected_proof.len()));
    }
    let computed = compute_host_proof(
        invite_secret,
        session_id,
        joiner_nonce,
        host_nonce,
        host_listener_addr,
        joiner_listener_addr,
        peer_info,
        capabilities,
    )?;

    if computed.ct_eq(expected_proof).into() {
        Ok(())
    } else {
        Err(AuthError::VerificationFailed)
    }
}
