//go:build js && wasm

package main

import (
	"errors"
	"io"
	"net"
	"syscall/js"
	"testing"
	"time"
)

func TestListenerStopWaitsForCallback(t *testing.T) {
	var callbacks listenerCallbacks
	connection, peer := net.Pipe()
	defer connection.Close()
	defer peer.Close()
	entered := make(chan struct{})
	release := make(chan struct{})
	delivered := make(chan struct{})
	go func() {
		callbacks.deliver(connection, func(net.Conn) {
			close(entered)
			<-release
		})
		close(delivered)
	}()
	<-entered
	stopping := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		close(stopping)
		callbacks.stop()
		close(stopped)
	}()
	<-stopping
	select {
	case <-stopped:
		t.Fatal("stop returned while the callback was active")
	default:
	}
	close(release)
	<-delivered
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("stop did not return after the callback")
	}
}

func TestListenerCallbackCanStartClose(t *testing.T) {
	var callbacks listenerCallbacks
	var closing js.Value
	closeListener := js.FuncOf(func(_ js.Value, _ []js.Value) any {
		return makePromise(func() (any, error) {
			callbacks.stop()
			return js.Undefined(), nil
		})
	})
	defer closeListener.Release()
	accepted := js.FuncOf(func(_ js.Value, _ []js.Value) any {
		// Reenter close synchronously from onConnection, as a JS caller can.
		closing = closeListener.Invoke()
		return nil
	})
	defer accepted.Release()
	connection, peer := net.Pipe()
	defer connection.Close()
	defer peer.Close()
	callbacks.deliver(connection, func(net.Conn) { accepted.Invoke() })
	settled := make(chan bool, 1)
	resolved := js.FuncOf(func(_ js.Value, _ []js.Value) any {
		settled <- true
		return nil
	})
	defer resolved.Release()
	rejected := js.FuncOf(func(_ js.Value, _ []js.Value) any {
		settled <- false
		return nil
	})
	defer rejected.Release()
	closing.Call("then", resolved, rejected)
	select {
	case success := <-settled:
		if !success {
			t.Fatal("close rejected")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("reentrant close did not settle")
	}
	// The owner can now drop onConnection. A late arrival must be closed
	// without invoking it or creating another JavaScript connection wrapper.
	late, latePeer := net.Pipe()
	defer late.Close()
	defer latePeer.Close()
	called := false
	callbacks.deliver(late, func(net.Conn) { called = true })
	if called {
		t.Fatal("callback ran after close settled")
	}
	late.SetWriteDeadline(time.Now().Add(time.Second))
	if _, err := late.Write([]byte{1}); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("late connection was not closed: %v", err)
	}
}
