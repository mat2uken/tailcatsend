// TailSend Web Tailcat WASM Bridge
package main

import (
	"context"
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
)

const (
	transportUnknown = transportpath.Unknown

	streamOK      = 0
	streamEOF     = 1
	streamTimeout = 2
	streamNetwork = 20
)

func main() {
	bridge := js.ValueOf(map[string]any{
		"bridgeVersion": "1.0.0-tailcat-c03c524",
		"listen":        js.FuncOf(tailcatListen),
		"dial":          js.FuncOf(tailcatDial),
	})

	js.Global().Set("tailSendTailcat", bridge)
	select {}
}

// listenerCallbacks ensures shutdown waits for an in-flight callback and
// rejects later connections before the JavaScript owner releases its callback.
type listenerCallbacks struct {
	mu     sync.Mutex
	closed bool
}

func (callbacks *listenerCallbacks) deliver(c net.Conn, accept func(net.Conn)) {
	callbacks.mu.Lock()
	if callbacks.closed {
		callbacks.mu.Unlock()
		c.Close()
		return
	}
	defer callbacks.mu.Unlock()
	accept(c)
}

// stop must run on the asynchronous close goroutine, never in a synchronous
// JS callback: accept may itself call close and receive its pending Promise.
func (callbacks *listenerCallbacks) stop() {
	callbacks.mu.Lock()
	callbacks.closed = true
	callbacks.mu.Unlock()
}

func tailcatListen(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tailcatListen requires an options object"))
	}
	opts := args[0]
	onConnection := opts.Get("onConnection")
	derpMapURL := optString(opts, "derpMapURL")
	logf := optLogf(opts)

	return makePromise(func() (any, error) {
		if onConnection.Type() != js.TypeFunction {
			return nil, errors.New("onConnection callback function is required")
		}
		if derpMapURL == "" {
			derpMapURL = "https://tailcat.dev/derpmap.json"
		}
		pk := tailcat.NewPrivateKey()
		pk.Public.RegionID = -1 // auto-select

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
		pk.Public.RegionID = reg.RegionID
		addr := pk.Public.Addr()

		srv := &tailcat.Server{
			Key:          pk.Private,
			PresharedKey: pk.Public.PresharedKey,
			Logf:         logf,
			Region:       reg,
		}
		var callbacks listenerCallbacks
		srv.OnTCP = func(port uint16) (handler func(net.Conn)) {
			return func(c net.Conn) {
				callbacks.deliver(c, func(c net.Conn) {
					onConnection.Invoke(makeJSConn(c, port, transportpath.FromServer(srv, c.RemoteAddr()), func() uint8 {
						return transportpath.FromServer(srv, c.RemoteAddr())
					}))
				})
			}
		}
		if err := srv.Start(); err != nil {
			callbacks.stop()
			srv.Close()
			return nil, fmt.Errorf("Server.Start: %w", err)
		}
		return makeJSListener(string(addr), func() error {
			// Stop waits for an in-flight accept before its JS owner can release
			// onConnection. This runs asynchronously, including reentrant close.
			callbacks.stop()
			return srv.Close()
		}), nil
	})
}

