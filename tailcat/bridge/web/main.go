// TailSend Web Tailcat WASM Bridge
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"syscall/js"
	"time"

	"github.com/tailscale/tailcat"
	"github.com/tailsend/tailcat-bridge/bridge/transportpath"
	_ "tailscale.com/feature/webrtc"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

var (
	clientsMu        sync.Mutex
	cachedClients    = make(map[string]*tailcat.Client)
	clientTransports = make(map[string]uint8)
	currentServer    *tailcat.Server
)

const (
	transportDirectUDP = transportpath.DirectUDP
	transportWebRTC    = transportpath.WebRTC
	transportDERP      = transportpath.DERP
	transportUnknown   = transportpath.Unknown

	streamOK      = 0
	streamEOF     = 1
	streamTimeout = 2
	streamNetwork = 20
)

func main() {
	bridge := js.ValueOf(map[string]any{
		"bridgeVersion": "1.0.0-tailcat-7a50a1a",
		"listen":        js.FuncOf(tailcatListen),
		"dial":          js.FuncOf(tailcatDial),
		"getTransport":  js.FuncOf(tailcatGetTransport),
	})

	js.Global().Set("tailSendTailcat", bridge)
	js.Global().Set("tailcatListen", js.FuncOf(tailcatListen))
	js.Global().Set("tailcatDial", js.FuncOf(tailcatDial))
	js.Global().Set("tailcatGetTransport", js.FuncOf(tailcatGetTransport))

	if f := js.Global().Get("onTailcatReady"); f.Type() == js.TypeFunction {
		f.Invoke()
	}
	select {}
}

func tailcatListen(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tailcatListen requires an options object"))
	}
	opts := args[0]
	onConnection := opts.Get("onConnection")
	derpMapURL := optString(opts, "derpMapURL")
	if derpMapURL == "" {
		derpMapURL = optString(opts, "derpMapUrl")
	}
	keyJSON := optString(opts, "privateKey")
	if keyJSON == "" {
		keyJSON = optString(opts, "privateKeyJson")
	}
	logf := optLogf(opts)

	return makePromise(func() (any, error) {
		if onConnection.Type() != js.TypeFunction {
			return nil, errors.New("onConnection callback function is required")
		}
		if derpMapURL == "" {
			derpMapURL = "https://tailcat.dev/derpmap.json"
		}
		pk := &tailcat.PrivateKey{}
		if keyJSON != "" {
			if err := json.Unmarshal([]byte(keyJSON), pk); err != nil {
				return nil, fmt.Errorf("parsing privateKey: %w", err)
			}
		} else {
			pk = tailcat.NewPrivateKey()
			pk.Public.RegionID = -1 // auto-select
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ci := pk.Public
		if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(derpMapURL)); err != nil {
			return nil, fmt.Errorf("Expand: %w", err)
		}
		if pk.Public.PresharedKey.IsZero() {
			pk.Public.PresharedKey = tailcat.NewPresharedKey()
		}
		reg := ci.Region[0]
		if keyJSON == "" {
			pk.Public.RegionID = reg.RegionID
		}
		addr := pk.Public.Addr()
		keyOut, err := json.Marshal(pk)
		if err != nil {
			return nil, err
		}

		srv := &tailcat.Server{
			Key:          pk.Private,
			PresharedKey: pk.Public.PresharedKey,
			Logf:         logf,
			Region:       reg,
		}
		srv.OnTCP = func(port uint16) (handler func(net.Conn)) {
			return func(c net.Conn) {
				onConnection.Invoke(makeJSConn(c, port, transportFromServer(srv), func() uint8 {
					return transportFromServer(srv)
				}, nil))
			}
		}
		if err := srv.Start(); err != nil {
			srv.Close()
			return nil, fmt.Errorf("Server.Start: %w", err)
		}
		clientsMu.Lock()
		currentServer = srv
		clientsMu.Unlock()

		var closeOnce sync.Once
		var closeErr error
		return map[string]any{
			"addr":           string(addr),
			"address":        string(addr),
			"privateKeyJSON": string(keyOut),
			"close": js.FuncOf(func(this js.Value, args []js.Value) any {
				// Close can wait for network callbacks. Never block the JavaScript
				// event loop while those callbacks are needed to finish shutdown.
				return makePromise(func() (any, error) {
					closeOnce.Do(func() {
						clientsMu.Lock()
						if currentServer == srv {
							currentServer = nil
						}
						clientsMu.Unlock()
						closeErr = srv.Close()
					})
					return js.Undefined(), closeErr
				})
			}),
		}, nil
	})
}

