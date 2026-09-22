//go:build js && wasm

package main

import (
	"errors"
	"io"
	"net"
	"runtime"
	"sync/atomic"
	"syscall/js"
	"testing"
	"time"
)

type trackedConn struct {
	net.Conn
	readStarted  chan struct{}
	writeStarted chan struct{}
	closes       *atomic.Int32
}

func (c *trackedConn) Read(b []byte) (int, error) {
	close(c.readStarted)
	return c.Conn.Read(b)
}

func (c *trackedConn) Write(b []byte) (int, error) {
	close(c.writeStarted)
	return c.Conn.Write(b)
}

func (c *trackedConn) Close() error {
	c.closes.Add(1)
	return c.Conn.Close()
}

func trackedJSConn(finalized chan struct{}, closes *atomic.Int32, readStarted, writeStarted chan struct{}) (js.Value, net.Conn) {
	connection, peer := net.Pipe()
	tracked := &trackedConn{connection, readStarted, writeStarted, closes}
	runtime.SetFinalizer(tracked, func(*trackedConn) { close(finalized) })
	return makeJSConn(tracked, 101, 1, func() uint8 { return 1 }), peer
}

func TestJSConnectionCloseReleasesStateAfterPendingIO(t *testing.T) {
	finalized := make(chan struct{})
	readStarted, writeStarted := make(chan struct{}), make(chan struct{})
	var closes atomic.Int32
	connection, peer := trackedJSConn(finalized, &closes, readStarted, writeStarted)
	defer peer.Close()
	closeMethod := connection.Get("close")
	readMethod := connection.Get("readInto")
	writeMethod := connection.Get("write")
	readPromise := readMethod.Invoke(js.Global().Get("Uint8Array").New(32))
	writePromise := writeMethod.Invoke(js.Global().Get("Uint8Array").New(32))
	<-readStarted
	<-writeStarted
	requireJSResolved(t, closeMethod.Invoke())
	requireJSResolved(t, closeMethod.Invoke())
	for label, promise := range map[string]js.Value{"read": readPromise, "write": writePromise} {
		result := requireJSResolved(t, promise)
		if result.Get("code").Int() != streamNetwork {
			t.Fatalf("pending %s did not report a closed connection: %v", label, result)
		}
	}
	if closes.Load() != 1 {
		t.Fatalf("Close called %d times, want 1", closes.Load())
	}
	for label, promise := range map[string]js.Value{
		"cached read":  readMethod.Invoke(js.Global().Get("Uint8Array").New(1)),
		"cached write": writeMethod.Invoke(js.Global().Get("Uint8Array").New(1)),
	} {
		if got := requireJSResolved(t, promise); got.Get("code").Int() != streamNetwork {
			t.Fatalf("%s after close returned %v", label, got)
		}
	}

	// Keep the JS object and previously cached methods alive. Closing the Go
	// connection must still release its buffers and Go state once I/O settles.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		runtime.GC()
		select {
		case <-finalized:
			runtime.KeepAlive(connection)
			runtime.KeepAlive(closeMethod)
			runtime.KeepAlive(readMethod)
			runtime.KeepAlive(writeMethod)
			return
		case <-time.After(20 * time.Millisecond):
		}
	}
	t.Fatal("closed connection remains reachable after pending reads and writes settle")
}

type partialConn struct {
	net.Conn
	writeErr error
	closeErr error
	closes   int
}

func (*partialConn) Read(b []byte) (int, error)    { return copy(b, "ab"), io.EOF }
func (c *partialConn) Write(b []byte) (int, error) { return min(len(b), 2), c.writeErr }
func (c *partialConn) Close() error                { c.closes++; return c.closeErr }

