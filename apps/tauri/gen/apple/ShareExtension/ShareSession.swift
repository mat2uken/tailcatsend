import Foundation

struct ShareSendItem: Encodable {
    let id: String
    let kind: String
    let name: String
    let size: UInt64
    let path: String
    let mime: String?
    let preview: String?
}

struct ShareSessionSnapshot: Decodable {
    let state: String
    let inviteUrl: String?
    let peerName: String?
    let currentName: String?
    let done: UInt64
    let total: UInt64
    let completedIds: [String]
    let error: String?
}

final class ShareSession {
    private var handle: UInt64 = 0

    init(items: [ShareSendItem], invitation: String = "") throws {
        let data = try JSONEncoder().encode(items)
        guard let json = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "PonletShare", code: 1)
        }
        handle = json.withCString { itemsPointer in
            invitation.withCString { ponlet_share_start(itemsPointer, $0) }
        }
        guard handle != 0 else {
            throw NSError(domain: "PonletShare", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "接続の準備を開始できませんでした。"
            ])
        }
    }

    func snapshot() throws -> ShareSessionSnapshot {
        guard let pointer = ponlet_share_snapshot(handle) else {
            throw NSError(domain: "PonletShare", code: 3)
        }
        defer { ponlet_share_string_free(pointer) }
        let data = Data(String(cString: pointer).utf8)
        return try JSONDecoder().decode(ShareSessionSnapshot.self, from: data)
    }

    func cancel() { ponlet_share_cancel(handle) }

    deinit { ponlet_share_release(handle) }
}
