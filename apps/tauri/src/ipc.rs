//! Binary dispatcher shared by the custom scheme and Android WebMessage port.
//! The JSON invoke commands call the same implementation functions below.

use futures::StreamExt;
use serde::de::DeserializeOwned;
use tailsend_core::{AppEvent, BackendEvent};
use tailsend_ipc::{Frame, MessageKind, Opcode};

use crate::{
    ponlet_cancel_transfer_impl, ponlet_create_invite_impl, ponlet_disconnect_impl,
    ponlet_join_impl, ponlet_open_received_impl, ponlet_pick_and_send_files_impl,
    ponlet_qr_code_impl, ponlet_save_text_impl, ponlet_send_files_impl, ponlet_send_text_impl,
    FileRequest, TauriRuntime, UiEvent, UiQrBitmap,
};
use tauri::{AppHandle, Manager};

const STATUS_OK: u32 = 0;
const STATUS_ERROR: u32 = 1;

fn json<T: DeserializeOwned>(frame: &Frame) -> Result<T, String> {
    serde_json::from_slice(&frame.payload).map_err(|error| format!("invalid IPC payload: {error}"))
}

fn json_bytes<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec(value).map_err(|error| format!("cannot encode IPC payload: {error}"))
}

fn ok<T: serde::Serialize>(request: &Frame, value: &T) -> Frame {
    Frame::response(
        request,
        STATUS_OK,
        serde_json::to_vec(value).unwrap_or_default(),
    )
}

fn empty_ok(request: &Frame) -> Frame {
    Frame::response(request, STATUS_OK, Vec::new())
}

fn error(request: &Frame, message: impl Into<String>) -> Frame {
    Frame::response(request, STATUS_ERROR, message.into().into_bytes())
}

pub(crate) async fn dispatch(app: AppHandle, request: Frame) -> Frame {
    let runtime = app.state::<TauriRuntime>();
    if !matches!(
        request.kind,
        MessageKind::Request
            | MessageKind::Subscribe
            | MessageKind::Unsubscribe
            | MessageKind::WaitEvent
    ) {
        return error(&request, "invalid IPC request kind");
    }

    if request.kind == MessageKind::Subscribe || request.opcode == Opcode::Subscribe {
        let payload = match json::<SubscriptionPayload>(&request) {
            Ok(payload) => payload,
            Err(message) => return error(&request, message),
        };
        return match runtime.ensure_subscription(&payload.subscription_id) {
            Ok(snapshot) => ok(&request, &snapshot),
            Err(message) => error(&request, message),
        };
    }
    if request.kind == MessageKind::WaitEvent || request.opcode == Opcode::WaitEvent {
        return wait_event(&runtime, request).await;
    }
    if request.kind == MessageKind::Unsubscribe || request.opcode == Opcode::Unsubscribe {
        let id = json::<SubscriptionPayload>(&request)
            .map(|value| value.subscription_id)
            .unwrap_or_default();
        if !id.is_empty() {
            runtime.remove_subscription(&id);
        }
        return empty_ok(&request);
    }

    match request.opcode {
        Opcode::Snapshot => ok(&request, &runtime.snapshot()),
        Opcode::CreateInvite => match ponlet_create_invite_impl(&runtime).await {
            Ok(()) => empty_ok(&request),
            Err(message) => error(&request, message),
        },
        Opcode::Join => match json::<String>(&request) {
            Ok(invite) => match ponlet_join_impl(&runtime, invite).await {
                Ok(()) => empty_ok(&request),
                Err(message) => error(&request, message),
            },
            Err(message) => error(&request, message),
        },
        Opcode::SendText => match json::<String>(&request) {
            Ok(text) => match ponlet_send_text_impl(&runtime, text).await {
                Ok(()) => empty_ok(&request),
                Err(message) => error(&request, message),
            },
            Err(message) => error(&request, message),
        },
        Opcode::SendFiles => match json::<Vec<FileRequest>>(&request) {
            Ok(files) => match ponlet_send_files_impl(app.clone(), &runtime, files).await {
                Ok(()) => empty_ok(&request),
                Err(message) => error(&request, message),
            },
            Err(message) => error(&request, message),
        },
        Opcode::PickAndSendFiles => {
            match ponlet_pick_and_send_files_impl(app.clone(), &runtime).await {
                Ok(()) => empty_ok(&request),
                Err(message) => error(&request, message),
            }
        }
        Opcode::SaveText => match json::<String>(&request) {
            Ok(text) => match ponlet_save_text_impl(app.clone(), text).await {
                Ok(()) => empty_ok(&request),
                Err(message) => error(&request, message),
            },
            Err(message) => error(&request, message),
        },
        Opcode::QrCode => match json::<String>(&request) {
            Ok(url) => match ponlet_qr_code_impl(url) {
                Ok(bitmap) => qr_response(&request, bitmap),
                Err(message) => error(&request, message),
            },
            Err(message) => error(&request, message),
        },
        Opcode::CancelTransfer => match json::<String>(&request) {
            Ok(id) => match ponlet_cancel_transfer_impl(&runtime, id).await {
                Ok(()) => empty_ok(&request),
                Err(message) => error(&request, message),
            },
            Err(message) => error(&request, message),
        },
        Opcode::Disconnect => match ponlet_disconnect_impl(&runtime).await {
            Ok(()) => empty_ok(&request),
            Err(message) => error(&request, message),
        },
        Opcode::OpenReceived => match json::<OpenReceivedPayload>(&request) {
            Ok(value) => {
                let received = runtime
                    .received()
                    .lock()
                    .expect("received item mutex poisoned");
                match ponlet_open_received_impl(&app, &received, &value.local_path_or_handle) {
                    Ok(()) => empty_ok(&request),
                    Err(message) => error(&request, message),
                }
            }
            Err(message) => error(&request, message),
        },
        Opcode::Subscribe | Opcode::Unsubscribe | Opcode::WaitEvent => {
            error(&request, "invalid IPC operation")
        }
    }
}

