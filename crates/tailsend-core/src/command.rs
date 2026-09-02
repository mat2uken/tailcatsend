use tailsend_platform_api::FileSource;

pub enum AppCommand {
    CreateSession {
        base_origin: String,
        now_unix_secs: u64,
    },
    JoinSession {
        invite_url: String,
        now_unix_secs: u64,
    },
    SendText {
        text: String,
    },
    SendFiles {
        sources: Vec<Box<dyn FileSource>>,
    },
    AcceptTransfer {
        transfer_id: [u8; 16],
    },
    RejectTransfer {
        transfer_id: [u8; 16],
    },
    CancelTransfer {
        transfer_id: [u8; 16],
    },
    Disconnect,
}
