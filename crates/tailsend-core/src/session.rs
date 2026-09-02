use std::sync::Arc;
use rand::RngCore;
use tailsend_protocol::auth::*;
use tailsend_protocol::control::*;
use tailsend_protocol::invitation::InvitationV1;
use tailsend_protocol::limits::*;
use tailsend_transport_api::{DuplexStream, IncomingStream, ListenOptions, Listener, TailcatTransport};

pub async fn read_framed_control(stream: &mut Box<dyn DuplexStream>) -> Result<ControlMessage, String> {
    let mut len_buf = [0u8; 4];
    let mut read_len = 0;
    while read_len < 4 {
        let n = stream.read(&mut len_buf[read_len..]).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Unexpected EOF while reading control frame length".to_string());
        }
        read_len += n;
    }
    let payload_len = u32::from_be_bytes(len_buf) as usize;
    if payload_len == 0 || payload_len > MAX_CONTROL_FRAME_SIZE {
        return Err(format!("Invalid control frame length: {}", payload_len));
    }

    let mut payload = vec![0u8; payload_len];
    let mut total_read = 0;
    while total_read < payload_len {
        let n = stream.read(&mut payload[total_read..]).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Unexpected EOF while reading control frame payload".to_string());
        }
        total_read += n;
    }

    ControlMessage::decode_payload(&payload).map_err(|e| e.to_string())
}

pub async fn write_framed_control(
    stream: &mut Box<dyn DuplexStream>,
    msg: &ControlMessage,
) -> Result<(), String> {
    let bytes = msg.encode_framed().map_err(|e| e.to_string())?;
    stream.write_all(&bytes).await.map_err(|e| e.to_string())
}

pub struct HandshakeResult {
    pub control_stream: Box<dyn DuplexStream>,
    pub peer_address: String,
    pub peer_info: PeerInfo,
    pub peer_capabilities: Capabilities,
}

pub async fn run_host_handshake(
    listener: &Box<dyn Listener>,
    session_id: [u8; 16],
    invite_secret: [u8; 32],
    host_info: &PeerInfo,
    host_caps: &Capabilities,
) -> Result<HandshakeResult, String> {
    let incoming: IncomingStream = listener.accept().await.map_err(|e| e.to_string())?;
    if incoming.port != CONTROL_PORT {
        return Err(format!("Expected connection on port {}, got {}", CONTROL_PORT, incoming.port));
    }

    let mut stream = incoming.stream;
    let client_hello_msg = read_framed_control(&mut stream).await?;

    if client_hello_msg.message_type != MessageType::ClientHello as u32 {
        return Err(format!("Expected ClientHello, got {}", client_hello_msg.message_type));
    }

    let body = match client_hello_msg.body {
        Some(MessageBody::Hello(b)) => b,
        _ => return Err("Invalid ClientHello message body".to_string()),
    };

    if body.nonce.len() != 32 {
        return Err("Invalid client nonce length".to_string());
    }
    let mut joiner_nonce = [0u8; 32];
    joiner_nonce.copy_from_slice(&body.nonce);

    verify_joiner_proof(
        &invite_secret,
        &session_id,
        &joiner_nonce,
        &body.tailcat_address,
        &body.peer_info,
        &body.capabilities,
        &body.proof,
    )
    .map_err(|e| format!("Joiner proof verification failed: {}", e))?;

    let mut host_nonce = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut host_nonce);

    let host_proof = compute_host_proof(
        &invite_secret,
        &session_id,
        &joiner_nonce,
        &host_nonce,
        listener.local_address(),
        &body.tailcat_address,
        host_info,
        host_caps,
    )
    .map_err(|e| format!("Compute host proof failed: {}", e))?;

    let server_hello = ServerHello {
        nonce: host_nonce.to_vec(),
        tailcat_address: listener.local_address().to_string(),
        peer_info: host_info.clone(),
        capabilities: host_caps.clone(),
        proof: host_proof.to_vec(),
    };

    let server_hello_msg = ControlMessage::new(
        MessageType::ServerHello,
        &session_id,
        1,
        None,
        Some(MessageBody::Hello(server_hello)),
    );
    write_framed_control(&mut stream, &server_hello_msg).await?;

    let ready_msg = read_framed_control(&mut stream).await?;
    if ready_msg.message_type != MessageType::SessionReady as u32 {
        return Err(format!("Expected SessionReady, got {}", ready_msg.message_type));
    }

    let ack_msg = ControlMessage::new(
        MessageType::SessionReadyAck,
        &session_id,
        2,
        None,
        Some(MessageBody::SessionReady(SessionReady { note: None })),
    );
    write_framed_control(&mut stream, &ack_msg).await?;

    Ok(HandshakeResult {
        control_stream: stream,
        peer_address: body.tailcat_address,
        peer_info: body.peer_info,
        peer_capabilities: body.capabilities,
    })
}

