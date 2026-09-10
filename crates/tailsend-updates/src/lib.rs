//! Verification and selection primitives for signed WebView releases.
//!
//! A release is an immutable set of files.  The signature covers the exact
//! manifest bytes received over the network; callers must not parse and
//! re-serialize JSON before verification.  Downloading and installing files
//! stays in the platform adapter so this crate remains usable by native and
//! WASM targets.

use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const SIGNATURE_LEN: usize = 64;
pub const MAX_MANIFEST_BYTES: usize = 512 * 1024;
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum UpdateError {
    #[error("manifest is too large")]
    ManifestTooLarge,
    #[error("manifest signature must be 64-byte r||s")]
    InvalidSignatureLength,
    #[error("manifest signature is invalid")]
    InvalidSignature,
    #[error("manifest JSON is invalid: {0}")]
    InvalidManifest(#[from] serde_json::Error),
    #[error("manifest validation failed: {0}")]
    InvalidEntry(String),
    #[error("release is not compatible with this application: {0}")]
    IncompatibleRelease(&'static str),
    #[error("file hash mismatch for {path}")]
    HashMismatch { path: String },
    #[error("file size mismatch for {path}: expected {expected}, got {actual}")]
    SizeMismatch {
        path: String,
        expected: u64,
        actual: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReleaseFile {
    pub path: String,
    pub size: u64,
    /// Lowercase hexadecimal SHA-256 of the complete file.
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReleaseManifest {
    pub release_id: String,
    pub revision: u64,
    pub distribution: String,
    pub target: String,
    pub min_api_version: u16,
    pub files: Vec<ReleaseFile>,
}

impl ReleaseManifest {
    pub fn validate(&self) -> Result<(), UpdateError> {
        if self.release_id.len() > 128 || !safe_path_component(&self.release_id) {
            return Err(UpdateError::InvalidEntry("release_id".to_string()));
        }
        if self.distribution.is_empty() || self.target.is_empty() {
            return Err(UpdateError::InvalidEntry("distribution/target".to_string()));
        }
        if self.files.is_empty() {
            return Err(UpdateError::InvalidEntry(
                "files must not be empty".to_string(),
            ));
        }

        let mut seen = std::collections::BTreeSet::new();
        for file in &self.files {
            let path = file.path.as_str();
            if path.is_empty()
                || path.starts_with('/')
                || path.split('/').any(|part| !safe_path_component(part))
                || !seen.insert(path.to_ascii_lowercase())
            {
                return Err(UpdateError::InvalidEntry(format!("file path: {path}")));
            }
            if file.size > MAX_FILE_BYTES {
                return Err(UpdateError::InvalidEntry(format!("file too large: {path}")));
            }
            if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(UpdateError::InvalidEntry(format!("file hash: {path}")));
            }
        }
        // A file must not also be used as a directory, including on a
        // case-insensitive filesystem.
        for path in &seen {
            for (index, _) in path.match_indices('/') {
                if seen.contains(&path[..index]) {
                    return Err(UpdateError::InvalidEntry(format!(
                        "file/directory conflict: {path}"
                    )));
                }
            }
        }
        Ok(())
    }

    /// Check selection separately from authenticity. A valid signature alone
    /// does not make another target's release, or a rollback, usable here.
    pub fn check_compatibility(
        &self,
        distribution: &str,
        target: &str,
        api_version: u16,
        current_revision: u64,
    ) -> Result<(), UpdateError> {
        self.validate()?;
        if self.distribution != distribution {
            return Err(UpdateError::IncompatibleRelease("distribution"));
        }
        if self.target != target {
            return Err(UpdateError::IncompatibleRelease("target"));
        }
        if self.min_api_version > api_version {
            return Err(UpdateError::IncompatibleRelease("API version"));
        }
        if self.revision <= current_revision {
            return Err(UpdateError::IncompatibleRelease("revision is not newer"));
        }
        Ok(())
    }
}

// Bundler-generated file names form URL paths and local paths on every OS.
// Restrict them to one portable spelling: no URL escapes, drive/ADS syntax,
// Windows device names, or trailing dots/spaces.
fn safe_path_component(component: &str) -> bool {
    if component.is_empty()
        || component == "."
        || component == ".."
        || component.ends_with('.')
        || !component
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return false;
    }
    let stem = component
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

/// Verify the exact manifest bytes and return its parsed, validated contents.
pub fn verify_manifest(
    public_key_sec1: &[u8],
    manifest_bytes: &[u8],
    signature_rs: &[u8],
) -> Result<ReleaseManifest, UpdateError> {
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::ManifestTooLarge);
    }
    if signature_rs.len() != SIGNATURE_LEN {
        return Err(UpdateError::InvalidSignatureLength);
    }
    let key = VerifyingKey::from_sec1_bytes(public_key_sec1)
        .map_err(|_| UpdateError::InvalidSignature)?;
    let signature =
        Signature::from_slice(signature_rs).map_err(|_| UpdateError::InvalidSignature)?;
    key.verify(manifest_bytes, &signature)
        .map_err(|_| UpdateError::InvalidSignature)?;

    let manifest: ReleaseManifest = serde_json::from_slice(manifest_bytes)?;
    manifest.validate()?;
    Ok(manifest)
}

/// Verify the files after they have been downloaded into a staging directory.
/// The caller must pass each file exactly once and must not mix releases.
pub fn verify_files<'a, I>(manifest: &ReleaseManifest, files: I) -> Result<(), UpdateError>
where
    I: IntoIterator<Item = (&'a str, &'a [u8])>,
{
    manifest.validate()?;
    let expected: std::collections::BTreeMap<&str, &ReleaseFile> = manifest
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let mut seen = std::collections::BTreeSet::new();

    for (path, bytes) in files {
        let file = expected
            .get(path)
            .ok_or_else(|| UpdateError::InvalidEntry(format!("unlisted file: {path}")))?;
        let actual_size = bytes.len() as u64;
        if actual_size != file.size {
            return Err(UpdateError::SizeMismatch {
                path: path.to_string(),
                expected: file.size,
                actual: actual_size,
            });
        }
        let digest = hex_digest(bytes);
        if !digest.eq_ignore_ascii_case(&file.sha256) {
            return Err(UpdateError::HashMismatch {
                path: path.to_string(),
            });
        }
        if !seen.insert(path) {
            return Err(UpdateError::InvalidEntry(format!("duplicate file: {path}")));
        }
    }

    if seen.len() != expected.len() {
        return Err(UpdateError::InvalidEntry(
            "manifest file is missing".to_string(),
        ));
    }
    Ok(())
}

pub fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, SigningKey};

    fn signed_manifest() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let key = SigningKey::from_bytes((&[7u8; 32]).into()).unwrap();
        let manifest = ReleaseManifest {
            release_id: "r1".to_string(),
            revision: 1,
            distribution: "web".to_string(),
            target: "browser".to_string(),
            min_api_version: 1,
            files: vec![ReleaseFile {
                path: "index.html".to_string(),
                size: 5,
                sha256: hex_digest(b"hello"),
            }],
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let signature: Signature = key.sign(&bytes);
        let public_key = key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        (bytes, public_key, signature.to_bytes().to_vec())
    }

    #[test]
    fn verifies_exact_manifest_and_files() {
        let (bytes, public_key, signature) = signed_manifest();
        let manifest = verify_manifest(&public_key, &bytes, &signature).unwrap();
        verify_files(&manifest, [("index.html", b"hello".as_slice())]).unwrap();
    }

    #[test]
    fn rejects_re_serialized_or_modified_manifest() {
        let (mut bytes, public_key, signature) = signed_manifest();
        bytes.push(b' ');
        assert!(matches!(
            verify_manifest(&public_key, &bytes, &signature),
            Err(UpdateError::InvalidSignature)
        ));
    }

    #[test]
    fn rejects_path_traversal_and_missing_files() {
        let manifest = ReleaseManifest {
            release_id: "r".to_string(),
            revision: 1,
            distribution: "web".to_string(),
            target: "browser".to_string(),
            min_api_version: 1,
            files: vec![ReleaseFile {
                path: "../index.html".to_string(),
                size: 0,
                sha256: hex_digest(b""),
            }],
        };
        assert!(manifest.validate().is_err());

        let (bytes, public_key, signature) = signed_manifest();
        let verified = verify_manifest(&public_key, &bytes, &signature).unwrap();
        assert!(verify_files(&verified, std::iter::empty()).is_err());
    }

    #[test]
    fn rejects_paths_that_change_meaning_as_urls_or_on_windows() {
        let (bytes, public_key, signature) = signed_manifest();
        let manifest = verify_manifest(&public_key, &bytes, &signature).unwrap();
        for path in [
            "%2e%2e/index.html",
            "C:payload",
            "index.html?other",
            "index.html#other",
            "CON.txt",
            "LPT1",
            "index.html.",
            "a /b",
        ] {
            let mut candidate = manifest.clone();
            candidate.files[0].path = path.into();
            assert!(candidate.validate().is_err(), "accepted {path}");
        }
        for path in ["INDEX.HTML", "index.html/child"] {
            let mut candidate = manifest.clone();
            candidate.files.push(ReleaseFile {
                path: path.into(),
                size: 0,
                sha256: hex_digest(b""),
            });
            assert!(
                candidate.validate().is_err(),
                "accepted alias or file/directory conflict {path}"
            );
        }
    }

    #[test]
    fn signature_does_not_bypass_target_api_or_rollback_checks() {
        let (bytes, public_key, signature) = signed_manifest();
        let manifest = verify_manifest(&public_key, &bytes, &signature).unwrap();
        manifest
            .check_compatibility("web", "browser", 1, 0)
            .unwrap();
        for (distribution, target, api, revision) in [
            ("native", "browser", 1, 0),
            ("web", "macos", 1, 0),
            ("web", "browser", 0, 0),
            ("web", "browser", 1, 1),
            ("web", "browser", 1, 2),
        ] {
            assert!(matches!(
                manifest.check_compatibility(distribution, target, api, revision),
                Err(UpdateError::IncompatibleRelease(_))
            ));
        }
    }
}
