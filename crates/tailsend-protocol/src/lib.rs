pub mod auth;
pub mod control;
pub mod data_header;
pub mod filename;
pub mod invitation;
pub mod limits;

pub use auth::*;
pub use control::*;
pub use data_header::*;
pub use filename::*;
pub use invitation::*;
pub use limits::*;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn test_invitation_roundtrip() {
        let host_address = "tc-test-addr-12345".to_string();
        let session_id = [1u8; 16];
        let invite_secret = [2u8; 32];
        let now = 1756800000;
        let lifetime = 600;

        let inv = InvitationV1::new(
            host_address.clone(),
            session_id,
            invite_secret,
            now,
            lifetime,
        );

        let cbor = inv.to_cbor_bytes().expect("cbor serialization");
        assert!(cbor.len() <= MAX_INVITATION_CBOR_BYTES);

        let decoded = InvitationV1::from_cbor_bytes(&cbor, now).expect("cbor deserialization");
        assert_eq!(inv, decoded);

        let b64 = inv.to_base64url().expect("base64url encode");
        assert!(b64.len() <= MAX_INVITATION_B64_BYTES);

        let decoded_b64 = InvitationV1::from_base64url(&b64, now).expect("base64url decode");
        assert_eq!(inv, decoded_b64);

        let url = inv
            .to_qr_url("https://tailsend.example.com")
            .expect("qr url");
        assert!(url.len() <= MAX_QR_URL_BYTES);
        assert!(url.starts_with("https://tailsend.example.com/#i="));

        let decoded_url = InvitationV1::from_url(&url, now).expect("url decode");
        assert_eq!(inv, decoded_url);
    }

    #[test]
    fn test_invitation_malformed_and_edge_cases() {
        let now = 1756800000;

        // Malformed URL (missing hash fragment)
        let res = InvitationV1::from_url("https://tailsend.example.com/no-hash", now);
        assert!(matches!(res, Err(InvitationError::InvalidUrlFormat)));

        // Malformed base64url payload
        let res = InvitationV1::from_url("https://tailsend.example.com/#i=!!InvalidBase64!!", now);
        assert!(matches!(res, Err(InvitationError::Base64(_))));

        // Corrupted CBOR bytes
        let corrupted_cbor = [0xff, 0xff, 0xff];
        let res = InvitationV1::from_cbor_bytes(&corrupted_cbor, now);
        assert!(matches!(res, Err(InvitationError::Deserialization(_))));

        // Truncated CBOR payload
        let valid_inv =
            InvitationV1::new("tc-addr-test".to_string(), [1u8; 16], [2u8; 32], now, 300);
        let cbor = valid_inv.to_cbor_bytes().unwrap();
        let truncated = &cbor[..cbor.len() / 2];
        let res = InvitationV1::from_cbor_bytes(truncated, now);
        assert!(matches!(res, Err(InvitationError::Deserialization(_))));
    }

    #[test]
    fn test_invitation_expiration() {
        let host_address = "tc-test-addr-12345".to_string();
        let session_id = [1u8; 16];
        let invite_secret = [2u8; 32];
        let issued_at = 1756800000;
        let lifetime = 600;

        let inv = InvitationV1::new(host_address, session_id, invite_secret, issued_at, lifetime);

        let cbor = inv.to_cbor_bytes().unwrap();

        // Valid within lifetime
        let res = InvitationV1::from_cbor_bytes(&cbor, issued_at + 300);
        assert!(res.is_ok());

        // Valid within clock skew margin (lifetime + 50s <= 600 + 60s)
        let res = InvitationV1::from_cbor_bytes(&cbor, issued_at + 650);
        assert!(res.is_ok());

        // Expired (> 600 + 60 clock skew)
        let res = InvitationV1::from_cbor_bytes(&cbor, issued_at + 661);
        assert!(matches!(res, Err(InvitationError::Expired { .. })));

        // Future issued within skew margin (30s in future <= 60s skew)
        let res = InvitationV1::from_cbor_bytes(&cbor, issued_at - 30);
        assert!(res.is_ok());

        // Future issued (> 60s in the future)
        let res = InvitationV1::from_cbor_bytes(&cbor, issued_at - 61);
        assert!(matches!(res, Err(InvitationError::FutureIssued { .. })));
    }

    #[test]
    fn test_hmac_proof_verification() {
        let invite_secret = [42u8; 32];
        let session_id = [10u8; 16];
        let joiner_nonce = [11u8; 32];
        let host_nonce = [12u8; 32];
        let joiner_addr = "tc-joiner-9876";
        let host_addr = "tc-host-1234";

        let peer_info = PeerInfo::new_native(
            "Alice's PC".to_string(),
            PlatformKind::Windows,
            "1.0.0".to_string(),
        );
        let capabilities = Capabilities::default();

        // Joiner Proof
        let joiner_proof = compute_joiner_proof(
            &invite_secret,
            &session_id,
            &joiner_nonce,
            joiner_addr,
            &peer_info,
            &capabilities,
        )
        .expect("joiner proof");

        verify_joiner_proof(
            &invite_secret,
            &session_id,
            &joiner_nonce,
            joiner_addr,
            &peer_info,
            &capabilities,
            &joiner_proof,
        )
        .expect("verify joiner proof");

        // Tamper test (1 bit mutation)
        let mut corrupted_proof = joiner_proof;
        corrupted_proof[0] ^= 0x01;
        let err = verify_joiner_proof(
            &invite_secret,
            &session_id,
            &joiner_nonce,
            joiner_addr,
            &peer_info,
            &capabilities,
            &corrupted_proof,
        );
        assert!(matches!(err, Err(AuthError::VerificationFailed)));

        // Tamper test (wrong secret)
        let wrong_secret = [99u8; 32];
        let err = verify_joiner_proof(
            &wrong_secret,
            &session_id,
            &joiner_nonce,
            joiner_addr,
            &peer_info,
            &capabilities,
            &joiner_proof,
        );
        assert!(matches!(err, Err(AuthError::VerificationFailed)));

        // Tamper test (altered peer info)
        let mut altered_peer_info = peer_info.clone();
        altered_peer_info.display_name = "Mallory's PC".to_string();
        let err = verify_joiner_proof(
            &invite_secret,
            &session_id,
            &joiner_nonce,
            joiner_addr,
            &altered_peer_info,
            &capabilities,
            &joiner_proof,
        );
        assert!(matches!(err, Err(AuthError::VerificationFailed)));

        // Host Proof
        let host_proof = compute_host_proof(
            &invite_secret,
            &session_id,
            &joiner_nonce,
            &host_nonce,
            host_addr,
            joiner_addr,
            &peer_info,
            &capabilities,
        )
        .expect("host proof");

        verify_host_proof(
            &invite_secret,
            &session_id,
            &joiner_nonce,
            &host_nonce,
            host_addr,
            joiner_addr,
            &peer_info,
            &capabilities,
            &host_proof,
        )
        .expect("verify host proof");
    }

    #[test]
    fn test_control_message_framing_and_limits() {
        let session_id = [5u8; 16];
        let offer = TextOffer {
            byte_length: 12,
            character_count: 5,
            preview: "Hello".to_string(),
        };

        let msg = ControlMessage::new(
            MessageType::TextOffer,
            &session_id,
            1,
            None,
            Some(MessageBody::TextOffer(offer)),
        );

        let framed = msg.encode_framed().expect("encode framed");
        assert!(framed.len() >= 4);

        let len = u32::from_be_bytes(framed[0..4].try_into().unwrap()) as usize;
        assert_eq!(len, framed.len() - 4);

        let decoded = ControlMessage::decode_payload(&framed[4..]).expect("decode payload");
        assert_eq!(decoded.message_type, MessageType::TextOffer as u32);
        assert_eq!(decoded.sequence_number, 1);
        assert_eq!(decoded.session_id, session_id);

        // Zero-length payload rejection
        let empty_payload = [];
        let res = ControlMessage::decode_payload(&empty_payload);
        assert!(matches!(res, Err(ControlCodecError::ZeroLengthFrame)));

        // Oversized payload rejection (> 64 KiB)
        let oversized = vec![0u8; MAX_CONTROL_FRAME_SIZE + 1];
        let res = ControlMessage::decode_payload(&oversized);
        assert!(matches!(res, Err(ControlCodecError::FrameTooLarge(_))));
    }

    #[test]
    fn test_data_headers_validation() {
        let session_id = [7u8; 16];
        let transfer_id = [8u8; 16];

        // Text header
        let text_hdr = TextDataHeader::new(session_id, transfer_id, 1024).expect("text header");
        let encoded_text = text_hdr.encode();
        assert_eq!(encoded_text.len(), TEXT_HEADER_LEN);
        let decoded_text = TextDataHeader::decode(&encoded_text).expect("decode text header");
        assert_eq!(text_hdr, decoded_text);

        // Text header bad magic
        let mut bad_text = encoded_text;
        bad_text[0..4].copy_from_slice(b"BAD1");
        assert!(matches!(
            TextDataHeader::decode(&bad_text),
            Err(data_header::DataHeaderError::InvalidMagic { .. })
        ));

        // Text header payload size exceeding limit (> 1 MiB)
        let oversized_text =
            TextDataHeader::new(session_id, transfer_id, MAX_TEXT_PAYLOAD_SIZE + 1);
        assert!(matches!(
            oversized_text,
            Err(data_header::DataHeaderError::TextSizeTooLarge(_))
        ));

        // File header
        let file_hdr =
            FileDataHeader::new(session_id, transfer_id, 1, 0, 1048576).expect("file header");
        let encoded_file = file_hdr.encode();
        assert_eq!(encoded_file.len(), FILE_HEADER_LEN);
        let decoded_file = FileDataHeader::decode(&encoded_file).expect("decode file header");
        assert_eq!(file_hdr, decoded_file);

        // File header bad magic
        let mut bad_file = encoded_file;
        bad_file[0..4].copy_from_slice(b"BAD2");
        assert!(matches!(
            FileDataHeader::decode(&bad_file),
            Err(data_header::DataHeaderError::InvalidMagic { .. })
        ));
    }

    #[test]
    fn test_filename_sanitizer_full_matrix() {
        // Valid filenames
        assert_eq!(sanitize_filename("photo.jpg").unwrap(), "photo.jpg");
        assert_eq!(
            sanitize_filename("my-document_v2.pdf").unwrap(),
            "my-document_v2.pdf"
        );

        // Deep path traversal
        assert_eq!(sanitize_filename("../../etc/passwd").unwrap(), "passwd");
        assert_eq!(
            sanitize_filename("../../../var/log/syslog").unwrap(),
            "syslog"
        );
        assert_eq!(
            sanitize_filename("..\\..\\Windows\\System32\\cmd.exe").unwrap(),
            "cmd.exe"
        );

        // Absolute drive and UNC paths
        assert_eq!(
            sanitize_filename("C:\\Users\\admin\\document.pdf").unwrap(),
            "document.pdf"
        );
        assert_eq!(
            sanitize_filename("D:/Data/Project/report.docx").unwrap(),
            "report.docx"
        );
        assert_eq!(
            sanitize_filename("\\\\server\\share\\archive.zip").unwrap(),
            "archive.zip"
        );

        // Multilingual & Emoji
        assert_eq!(
            sanitize_filename("日本語ファイル名 😊.png").unwrap(),
            "日本語ファイル名 😊.png"
        );
        assert_eq!(
            sanitize_filename("中文文件名.tar.gz").unwrap(),
            "中文文件名.tar.gz"
        );

        // Windows Reserved Names
        let reserved_names = [
            "CON",
            "PRN",
            "AUX",
            "NUL",
            "COM1",
            "COM2",
            "COM3",
            "COM4",
            "COM5",
            "COM6",
            "COM7",
            "COM8",
            "COM9",
            "LPT1",
            "LPT2",
            "LPT3",
            "LPT4",
            "LPT5",
            "LPT6",
            "LPT7",
            "LPT8",
            "LPT9",
            "con",
            "prn",
            "aux.txt",
            "NUL.tar.gz",
        ];
        for name in reserved_names {
            let sanitized = sanitize_filename(name).unwrap();
            assert!(
                sanitized.starts_with('_'),
                "Reserved name '{}' should be prefixed with '_', got '{}'",
                name,
                sanitized
            );
        }

        // Invalid Characters Replacement
        assert_eq!(
            sanitize_filename("file<with>illegal:chars|?.txt").unwrap(),
            "file_with_illegal_chars__.txt"
        );

        // Trailing dots and spaces
        assert_eq!(
            sanitize_filename("trailing.dots...").unwrap(),
            "trailing.dots"
        );
        assert_eq!(
            sanitize_filename("trailing spaces   ").unwrap(),
            "trailing spaces"
        );

        // Empty filename fallback
        assert_eq!(sanitize_filename("").unwrap(), "unnamed_file");
        assert_eq!(sanitize_filename("///...").unwrap(), "unnamed_file");

        // Unique De-duplication Generation
        let mut existing = HashSet::new();
        existing.insert("photo.jpg".to_string());
        assert_eq!(
            generate_unique_filename(&existing, "photo.jpg"),
            "photo (1).jpg"
        );

        existing.insert("photo (1).jpg".to_string());
        assert_eq!(
            generate_unique_filename(&existing, "photo.jpg"),
            "photo (2).jpg"
        );

        // Extensionless files
        existing.insert("README".to_string());
        assert_eq!(generate_unique_filename(&existing, "README"), "README (1)");
    }
}