func tailcatDial(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("tailcatDial requires an options object"))
	}
	opts := args[0]
	addr := optString(opts, "addr")
	derpMapURL := optString(opts, "derpMapURL")
	if derpMapURL == "" {
		derpMapURL = "https://tailcat.dev/derpmap.json"
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

		clientsMu.Lock()
		cl, ok := cachedClients[addr]
		if !ok {
			cl = &tailcat.Client{
				Server:     tailcat.Addr(addr),
				Key:        key.NewNode(),
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
		path := rememberClientTransport(addr, transportpath.FromClient(cl))
		return makeJSConn(c, port, path, func() uint8 {
			return rememberClientTransport(addr, transportUnknown)
		}), nil
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

// Only this dispatcher is registered with syscall/js for handle methods.
// Per-object methods are JS-bound functions, so cached methods do not keep
// closed connections, buffers, or listener callbacks in Go's function registry.
var jsHandles = struct {
	sync.Mutex
	next   int
	live   map[int]*jsHandleState
	once   sync.Once
	call   js.Func
	closed js.Value // WeakMap<object, Promise>; keys do not retain JS objects.
}{live: make(map[int]*jsHandleState)}

type jsHandleState struct {
	conn             net.Conn
	close            func() error
	currentTransport func() uint8
	readBuf          []byte
	writeBuf         []byte
}

func bindJSHandle(object js.Value, state *jsHandleState, methods ...string) js.Value {
	jsHandles.once.Do(func() {
		jsHandles.call = js.FuncOf(dispatchJSHandle)
		jsHandles.closed = js.Global().Get("WeakMap").New()
	})
	jsHandles.Lock()
	jsHandles.next++
	handle := jsHandles.next
	jsHandles.live[handle] = state
	jsHandles.Unlock()
	for _, method := range methods {
		if method == "closeWrite" {
			_, supported := state.conn.(interface{ CloseWrite() error })
			object.Set(method, jsHandles.call.Value.Call("bind", object, handle, method, supported))
			continue
		}
		object.Set(method, jsHandles.call.Value.Call("bind", object, handle, method))
	}
	return object
}

func makeJSListener(addr string, close func() error) js.Value {
	return bindJSHandle(js.ValueOf(map[string]any{"addr": addr}), &jsHandleState{close: close}, "close")
}

func makeJSConn(c net.Conn, port uint16, transport uint8, currentTransport func() uint8) js.Value {
	return bindJSHandle(js.ValueOf(map[string]any{
		"port": int(port), "transportType": int(transport),
	}), &jsHandleState{
		conn: c, close: c.Close, currentTransport: currentTransport,
		readBuf: make([]byte, 64<<10), writeBuf: make([]byte, 64<<10),
	}, "getTransport", "readInto", "write", "closeWrite", "close")
}

func dispatchJSHandle(object js.Value, args []js.Value) any {
	handle, method := args[0].Int(), args[1].String()
	args = args[2:]
	if method == "close" {
		if promise := jsHandles.closed.Call("get", object); !promise.IsUndefined() {
			return promise
		}
	}
	jsHandles.Lock()
	state := jsHandles.live[handle]
	if method == "close" {
		delete(jsHandles.live, handle)
	}
	jsHandles.Unlock()

	switch method {
	case "close":
		if state != nil && state.currentTransport != nil {
			if path := state.currentTransport(); path != transportUnknown {
				object.Set("transportType", int(path))
			}
		}
		// Publish the Promise before shutdown can invoke another JS callback.
		// A reentrant/cached close observes this same pending result.
		ready := make(chan struct{})
		promise := makePromise(func() (any, error) {
			<-ready
			if state == nil {
				return js.Undefined(), nil
			}
			return js.Undefined(), state.close()
		})
		jsHandles.closed.Call("set", object, promise)
		close(ready)
		return promise
	case "getTransport":
		if state == nil {
			return object.Get("transportType")
		}
		path := state.currentTransport()
		if path != transportUnknown {
			object.Set("transportType", int(path))
		}
		return int(path)
	case "readInto":
		if len(args) < 1 || args[0].Type() != js.TypeObject {
			return rejectedPromise(errors.New("readInto requires a Uint8Array"))
		}
		return makePromise(func() (any, error) { return state.readInto(args) })
	case "write":
		if len(args) != 1 {
			return rejectedPromise(errors.New("write requires a Uint8Array"))
		}
		return makePromise(func() (any, error) { return state.write(args[0]) })
	case "closeWrite":
		return makePromise(func() (any, error) {
			if !args[0].Bool() {
				return nil, errors.New("connection does not support half-close")
			}
			if state == nil {
				return nil, net.ErrClosed
			}
			return js.Undefined(), state.conn.(interface{ CloseWrite() error }).CloseWrite()
		})
	default:
		return rejectedPromise(errors.New("unknown connection method"))
	}
}

func (state *jsHandleState) readInto(args []js.Value) (any, error) {
	byteLength := args[0].Get("byteLength")
	if byteLength.Type() != js.TypeNumber {
		return nil, errors.New("readInto requires a Uint8Array")
	}
	targetLength := byteLength.Int()
	if targetLength <= 0 {
		return map[string]any{"count": 0, "code": streamOK}, nil
	}
	if state == nil {
		return map[string]any{"count": 0, "code": streamNetwork, "error": net.ErrClosed.Error()}, nil
	}
	limit := min(len(state.readBuf), targetLength)
	if len(args) > 1 && args[1].Type() == js.TypeNumber {
		if requested := args[1].Int(); requested > 0 && requested < limit {
			limit = requested
		}
	}
	n, err := state.conn.Read(state.readBuf[:limit])
	result := map[string]any{"count": n, "code": streamStatus(err)}
	if err != nil && !errors.Is(err, io.EOF) {
		result["error"] = err.Error()
	}
	if n > 0 {
		js.CopyBytesToJS(args[0], state.readBuf[:n])
	}
	return result, nil
}

func (state *jsHandleState) write(bytes js.Value) (any, error) {
	length := bytes.Get("length").Int()
	if state == nil {
		return map[string]any{"written": 0, "code": streamNetwork, "error": net.ErrClosed.Error()}, nil
	}
	b := state.writeBuf
	if length > len(b) {
		b = make([]byte, length)
	} else {
		b = b[:length]
	}
	js.CopyBytesToGo(b, bytes)
	written, err := state.conn.Write(b)
	if err != nil {
		return map[string]any{"code": streamStatus(err), "error": err.Error(), "written": written}, nil
	}
	// Keep partial-I/O counts; the Rust loop retries any unwritten remainder.
	return written, nil
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
	// The Promise constructor calls its executor synchronously. Only the
	// resolve/reject values are needed by the goroutine after it returns.
	defer handler.Release()
	return js.Global().Get("Promise").New(handler)
}

func rejectedPromise(err error) js.Value {
	return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New(err.Error()))
}