pub async fn run_joiner_handshake(
    transport: &Arc<dyn TailcatTransport>,
    joiner_listener: &Box<dyn Listener>,
    invitation: &InvitationV1,
    joiner_info: &PeerInfo,
    joiner_caps: &Capabilities,
) -> Result<HandshakeResult, String> {
    let mut session_id = [0u8; 16];
    session_id.copy_from_slice(&invitation.session_id);

    let dial_result = transport
        .dial(
            &invitation.host_address,
            CONTROL_PORT,
            ListenOptions {
                derp_map_url: "https://tailcat.dev/derpmap.json".to_string(),
                verbose: false,
            },
        )
        .await;

    let mut stream: Box<dyn DuplexStream> = dial_result.map_err(|e| e.to_string())?;

    let mut joiner_nonce = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut joiner_nonce);

    let joiner_proof = compute_joiner_proof(
        &invitation.invite_secret,
        &session_id,
        &joiner_nonce,
        joiner_listener.local_address(),
        joiner_info,
        joiner_caps,
    )
    .map_err(|e| format!("Compute joiner proof failed: {}", e))?;

    let client_hello = ClientHello {
        nonce: joiner_nonce.to_vec(),
        tailcat_address: joiner_listener.local_address().to_string(),
        peer_info: joiner_info.clone(),
        capabilities: joiner_caps.clone(),
        proof: joiner_proof.to_vec(),
    };

    let client_hello_msg = ControlMessage::new(
        MessageType::ClientHello,
        &session_id,
        1,
        None,
        Some(MessageBody::Hello(client_hello)),
    );
    write_framed_control(&mut stream, &client_hello_msg).await?;

    let server_hello_msg = read_framed_control(&mut stream).await?;
    if server_hello_msg.message_type != MessageType::ServerHello as u32 {
        return Err(format!("Expected ServerHello, got {}", server_hello_msg.message_type));
    }

    let body = match server_hello_msg.body {
        Some(MessageBody::Hello(b)) => b,
        _ => return Err("Invalid ServerHello message body".to_string()),
    };

    if body.nonce.len() != 32 {
        return Err("Invalid server nonce length".to_string());
    }
    let mut host_nonce = [0u8; 32];
    host_nonce.copy_from_slice(&body.nonce);

    verify_host_proof(
        &invitation.invite_secret,
        &session_id,
        &joiner_nonce,
        &host_nonce,
        &invitation.host_address,
        joiner_listener.local_address(),
        &body.peer_info,
        &body.capabilities,
        &body.proof,
    )
    .map_err(|e| format!("Host proof verification failed: {}", e))?;

    let ready_msg = ControlMessage::new(
        MessageType::SessionReady,
        &session_id,
        2,
        None,
        Some(MessageBody::SessionReady(SessionReady { note: None })),
    );
    write_framed_control(&mut stream, &ready_msg).await?;

    let ack_msg = read_framed_control(&mut stream).await?;
    if ack_msg.message_type != MessageType::SessionReadyAck as u32 {
        return Err(format!("Expected SessionReadyAck, got {}", ack_msg.message_type));
    }

    Ok(HandshakeResult {
        control_stream: stream,
        peer_address: invitation.host_address.clone(),
        peer_info: body.peer_info,
        peer_capabilities: body.capabilities,
    })
}