func tailcatDial(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tailcatDial requires an options object"))
	}
	opts := args[0]
	addr := optString(opts, "addr")
	if addr == "" {
		addr = optString(opts, "address")
	}
	derpMapURL := optString(opts, "derpMapURL")
	if derpMapURL == "" {
		derpMapURL = optString(opts, "derpMapUrl")
	}
	if derpMapURL == "" {
		derpMapURL = "https://tailcat.dev/derpmap.json"
	}
	keyJSON := optString(opts, "privateKey")
	if keyJSON == "" {
		keyJSON = optString(opts, "privateKeyJson")
	}
	logf := optLogf(opts)
	port := uint16(100)
	if p := opts.Get("port"); p.Type() == js.TypeNumber {
		port = uint16(p.Int())
	}

	return makePromise(func() (any, error) {
		if addr == "" {
			return nil, errors.New("addr is required")
		}
		priv := key.NewNode()
		if keyJSON != "" {
			var pk tailcat.PrivateKey
			if err := json.Unmarshal([]byte(keyJSON), &pk); err != nil {
				return nil, fmt.Errorf("parsing privateKey: %w", err)
			}
			priv = pk.Private
		}
		clientsMu.Lock()
		cl, ok := cachedClients[addr]
		if !ok {
			cl = &tailcat.Client{
				Server:     tailcat.Addr(addr),
				Key:        priv,
				Logf:       logf,
				DERPMapURL: derpMapURL,
			}
			cachedClients[addr] = cl
		}
		clientsMu.Unlock()

		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if !ok {
			if err := pingUntil(ctx, cl); err != nil {
				clientsMu.Lock()
				delete(cachedClients, addr)
				delete(clientTransports, addr)
				clientsMu.Unlock()
				cl.Close()
				return nil, err
			}
		}
		c, err := cl.DialTCPPort(ctx, port)
		if err != nil {
			clientsMu.Lock()
			delete(cachedClients, addr)
			delete(clientTransports, addr)
			clientsMu.Unlock()
			cl.Close()
			return nil, fmt.Errorf("DialTCPPort: %w", err)
		}
		path := rememberClientTransport(addr, transportFromClient(cl))
		return makeJSConn(c, port, path, func() uint8 {
			return rememberClientTransport(addr, transportUnknown)
		}, nil), nil
	})
}

func rememberClientTransport(addr string, path uint8) uint8 {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	if path != transportUnknown {
		clientTransports[addr] = path
	}
	if path == transportUnknown {
		if cached, ok := clientTransports[addr]; ok {
			return cached
		}
	}
	return path
}

