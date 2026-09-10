//go:build !tailcat_daemon

package main

import (
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

type scriptedWrite struct {
	n   int
	err error
}

type scriptedConn struct {
	steps    []scriptedWrite
	writes   []int
	readErr  error
	closed   bool
	deadline time.Time
}

func (c *scriptedConn) Read([]byte) (int, error) { return 0, c.readErr }
func (c *scriptedConn) Write(p []byte) (int, error) {
	if c.closed {
		return 0, net.ErrClosed
	}
	if len(c.steps) == 0 {
		return len(p), nil
	}
	step := c.steps[0]
	c.steps = c.steps[1:]
	if step.n > len(p) {
		step.n = len(p)
	}
	c.writes = append(c.writes, step.n)
	return step.n, step.err
}
func (c *scriptedConn) Close() error                  { c.closed = true; return nil }
func (c *scriptedConn) LocalAddr() net.Addr           { return scriptedAddr("local") }
func (c *scriptedConn) RemoteAddr() net.Addr          { return scriptedAddr("remote") }
func (c *scriptedConn) SetDeadline(t time.Time) error { c.deadline = t; return nil }
func (c *scriptedConn) SetReadDeadline(t time.Time) error {
	c.deadline = t
	return nil
}
func (c *scriptedConn) SetWriteDeadline(t time.Time) error {
	c.deadline = t
	return nil
}

type scriptedAddr string

func (a scriptedAddr) Network() string { return "scripted" }
func (a scriptedAddr) String() string  { return string(a) }

func TestStreamWriteAllReportsPartialError(t *testing.T) {
	wantErr := errors.New("write failed")
	conn := &scriptedConn{steps: []scriptedWrite{
		{n: 2},
		{n: 1, err: wantErr},
	}}
	s := &streamEntry{conn: conn}

	written, code := streamWriteAll(s, []byte("hello"), 0)
	if written != 3 {
		t.Fatalf("written = %d, want 3", written)
	}
	if code != TC_NETWORK_ERROR {
		t.Fatalf("code = %d, want TC_NETWORK_ERROR", code)
	}
	if len(conn.writes) != 2 {
		t.Fatalf("writes = %v, want two calls", conn.writes)
	}
}

func TestStreamWriteAllRejectsZeroProgress(t *testing.T) {
	conn := &scriptedConn{steps: []scriptedWrite{{n: 0}}}
	s := &streamEntry{conn: conn}

	written, code := streamWriteAll(s, []byte("hello"), 0)
	if written != 0 {
		t.Fatalf("written = %d, want 0", written)
	}
	if code != TC_INTERNAL_ERROR {
		t.Fatalf("code = %d, want TC_INTERNAL_ERROR", code)
	}
}

func TestStreamWriteAllHonorsPersistentCancellation(t *testing.T) {
	conn := &scriptedConn{}
	s := &streamEntry{conn: conn}
	s.cancelled.Store(true)

	written, code := streamWriteAll(s, []byte("hello"), 0)
	if written != 0 || code != TC_CANCELLED {
		t.Fatalf("result = (%d, %d), want (0, TC_CANCELLED)", written, code)
	}
	if len(conn.writes) != 0 {
		t.Fatalf("cancelled stream wrote data: %v", conn.writes)
	}
}

func TestInitialGenerationIsNotWildcard(t *testing.T) {
	tc_init()
	old := currentGeneration()
	tc_shutdown()
	tc_init()
	if generationActive(old) {
		t.Fatal("old generation remains active after shutdown/init")
	}
	if generationActive(0) {
		t.Fatal("generation zero must not bypass the generation check")
	}
}

func TestDialCancellationClosesCompletedUnclaimedStream(t *testing.T) {
	for _, before := range []bool{true, false} {
		conn := &scriptedConn{}
		state.mu.Lock()
		handle := nextHandleLocked()
		state.streams[handle] = &streamEntry{handle: handle, conn: conn}
		state.mu.Unlock()
		op := &dialOperation{cancel: func() {}, done: make(chan struct{})}
		if before {
			op.requestCancel()
		}
		op.finish(dialResult{stream: handle, code: TC_OK})
		if !before {
			op.requestCancel()
		}
		if !conn.closed {
			t.Fatal("cancelled operation retained its unclaimed stream")
		}
		if op.result.code != TC_CANCELLED || op.result.stream != 0 {
			t.Fatalf("unexpected result: %+v", op.result)
		}
		if takeStream(handle) != nil {
			t.Fatal("cancelled stream remains registered")
		}
	}
}

func TestConcurrentShutdownAndInit(t *testing.T) {
	var workers sync.WaitGroup
	for i := 0; i < 4; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for j := 0; j < 25; j++ {
				tc_shutdown()
				tc_init()
			}
		}()
	}
	workers.Wait()
	tc_init()
	if !generationActive(currentGeneration()) {
		t.Fatal("last initialization is not active")
	}
}

func TestTransportFromEndpoint(t *testing.T) {
	tests := []struct {
		name     string
		endpoint string
		want     uint8
	}{
		{name: "direct", endpoint: "192.0.2.10:41641", want: TC_TRANSPORT_DIRECT_UDP},
		{name: "webrtc", endpoint: "127.3.3.41:3478 (198.51.100.8:443)", want: TC_TRANSPORT_WEBRTC},
		{name: "empty", endpoint: "", want: TC_TRANSPORT_UNKNOWN},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := transportFromEndpoint(tt.endpoint); got != tt.want {
				t.Fatalf("transportFromEndpoint(%q) = %d, want %d", tt.endpoint, got, tt.want)
			}
		})
	}
}

func TestTransportFromPing(t *testing.T) {
	if got := transportFromPing("", "", true); got != TC_TRANSPORT_DERP {
		t.Fatalf("DERP path = %d, want %d", got, TC_TRANSPORT_DERP)
	}
	if got := transportFromPing("", "198.51.100.3:443:vni:1", false); got != TC_TRANSPORT_DERP {
		t.Fatalf("peer relay path = %d, want %d", got, TC_TRANSPORT_DERP)
	}
	if got := transportFromPing("", "", false); got != TC_TRANSPORT_UNKNOWN {
		t.Fatalf("unknown path = %d, want %d", got, TC_TRANSPORT_UNKNOWN)
	}
}
