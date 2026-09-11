//! Asynchronous binary custom scheme used when a WebView has no injected port.

use tailsend_ipc::Frame;
use tauri::http::{Request, Response, StatusCode};
use tauri::{UriSchemeContext, UriSchemeResponder, Wry};

use crate::ipc;

pub(crate) fn handle(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if context.webview_label() != "main" {
        responder.respond(cors_response(
            StatusCode::FORBIDDEN,
            b"Ponlet IPC is unavailable for this WebView".to_vec(),
        ));
        return;
    }
    let method = request.method().as_str().to_owned();
    if method == "OPTIONS" {
        responder.respond(cors_response(StatusCode::NO_CONTENT, Vec::new()));
        return;
    }
    if method != "POST" {
        responder.respond(cors_response(
            StatusCode::METHOD_NOT_ALLOWED,
            b"only POST is supported".to_vec(),
        ));
        return;
    }
    let path = request.uri().path().to_owned();
    if path != "/rpc" {
        responder.respond(cors_response(
            StatusCode::NOT_FOUND,
            b"unknown Ponlet IPC path".to_vec(),
        ));
        return;
    }
    let body = request.into_body();
    let app = context.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let response = match Frame::decode(&body) {
            Ok(request) => ipc::dispatch(app, request)
                .await
                .encode()
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        match response {
            Ok(body) => responder.respond(cors_response(StatusCode::OK, body)),
            Err(message) => {
                responder.respond(cors_response(StatusCode::BAD_REQUEST, message.into_bytes()))
            }
        }
    });
}

fn cors_response(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Content-Type")
        .header("Cache-Control", "no-store")
        .header("Content-Type", "application/octet-stream")
        .body(body)
        .expect("binary IPC response headers are valid")
}