func pingUntil(ctx context.Context, cl *tailcat.Client) error {
	for {
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := cl.Ping(pctx)
		cancel()
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return fmt.Errorf("ping: %w", err)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("ping: %w", ctx.Err())
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func makeJSConn(c net.Conn, port uint16, transport uint8, currentTransport func() uint8, onClose func()) js.Value {
	buf := make([]byte, 64<<10)
	writeBuf := make([]byte, 64<<10)
	var closeOnce sync.Once
	var closeErr error
	return js.ValueOf(map[string]any{
		"port":          int(port),
		"transportType": int(transport),
		"getTransport": js.FuncOf(func(this js.Value, args []js.Value) any {
			if currentTransport == nil {
				return int(transport)
			}
			return int(currentTransport())
		}),
		"readInto": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) < 1 || args[0].Type() != js.TypeObject {
				return rejectedPromise(errors.New("readInto requires a Uint8Array"))
			}
			return makePromise(func() (any, error) {
				limit := len(buf)
				byteLength := args[0].Get("byteLength")
				if byteLength.Type() != js.TypeNumber {
					return nil, errors.New("readInto requires a Uint8Array")
				}
				targetLength := byteLength.Int()
				if targetLength <= 0 {
					return map[string]any{"count": 0, "code": streamOK}, nil
				}
				if targetLength < limit {
					limit = targetLength
				}
				if len(args) > 1 && args[1].Type() == js.TypeNumber {
					requested := args[1].Int()
					if requested > 0 && requested < limit {
						limit = requested
					}
				}
				n, err := c.Read(buf[:limit])
				result := map[string]any{"count": n, "code": streamStatus(err)}
				if err != nil && !errors.Is(err, io.EOF) {
					result["error"] = err.Error()
				}
				if n > 0 {
					js.CopyBytesToJS(args[0], buf[:n])
				}
				return result, nil
			})
		}),
		"write": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 1 {
				return rejectedPromise(errors.New("write requires a Uint8Array"))
			}
			length := args[0].Get("length").Int()
			return makePromise(func() (any, error) {
				b := writeBuf
				if length > len(b) {
					b = make([]byte, length)
				} else {
					b = b[:length]
				}
				js.CopyBytesToGo(b, args[0])
				written, err := c.Write(b)
				if err != nil {
					return map[string]any{
						"code":    streamStatus(err),
						"error":   err.Error(),
						"written": written,
					}, nil
				}
				// A short write without an error is a valid partial-I/O result.
				// Returning the count lets the Rust loop retry the remainder.
				return written, nil
			})
		}),
		"closeWrite": js.FuncOf(func(this js.Value, args []js.Value) any {
			return makePromise(func() (any, error) {
				cw, ok := c.(interface{ CloseWrite() error })
				if !ok {
					return nil, errors.New("connection does not support half-close")
				}
				if err := cw.CloseWrite(); err != nil {
					return nil, err
				}
				return js.Undefined(), nil
			})
		}),
		"close": js.FuncOf(func(this js.Value, args []js.Value) any {
			return makePromise(func() (any, error) {
				closeOnce.Do(func() {
					closeErr = c.Close()
					if onClose != nil {
						onClose()
					}
				})
				return js.Undefined(), closeErr
			})
		}),
	})
}

func streamStatus(err error) int {
	if err == nil {
		return streamOK
	}
	if errors.Is(err, io.EOF) {
		return streamEOF
	}
	if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		return streamTimeout
	}
	return streamNetwork
}

func optString(v js.Value, name string) string {
	if p := v.Get(name); p.Type() == js.TypeString {
		return p.String()
	}
	return ""
}

func optLogf(v js.Value) logger.Logf {
	if v.Get("verbose").Truthy() {
		return log.Printf
	}
	return logger.Discard
}

func makePromise(f func() (any, error)) js.Value {
	handler := js.FuncOf(func(this js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			if res, err := f(); err == nil {
				resolve.Invoke(res)
			} else {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
			}
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

func rejectedPromise(err error) js.Value {
	return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New(err.Error()))
}

func transportFromEndpoint(endpoint string) uint8 {
	return transportpath.FromEndpoint(endpoint)
}

func transportFromPing(endpoint, peerRelay string, usedDERP bool) uint8 {
	return transportpath.FromPing(endpoint, peerRelay, usedDERP)
}

func transportFromClient(client *tailcat.Client) uint8 {
	if client == nil {
		return transportUnknown
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result, err := client.DiscoPing(ctx)
	if err != nil || result == nil {
		return transportUnknown
	}
	return transportFromPing(result.Endpoint, result.PeerRelay, result.DERPRegionID != 0)
}

func transportFromServer(server *tailcat.Server) uint8 {
	if server == nil {
		return transportUnknown
	}
	status := server.Status()
	if status == nil {
		return transportUnknown
	}
	for _, peer := range status.Peer {
		if peer == nil {
			continue
		}
		if path := transportFromEndpoint(peer.CurAddr); path != transportUnknown {
			return path
		}
		if peer.PeerRelay != "" || peer.Relay != "" {
			return transportDERP
		}
	}
	return transportUnknown
}

func tailcatGetTransport(this js.Value, args []js.Value) any {
	addr := ""
	if len(args) > 0 && args[0].Type() == js.TypeString {
		addr = args[0].String()
	}

	return makePromise(func() (any, error) {
		clientsMu.Lock()
		cl, hasClient := cachedClients[addr]
		srv := currentServer
		clientsMu.Unlock()

		if hasClient && cl != nil {
			return int(rememberClientTransport(addr, transportFromClient(cl))), nil
		}

		if srv != nil {
			return int(transportFromServer(srv)), nil
		}

		return int(transportUnknown), nil
	})
}