func TestJSConnectionPartialIOAndCloseResults(t *testing.T) {
	c := &partialConn{writeErr: io.ErrClosedPipe, closeErr: errors.New("close failed")}
	path := uint8(1)
	connection := makeJSConn(c, 101, path, func() uint8 { return path })
	read, write := connection.Get("readInto"), connection.Get("write")
	closeMethod, getTransport := connection.Get("close"), connection.Get("getTransport")
	closeWrite := connection.Get("closeWrite")
	for _, promise := range []js.Value{read.Invoke(), read.Invoke(1), read.Invoke(js.ValueOf(map[string]any{})), write.Invoke()} {
		if _, rejected := awaitJSPromise(t, promise); !rejected {
			t.Fatal("invalid I/O arguments did not reject")
		}
	}
	empty := js.Global().Get("Uint8Array").New(0)
	if got := requireJSResolved(t, read.Invoke(empty)); got.Get("count").Int() != 0 || got.Get("code").Int() != streamOK {
		t.Fatalf("empty read returned %v", got)
	}
	buffer := js.Global().Get("Uint8Array").New(4)
	got := requireJSResolved(t, read.Invoke(buffer, 1))
	if got.Get("count").Int() != 1 || got.Get("code").Int() != streamEOF || buffer.Index(0).Int() != int('a') {
		t.Fatalf("partial EOF read lost data or status: %v", got)
	}
	got = requireJSResolved(t, write.Invoke(buffer))
	if got.Get("written").Int() != 2 || got.Get("code").Int() != streamNetwork || got.Get("error").String() != io.ErrClosedPipe.Error() {
		t.Fatalf("partial failed write lost count or error: %v", got)
	}
	c.writeErr = nil
	if got = requireJSResolved(t, write.Invoke(buffer)); got.Type() != js.TypeNumber || got.Int() != 2 {
		t.Fatalf("partial successful write lost count: %v", got)
	}
	if got, rejected := awaitJSPromise(t, closeWrite.Invoke()); !rejected || got.Get("message").String() != "connection does not support half-close" {
		t.Fatalf("unsupported closeWrite returned %v, rejected=%t", got, rejected)
	}
	path = 2
	if getTransport.Invoke().Int() != 2 {
		t.Fatal("transport did not reflect live path")
	}
	path = transportUnknown
	first := closeMethod.Invoke()
	second := closeMethod.Invoke()
	if !first.Equal(second) {
		t.Fatal("repeated close did not reuse pending outcome")
	}
	for _, promise := range []js.Value{first, second, closeMethod.Invoke()} {
		if got, rejected := awaitJSPromise(t, promise); !rejected || got.Get("message").String() != "close failed" {
			t.Fatalf("close error changed: %v, rejected=%t", got, rejected)
		}
	}
	if c.closes != 1 || getTransport.Invoke().Int() != 2 {
		t.Fatalf("closed connection lost close count or last valid path: closes=%d path=%v", c.closes, getTransport.Invoke())
	}
	if got, rejected := awaitJSPromise(t, closeWrite.Invoke()); !rejected || got.Get("message").String() != "connection does not support half-close" {
		t.Fatalf("closed closeWrite returned %v, rejected=%t", got, rejected)
	}
}

type halfCloseConn struct {
	partialConn
	halfCloses int
}

func (c *halfCloseConn) CloseWrite() error { c.halfCloses++; return nil }

func TestJSConnectionCloseWrite(t *testing.T) {
	c := &halfCloseConn{}
	connection := makeJSConn(c, 101, 1, func() uint8 { return 1 })
	closeWrite := connection.Get("closeWrite")
	requireJSResolved(t, closeWrite.Invoke())
	requireJSResolved(t, connection.Get("close").Invoke())
	if got, rejected := awaitJSPromise(t, closeWrite.Invoke()); !rejected || got.Get("message").String() != net.ErrClosed.Error() {
		t.Fatalf("closed closeWrite returned %v, rejected=%t", got, rejected)
	}
	if c.halfCloses != 1 {
		t.Fatalf("underlying CloseWrite called %d times", c.halfCloses)
	}
}

func trackedJSListener(finalized chan struct{}, closes *atomic.Int32) js.Value {
	connection, peer := net.Pipe()
	peer.Close()
	tracked := &trackedConn{Conn: connection, closes: closes}
	runtime.SetFinalizer(tracked, func(*trackedConn) { close(finalized) })
	return makeJSListener("test", tracked.Close)
}

func TestJSListenerCloseReleasesState(t *testing.T) {
	finalized := make(chan struct{})
	var closes atomic.Int32
	listener := trackedJSListener(finalized, &closes)
	closeMethod := listener.Get("close")
	requireJSResolved(t, closeMethod.Invoke())
	requireJSResolved(t, closeMethod.Invoke())
	if closes.Load() != 1 {
		t.Fatalf("listener close called %d times", closes.Load())
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		runtime.GC()
		select {
		case <-finalized:
			runtime.KeepAlive(listener)
			runtime.KeepAlive(closeMethod)
			return
		case <-time.After(20 * time.Millisecond):
		}
	}
	t.Fatal("closed listener still retains Go state")
}
