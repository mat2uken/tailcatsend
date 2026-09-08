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
	_ "tailscale.com/feature/webrtc"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

var (
	clientsMu     sync.Mutex
	cachedClients = make(map[string]*tailcat.Client)
)

func main() {
	bridge := js.ValueOf(map[string]any{
		"bridgeVersion": "1.0.0-tailcat-7a50a1a",
		"listen":        js.FuncOf(tailcatListen),
		"dial":          js.FuncOf(tailcatDial),
	})

	js.Global().Set("tailSendTailcat", bridge)
	js.Global().Set("tailcatListen", js.FuncOf(tailcatListen))
	js.Global().Set("tailcatDial", js.FuncOf(tailcatDial))

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
				onConnection.Invoke(makeJSConn(c, port, nil))
			}
		}
		if err := srv.Start(); err != nil {
			srv.Close()
			return nil, fmt.Errorf("Server.Start: %w", err)
		}
		return map[string]any{
			"addr":           string(addr),
			"address":        string(addr),
			"privateKeyJSON": string(keyOut),
			"close": js.FuncOf(func(this js.Value, args []js.Value) any {
				srv.Close()
				return nil
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
				clientsMu.Unlock()
				cl.Close()
				return nil, err
			}
		}
		c, err := cl.DialTCPPort(ctx, port)
		if err != nil {
			clientsMu.Lock()
			delete(cachedClients, addr)
			clientsMu.Unlock()
			cl.Close()
			return nil, fmt.Errorf("DialTCPPort: %w", err)
		}
		return makeJSConn(c, port, nil), nil
	})
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
	}
}

func makeJSConn(c net.Conn, port uint16, onClose func()) js.Value {
	buf := make([]byte, 64<<10)
	return js.ValueOf(map[string]any{
		"port": int(port),
		"read": js.FuncOf(func(this js.Value, args []js.Value) any {
			return makePromise(func() (any, error) {
				n, err := c.Read(buf)
				if n > 0 {
					u8 := js.Global().Get("Uint8Array").New(n)
					js.CopyBytesToJS(u8, buf[:n])
					return u8, nil
				}
				if err == nil || errors.Is(err, io.EOF) {
					return js.Null(), nil
				}
				return nil, err
			})
		}),
		"write": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 1 {
				return rejectedPromise(errors.New("write requires a Uint8Array"))
			}
			b := make([]byte, args[0].Get("length").Int())
			js.CopyBytesToGo(b, args[0])
			return makePromise(func() (any, error) {
				if _, err := c.Write(b); err != nil {
					return nil, err
				}
				return js.Undefined(), nil
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
			c.Close()
			if onClose != nil {
				onClose()
			}
			return nil
		}),
	})
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
