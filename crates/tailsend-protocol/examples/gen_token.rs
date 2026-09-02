use std::time::{SystemTime, UNIX_EPOCH};
use tailsend_protocol::invitation::InvitationV1;

fn main() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let inv = InvitationV1::new("tc-host-pc-windows".to_string(), [1u8; 16], [2u8; 32], now, 3600);
    println!("{}", inv.to_base64url().unwrap());
}
