// Cloudflare Durable Object Global WebSocket Relay for TailSend
export class RelayRoom {
    constructor(state, env) {
        this.state = state;
        this.host = null;
        this.clients = new Set();
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected WebSocket", { status: 426 });
        }

        const role = url.searchParams.get("role") || "peer";
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        server.accept();

        if (role === "host") {
            if (this.host) {
                try { this.host.close(); } catch (_) {}
            }
            this.host = server;
        } else {
            this.clients.add(server);
        }

        server.addEventListener("message", (event) => {
            if (role === "host") {
                for (const c of this.clients) {
                    if (c.readyState === 1) {
                        c.send(event.data);
                    }
                }
            } else {
                if (this.host && this.host.readyState === 1) {
                    this.host.send(event.data);
                }
            }
        });

        server.addEventListener("close", () => {
            if (role === "host") {
                this.host = null;
            } else {
                this.clients.delete(server);
            }
        });

        return new Response(null, { status: 101, webSocket: client });
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === "/relay") {
            const sessionId = url.searchParams.get("session") || "default-session";
            if (!env.RELAY_ROOM) {
                return new Response("Durable Object RELAY_ROOM binding missing", { status: 500 });
            }
            const id = env.RELAY_ROOM.idFromName(sessionId);
            const obj = env.RELAY_ROOM.get(id);
            return obj.fetch(request);
        }

        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response("TailSend Edge Relay Active", { status: 200 });
    }
};