fn qr_response(request: &Frame, bitmap: UiQrBitmap) -> Frame {
    let mut payload = Vec::with_capacity(8 + bitmap.rgba_pixels.len());
    payload.extend_from_slice(&bitmap.width.to_le_bytes());
    payload.extend_from_slice(&bitmap.height.to_le_bytes());
    payload.extend_from_slice(&bitmap.rgba_pixels);
    Frame::response(request, STATUS_OK, payload)
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionPayload {
    subscription_id: String,
    #[serde(default)]
    last_sequence: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenReceivedPayload {
    local_path_or_handle: String,
}

async fn wait_event(runtime: &TauriRuntime, request: Frame) -> Frame {
    let payload = match json::<SubscriptionPayload>(&request) {
        Ok(payload) => payload,
        Err(message) => return error(&request, message),
    };
    let id = payload.subscription_id;
    if id.is_empty() {
        return error(&request, "IPC subscription id is required");
    }
    if runtime.is_subscription_closed(&id) {
        return empty_ok(&request);
    }

    let had_subscription = runtime.has_subscription(&id);
    if had_subscription {
        // A bounded receiver can be dropped when the producer is faster than
        // the UI. Check the retained history before waiting so the client can
        // resubscribe from a fresh snapshot instead of waiting on a dead
        // channel.
        if let Err(gap) = runtime.backend.events_since(payload.last_sequence) {
            let snapshot = match runtime.replace_subscription(&id) {
                Ok(snapshot) => snapshot,
                Err(message) => return error(&request, message),
            };
            return snapshot_frame(
                &request,
                runtime,
                snapshot.sequence.max(gap.snapshot.sequence),
            );
        }
    }
    let initial_snapshot = if had_subscription {
        None
    } else {
        match runtime.ensure_subscription(&id) {
            Ok(snapshot) => Some(snapshot),
            Err(message) => return error(&request, message),
        }
    };
    let Some(subscription) = runtime.take_subscription(&id) else {
        return empty_ok(&request);
    };
    let crate::Subscription {
        mut receiver,
        mut cancelled,
    } = subscription;

    if let Some(snapshot) = initial_snapshot {
        match runtime.backend.events_since(payload.last_sequence) {
            Ok(events) if !events.is_empty() => {
                runtime.store_subscription(
                    id,
                    crate::Subscription {
                        receiver,
                        cancelled,
                    },
                );
                return event_batch_frame(&request, runtime, events.into_iter().take(32).collect());
            }
            Err(gap) => {
                runtime.store_subscription(
                    id,
                    crate::Subscription {
                        receiver,
                        cancelled,
                    },
                );
                return snapshot_frame(&request, runtime, gap.snapshot.sequence);
            }
            Ok(_) if snapshot.sequence > payload.last_sequence => {
                runtime.store_subscription(
                    id,
                    crate::Subscription {
                        receiver,
                        cancelled,
                    },
                );
                return snapshot_frame(&request, runtime, snapshot.sequence);
            }
            Ok(_) => {}
        }
    }

    let next = tokio::select! {
        event = receiver.next() => event,
        _ = &mut cancelled => return empty_ok(&request),
    };
    match next {
        Some(event) => {
            let mut events = vec![event];
            while events.len() < 32 {
                match receiver.try_recv() {
                    Ok(event) => events.push(event),
                    Err(_) => break,
                }
            }
            runtime.store_subscription(
                id,
                crate::Subscription {
                    receiver,
                    cancelled,
                },
            );
            if events.len() == 1 {
                event_frame(&request, runtime, events.remove(0))
            } else {
                event_batch_frame(&request, runtime, events)
            }
        }
        None => {
            let snapshot = match runtime.replace_subscription(&id) {
                Ok(snapshot) => snapshot,
                Err(message) => return error(&request, message),
            };
            snapshot_frame(&request, runtime, snapshot.sequence)
        }
    }
}

pub(crate) fn subscribe_json(
    runtime: &TauriRuntime,
    subscription_id: String,
) -> Result<crate::UiSnapshot, String> {
    runtime.ensure_subscription(&subscription_id)
}

pub(crate) async fn wait_event_json(
    runtime: &TauriRuntime,
    subscription_id: String,
    last_sequence: u64,
) -> Result<Option<serde_json::Value>, String> {
    let payload = serde_json::to_vec(&SubscriptionPayload {
        subscription_id,
        last_sequence,
    })
    .map_err(|error| format!("cannot encode IPC payload: {error}"))?;
    let request = Frame {
        kind: MessageKind::WaitEvent,
        opcode: Opcode::WaitEvent,
        request_id: 1,
        sequence: last_sequence,
        status: STATUS_OK,
        payload,
    };
    let response = wait_event(runtime, request).await;
    if response.status != STATUS_OK {
        return Err(String::from_utf8_lossy(&response.payload).into_owned());
    }
    if response.kind != MessageKind::Event || response.payload.is_empty() {
        return Ok(None);
    }
    serde_json::from_slice(&response.payload)
        .map(Some)
        .map_err(|error| format!("cannot decode event payload: {error}"))
}

pub(crate) fn unsubscribe_json(runtime: &TauriRuntime, subscription_id: &str) {
    if !subscription_id.is_empty() {
        runtime.remove_subscription(subscription_id);
    }
}

fn snapshot_frame(request: &Frame, runtime: &TauriRuntime, _sequence: u64) -> Frame {
    let snapshot = runtime.snapshot();
    let sequence = snapshot.sequence;
    let event = UiEvent::Snapshot { sequence, snapshot };
    event_response(request, sequence, event)
}

fn event_frame(request: &Frame, runtime: &TauriRuntime, event: BackendEvent) -> Frame {
    let mapped = map_event(runtime, event.sequence, event.event);
    event_response(request, ui_event_sequence(&mapped), mapped)
}

fn event_batch_frame(request: &Frame, runtime: &TauriRuntime, events: Vec<BackendEvent>) -> Frame {
    let payload = events
        .into_iter()
        .map(|event| map_event(runtime, event.sequence, event.event))
        .collect::<Vec<_>>();
    let sequence = payload.iter().map(ui_event_sequence).max().unwrap_or(0);
    Frame {
        kind: MessageKind::Event,
        opcode: Opcode::WaitEvent,
        request_id: request.request_id,
        sequence,
        status: STATUS_OK,
        payload: json_bytes(&payload).unwrap_or_default(),
    }
}

fn map_event(runtime: &TauriRuntime, sequence: u64, event: AppEvent) -> UiEvent {
    match event {
        AppEvent::StateChanged(_) | AppEvent::TransportChanged(_) => {
            let snapshot = runtime.snapshot();
            UiEvent::Snapshot {
                sequence: snapshot.sequence,
                snapshot,
            }
        }
        AppEvent::TransferProgress {
            transfer_id,
            bytes_done,
            bytes_total,
        } => UiEvent::Progress {
            sequence,
            id: crate::id_string(transfer_id),
            done: bytes_done,
            total: bytes_total,
        },
        AppEvent::TextReceived { text } => UiEvent::Text {
            sequence,
            text,
            incoming: true,
        },
        AppEvent::FilesReceived { items } => UiEvent::Files {
            sequence,
            items: items
                .into_iter()
                .map(|item| crate::UiReceivedItem {
                    name: item.name,
                    size: item.size,
                    local_path_or_handle: item.local_path_or_handle,
                })
                .collect(),
        },
        AppEvent::TransferCompleted { transfer_id } => UiEvent::Terminal {
            sequence,
            id: crate::id_string(transfer_id),
            status: "completed",
            message: None,
        },
        AppEvent::TransferCancelled {
            transfer_id,
            reason,
        } => UiEvent::Terminal {
            sequence,
            id: crate::id_string(transfer_id),
            status: if reason == "Transfer cancelled by user" {
                "cancelled"
            } else {
                "failed"
            },
            message: Some(reason),
        },
        AppEvent::ErrorOccurred { code, message } => {
            let mut snapshot = runtime.snapshot();
            if snapshot.sequence == sequence {
                snapshot.error = Some(format!("{code}: {message}"));
            }
            UiEvent::Snapshot {
                sequence: snapshot.sequence,
                snapshot,
            }
        }
    }
}

fn ui_event_sequence(event: &UiEvent) -> u64 {
    match event {
        UiEvent::Snapshot { sequence, .. }
        | UiEvent::Progress { sequence, .. }
        | UiEvent::Text { sequence, .. }
        | UiEvent::Files { sequence, .. }
        | UiEvent::Terminal { sequence, .. } => *sequence,
    }
}

fn event_response(request: &Frame, sequence: u64, event: UiEvent) -> Frame {
    Frame {
        kind: MessageKind::Event,
        opcode: Opcode::WaitEvent,
        request_id: request.request_id,
        sequence,
        status: STATUS_OK,
        payload: json_bytes(&event).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex};

    fn test_runtime() -> TauriRuntime {
        TauriRuntime {
            backend: tailsend_core::BackendService::default(),
            transport: Arc::new(tailsend_native_transport::NativeTailcatTransport),
            state: Mutex::new(crate::runtime::RuntimeState {
                session: None,
                active_transfer: None,
            }),
            downloads_dir: Mutex::new(std::env::temp_dir()),
            received: Arc::new(Mutex::new(Vec::new())),
            subscriptions: Mutex::new(HashMap::new()),
            subscription_cancellers: Mutex::new(HashMap::new()),
            closed_subscriptions: Mutex::new(HashSet::new()),
        }
    }

    #[test]
    fn delayed_state_notifications_keep_current_sequence_and_recover_text() {
        let runtime = test_runtime();
        let earlier = runtime
            .backend
            .set_state(tailsend_core::SessionState::Booting);
        let text = runtime.backend.emit(AppEvent::TextReceived {
            text: "received while paused".into(),
        });
        let request = Frame::request(Opcode::WaitEvent, 5, Vec::new());
        let single = event_frame(&request, &runtime, earlier.clone());
        assert_eq!(single.sequence, text.sequence);
        let payload: serde_json::Value = serde_json::from_slice(&single.payload).unwrap();
        assert_eq!(payload["sequence"], text.sequence);
        assert_eq!(payload["snapshot"]["sequence"], text.sequence);
        assert_eq!(
            payload["snapshot"]["receivedMessages"][0]["text"],
            "received while paused"
        );
        let batch = event_batch_frame(&request, &runtime, vec![earlier, text.clone()]);
        assert_eq!(batch.sequence, text.sequence);
    }

    #[test]
    fn delayed_error_does_not_taint_a_replacement_session_snapshot() {
        let runtime = test_runtime();
        let earlier = runtime.backend.emit(AppEvent::ErrorOccurred {
            code: 1,
            message: "old connection".into(),
        });
        let current = runtime.backend.begin_session();
        current.set_state(tailsend_core::SessionState::Booting);
        let UiEvent::Snapshot { snapshot, .. } =
            map_event(&runtime, earlier.sequence, earlier.event)
        else {
            panic!("expected snapshot")
        };
        assert_eq!(snapshot.state, "booting");
        assert!(snapshot.error.is_none());
    }

    #[test]
    fn qr_payload_has_fixed_dimensions_before_pixels() {
        let request = Frame::request(Opcode::QrCode, 4, Vec::new());
        let bitmap = UiQrBitmap {
            width: 2,
            height: 1,
            rgba_pixels: vec![1, 2, 3, 4, 5, 6, 7, 8],
        };
        let response = qr_response(&request, bitmap);
        assert_eq!(&response.payload[..8], &[2, 0, 0, 0, 1, 0, 0, 0]);
        assert_eq!(response.payload.len(), 16);
    }
}
