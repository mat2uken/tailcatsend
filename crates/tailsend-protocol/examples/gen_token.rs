use std::time::{SystemTime, UNIX_EPOCH};
use tailsend_protocol::invitation::InvitationV1;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let addr = if args.len() > 1 {
        args[1].clone()
    } else {
        "tc-host-pc-windows".to_string()
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let inv = InvitationV1::new(addr, [1u8; 16], [2u8; 32], now, 3600);
    println!("{}", inv.to_base64url().unwrap());
}
