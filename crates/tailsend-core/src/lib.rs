pub mod actor;
pub mod command;
pub mod event;
pub mod mock_transport;
pub mod service;
pub mod session;
pub mod snapshot;
pub mod state;

pub use actor::*;
pub use command::*;
pub use event::*;
pub use mock_transport::*;
pub use service::*;
pub use session::*;
pub use snapshot::*;
pub use state::*;

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use bytes::Bytes;
    use rand::RngCore;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use tailsend_platform_api::{
        FileMetadata, FileSource, IncomingFileSink, ReceivedItem, StorageError,
    };
    use tailsend_protocol::control::*;
    use tailsend_protocol::invitation::InvitationV1;
    use tailsend_protocol::limits::*;
    use tailsend_transfer::{
        receive_file_item_stream, receive_text_stream, send_file_item_stream, send_text_stream,
    };
    use tailsend_transport_api::TransportPath;
    use tailsend_transport_api::{ListenOptions, TailcatTransport};

    use crate::mock_transport::MockNetworkHub;
    use crate::session::{
        read_framed_control, run_host_handshake, run_joiner_handshake, write_framed_control,
    };

    struct TestFileSource {
        data: Vec<u8>,
        name: String,
    }

    #[async_trait]
    impl FileSource for TestFileSource {
        fn metadata(&self) -> FileMetadata {
            FileMetadata {
                name: self.name.clone(),
                size: self.data.len() as u64,
                mime: Some("application/octet-stream".to_string()),
                modified_unix_ms: None,
            }
        }

        async fn read_at(&mut self, offset: u64, max_len: usize) -> Result<Bytes, StorageError> {
            let start = offset as usize;
            if start >= self.data.len() {
                return Ok(Bytes::new());
            }
            let end = (start + max_len).min(self.data.len());
            Ok(Bytes::copy_from_slice(&self.data[start..end]))
        }

        async fn close(&mut self) {}
    }

    struct TestFileSink {
        data: Arc<Mutex<Vec<u8>>>,
        committed: Arc<Mutex<bool>>,
        name: String,
    }

    #[async_trait]
    impl IncomingFileSink for TestFileSink {
        async fn write(&mut self, buf: &[u8]) -> Result<(), StorageError> {
            self.data.lock().unwrap().extend_from_slice(buf);
            Ok(())
        }

        async fn commit(self: Box<Self>) -> Result<ReceivedItem, StorageError> {
            let len = self.data.lock().unwrap().len() as u64;
            *self.committed.lock().unwrap() = true;
            Ok(ReceivedItem {
                name: self.name.clone(),
                size: len,
                local_path_or_handle: format!("/saved/{}", self.name),
            })
        }

        async fn abort(self: Box<Self>) -> Result<(), StorageError> {
            self.data.lock().unwrap().clear();
            Ok(())
        }
    }

    #[tokio::test]
    async fn test_mock_handshake_and_bidirectional_text() {
        let hub = Arc::new(MockNetworkHub::new());

        let host_transport: Arc<dyn TailcatTransport> = hub.clone();
        let joiner_transport: Arc<dyn TailcatTransport> = hub.clone();

        let host_opts = ListenOptions {
            derp_map_url: "https://tailcat.dev/derpmap.json".to_string(),
            verbose: false,
        };
        let host_listener = host_transport.listen(host_opts.clone()).await.unwrap();
        let joiner_listener = joiner_transport.listen(host_opts.clone()).await.unwrap();

        let mut session_id = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut session_id);
        let mut invite_secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut invite_secret);

        let now = 1756800000;
        let invitation = InvitationV1::new(
            host_listener.local_address().to_string(),
            session_id,
            invite_secret,
            now,
            600,
        );

        let host_info = PeerInfo::new_native(
            "Host Node".to_string(),
            PlatformKind::Windows,
            "1.0.0".to_string(),
        );
        let joiner_info = PeerInfo::new_browser(
            "Joiner Node".to_string(),
            PlatformKind::Web,
            "1.0.0".to_string(),
            BrowserFamily::Chrome,
        );

        let host_caps = Capabilities::default();
        let joiner_caps = Capabilities::default();

        let host_task = {
            let host_info = host_info.clone();
            let host_caps = host_caps.clone();
            tokio::spawn(async move {
                run_host_handshake(
                    &*host_listener,
                    session_id,
                    invite_secret,
                    &host_info,
                    &host_caps,
                )
                .await
            })
        };

        let joiner_task = {
            let joiner_info = joiner_info.clone();
            let joiner_caps = joiner_caps.clone();
            let invitation = invitation.clone();
            tokio::spawn(async move {
                run_joiner_handshake(
                    &joiner_transport,
                    &*joiner_listener,
                    &invitation,
                    &joiner_info,
                    &joiner_caps,
                )
                .await
            })
        };

        let (host_res, joiner_res) = tokio::join!(host_task, joiner_task);
        let joiner_handshake = joiner_res.unwrap().expect("joiner handshake success");
        let host_handshake = host_res.unwrap().expect("host handshake success");

        assert_eq!(host_handshake.peer_info.display_name, "Joiner Node");
        assert_eq!(joiner_handshake.peer_info.display_name, "Host Node");
        assert_eq!(host_handshake.transport_path, TransportPath::DirectUdp);
        assert_eq!(joiner_handshake.transport_path, TransportPath::DirectUdp);

        // Test text data stream on TEXT_PORT (101)
        let mut transfer_id = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut transfer_id);

        let host_data_listener = hub.listen(host_opts.clone()).await.unwrap();

        let mut client_stream = hub
            .dial(
                host_data_listener.local_address(),
                TEXT_PORT,
                ListenOptions {
                    derp_map_url: "".to_string(),
                    verbose: false,
                },
            )
            .await
            .unwrap();

        let mut incoming = host_data_listener.accept().await.unwrap();
        assert_eq!(incoming.port, TEXT_PORT);

        let cancel = Arc::new(AtomicBool::new(false));
        let text_to_send = "TailSend text payload: 12345 こんにちは 🚀";

        let send_task = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                send_text_stream(
                    &mut client_stream,
                    session_id,
                    transfer_id,
                    text_to_send,
                    cancel,
                )
                .await
            })
        };

        let recv_task = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                receive_text_stream(&mut incoming.stream, session_id, transfer_id, cancel).await
            })
        };

        let (send_res, recv_res) = tokio::join!(send_task, recv_task);
        send_res.unwrap().expect("send text");
        let received_text = recv_res.unwrap().expect("receive text");
        assert_eq!(received_text, text_to_send);
    }

    #[tokio::test]
    async fn test_mock_multi_file_transfer() {
        let hub = Arc::new(MockNetworkHub::new());
        let host_opts = ListenOptions {
            derp_map_url: "".to_string(),
            verbose: false,
        };

        let session_id = [20u8; 16];
        let transfer_id = [21u8; 16];

        let file1_data = vec![0x41u8; 1024]; // 1 KiB
        let file2_data = vec![0x42u8; 70000]; // 70 KiB (> 1 chunk)

        let mut source1: Box<dyn FileSource> = Box::new(TestFileSource {
            data: file1_data.clone(),
            name: "item1.txt".to_string(),
        });
        let mut source2: Box<dyn FileSource> = Box::new(TestFileSource {
            data: file2_data.clone(),
            name: "item2.bin".to_string(),
        });

        let sink1_data = Arc::new(Mutex::new(Vec::new()));
        let sink1_committed = Arc::new(Mutex::new(false));
        let mut sink1: Box<dyn IncomingFileSink> = Box::new(TestFileSink {
            data: sink1_data.clone(),
            committed: sink1_committed.clone(),
            name: "item1.txt".to_string(),
        });

        let sink2_data = Arc::new(Mutex::new(Vec::new()));
        let sink2_committed = Arc::new(Mutex::new(false));
        let mut sink2: Box<dyn IncomingFileSink> = Box::new(TestFileSink {
            data: sink2_data.clone(),
            committed: sink2_committed.clone(),
            name: "item2.bin".to_string(),
        });

        let host_listener = hub.listen(host_opts.clone()).await.unwrap();

        let hub_clone = hub.clone();
        let host_addr = host_listener.local_address().to_string();

        let cancel = Arc::new(AtomicBool::new(false));

        // Sender Task (Streams item 1 then item 2)
        let s_cancel = cancel.clone();
        let sender_task = tokio::spawn(async move {
            let mut stream1 = hub_clone
                .dial(&host_addr, FILE_PORT, host_opts.clone())
                .await
                .unwrap();
            send_file_item_stream(
                &mut stream1,
                session_id,
                transfer_id,
                1,
                &mut source1,
                s_cancel.clone(),
                None,
            )
            .await
            .unwrap();

            let mut stream2 = hub_clone
                .dial(&host_addr, FILE_PORT, host_opts.clone())
                .await
                .unwrap();
            send_file_item_stream(
                &mut stream2,
                session_id,
                transfer_id,
                2,
                &mut source2,
                s_cancel,
                None,
            )
            .await
            .unwrap();
        });

        // Receiver Task
        let r_cancel = cancel.clone();
        let receiver_task = tokio::spawn(async move {
            let mut incoming1 = host_listener.accept().await.unwrap();
            assert_eq!(incoming1.port, FILE_PORT);
            receive_file_item_stream(
                &mut incoming1.stream,
                session_id,
                transfer_id,
                1,
                1024,
                &mut sink1,
                r_cancel.clone(),
                None,
            )
            .await
            .unwrap();

            let mut incoming2 = host_listener.accept().await.unwrap();
            assert_eq!(incoming2.port, FILE_PORT);
            receive_file_item_stream(
                &mut incoming2.stream,
                session_id,
                transfer_id,
                2,
                70000,
                &mut sink2,
                r_cancel,
                None,
            )
            .await
            .unwrap();
        });

        let (s_res, r_res) = tokio::join!(sender_task, receiver_task);
        s_res.unwrap();
        r_res.unwrap();

        assert_eq!(*sink1_data.lock().unwrap(), file1_data);
        assert_eq!(*sink2_data.lock().unwrap(), file2_data);
    }

    #[tokio::test]
    async fn test_mock_tampered_handshake_failure() {
        let hub = Arc::new(MockNetworkHub::new());
        let host_opts = ListenOptions {
            derp_map_url: "".to_string(),
            verbose: false,
        };

        let host_listener = hub.listen(host_opts.clone()).await.unwrap();
        let joiner_listener = hub.listen(host_opts.clone()).await.unwrap();

        let session_id = [1u8; 16];
        let correct_secret = [2u8; 32];
        let wrong_secret = [3u8; 32]; // Tampered secret

        let invitation = InvitationV1::new(
            host_listener.local_address().to_string(),
            session_id,
            wrong_secret,
            1756800000,
            600,
        );

        let host_info =
            PeerInfo::new_native("Host".to_string(), PlatformKind::Windows, "1.0".to_string());
        let joiner_info = PeerInfo::new_native(
            "Joiner".to_string(),
            PlatformKind::Windows,
            "1.0".to_string(),
        );
        let host_caps = Capabilities::default();
        let joiner_caps = Capabilities::default();

        let joiner_transport: Arc<dyn TailcatTransport> = hub.clone();

        let host_task = tokio::spawn(async move {
            run_host_handshake(
                &*host_listener,
                session_id,
                correct_secret,
                &host_info,
                &host_caps,
            )
            .await
        });

        let joiner_task = tokio::spawn(async move {
            run_joiner_handshake(
                &joiner_transport,
                &*joiner_listener,
                &invitation,
                &joiner_info,
                &joiner_caps,
            )
            .await
        });

        let (host_res, joiner_res) = tokio::join!(host_task, joiner_task);
        let host_outcome = host_res.unwrap();
        assert!(
            host_outcome.is_err(),
            "Host must reject handshake with invalid proof"
        );
        let _ = joiner_res;
    }

    #[tokio::test]
    async fn test_control_offer_rejection() {
        let (host_stream, joiner_stream) = crate::mock_transport::MockStream::pair();
        let mut host_box: Box<dyn tailsend_transport_api::DuplexStream> = Box::new(host_stream);
        let mut joiner_box: Box<dyn tailsend_transport_api::DuplexStream> = Box::new(joiner_stream);

        let session_id = [9u8; 16];

        // Host sends TextOffer
        let offer = TextOffer {
            byte_length: 50,
            character_count: 10,
            preview: "Test preview".to_string(),
        };
        let offer_msg = ControlMessage::new(
            MessageType::TextOffer,
            &session_id,
            1,
            None,
            Some(MessageBody::TextOffer(offer)),
        );

        write_framed_control(&mut host_box, &offer_msg)
            .await
            .unwrap();

        // Joiner receives offer and responds with rejection
        let received_offer = read_framed_control(&mut joiner_box).await.unwrap();
        assert_eq!(received_offer.message_type, MessageType::TextOffer as u32);

        let decision = Decision {
            accepted: false,
            reason_code: Some(1), // Rejected
            detail: Some("User declined transfer".to_string()),
        };
        let decision_msg = ControlMessage::new(
            MessageType::TextDecision,
            &session_id,
            2,
            None,
            Some(MessageBody::Decision(decision)),
        );
        write_framed_control(&mut joiner_box, &decision_msg)
            .await
            .unwrap();

        // Host reads decision and confirms rejection
        let received_decision = read_framed_control(&mut host_box).await.unwrap();
        assert_eq!(
            received_decision.message_type,
            MessageType::TextDecision as u32
        );
        match received_decision.body {
            Some(MessageBody::Decision(d)) => {
                assert!(!d.accepted, "Decision should be rejected");
            }
            _ => panic!("Expected Decision message body"),
        }
    }
}
