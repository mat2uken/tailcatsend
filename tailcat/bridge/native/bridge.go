package main

/*
#include <stdint.h>
#include <stddef.h>
#include <string.h>

typedef uint64_t tc_handle_t;

typedef struct tc_event {
    uint32_t struct_size;
    uint32_t event_type;
    tc_handle_t owner_handle;
    tc_handle_t object_handle;
    uint16_t port;
    uint16_t reserved;
    int32_t status_code;
} tc_event_t;
*/
import "C"

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

const (
	TC_OK                   = 0
	TC_EOF                  = 1
	TC_TIMEOUT              = 2
	TC_CANCELLED            = 3
	TC_INVALID_ARGUMENT     = 10
	TC_INVALID_HANDLE_ERROR = 11
	TC_ALREADY_CLOSED       = 12
	TC_BUFFER_TOO_SMALL     = 13
	TC_NETWORK_ERROR        = 20
	TC_PROTOCOL_ERROR       = 21
	TC_INTERNAL_ERROR       = 255

	TC_EVENT_NONE            = 0
	TC_EVENT_INCOMING_STREAM = 1
	TC_EVENT_LISTENER_ERROR  = 2
	TC_EVENT_STREAM_ERROR    = 3
	TC_EVENT_LOG             = 4
)

type bridgeState struct {
	mu           sync.Mutex
	nextHandle   uint64
	listeners    map[uint64]*listenerEntry
	streams      map[uint64]*streamEntry
	events       chan C.tc_event_t
	lastErrorMsg string
}

type listenerEntry struct {
	handle  uint64
	server  *tailcat.Server
	address string
	closed  atomic.Bool
}

type streamEntry struct {
	handle uint64
	conn   net.Conn
	client *tailcat.Client
	closed atomic.Bool
}

var state = &bridgeState{
	nextHandle: 1,
	listeners:  make(map[uint64]*listenerEntry),
	streams:    make(map[uint64]*streamEntry),
	events:     make(chan C.tc_event_t, 1024),
}

func setLastError(msg string) {
	state.mu.Lock()
	state.lastErrorMsg = msg
	state.mu.Unlock()
}

//export tc_init
func tc_init() C.int32_t {
	return TC_OK
}

//export tc_shutdown
func tc_shutdown() C.int32_t {
	state.mu.Lock()
	for _, l := range state.listeners {
		l.closed.Store(true)
		l.server.Close()
	}
	for _, s := range state.streams {
		s.closed.Store(true)
		s.conn.Close()
		if s.client != nil {
			s.client.Close()
		}
	}
	state.listeners = make(map[uint64]*listenerEntry)
	state.streams = make(map[uint64]*streamEntry)
	state.mu.Unlock()
	return TC_OK
}

//export tc_listener_create
func tc_listener_create(
	derp_map_url *C.uint8_t,
	derp_map_url_len C.size_t,
	verbose C.uint8_t,
	out_listener *C.tc_handle_t,
) C.int32_t {
	if out_listener == nil {
		return TC_INVALID_ARGUMENT
	}
	derpURL := ""
	if derp_map_url != nil && derp_map_url_len > 0 {
		derpURL = string(C.GoBytes(unsafe.Pointer(derp_map_url), C.int(derp_map_url_len)))
	}
	if derpURL == "" {
		derpURL = "https://tailcat.dev/derpmap.json"
	}

	pk := tailcat.NewPrivateKey()
	pk.Public.RegionID = -1

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	ci := pk.Public
	if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(derpURL)); err != nil {
		setLastError(err.Error())
		return TC_NETWORK_ERROR
	}
	reg := ci.Region[0]
	pk.Public.RegionID = reg.RegionID
	blob := pk.Public.ConnBlob()

	logf := logger.Discard
	if verbose != 0 {
		logf = logger.Discard // can plug standard logger
	}

	srv := &tailcat.Server{Key: pk.Private, Logf: logf, Region: reg}

	state.mu.Lock()
	handle := state.nextHandle
	state.nextHandle++

	lEntry := &listenerEntry{
		handle:  handle,
		server:  srv,
		address: string(blob),
	}
	state.listeners[handle] = lEntry
	state.mu.Unlock()

	srv.OnTCP = func(port uint16) func(net.Conn) {
		return func(c net.Conn) {
			state.mu.Lock()
			sHandle := state.nextHandle
			state.nextHandle++
			sEntry := &streamEntry{
				handle: sHandle,
				conn:   c,
			}
			state.streams[sHandle] = sEntry
			state.mu.Unlock()

			var ev C.tc_event_t
			ev.struct_size = C.uint32_t(unsafe.Sizeof(ev))
			ev.event_type = TC_EVENT_INCOMING_STREAM
			ev.owner_handle = C.tc_handle_t(handle)
			ev.object_handle = C.tc_handle_t(sHandle)
			ev.port = C.uint16_t(port)

			select {
			case state.events <- ev:
			default:
			}
		}
	}

	if err := srv.Start(); err != nil {
		srv.Close()
		state.mu.Lock()
		delete(state.listeners, handle)
		state.mu.Unlock()
		setLastError(err.Error())
		return TC_NETWORK_ERROR
	}

	*out_listener = C.tc_handle_t(handle)
	return TC_OK
}

//export tc_listener_address
func tc_listener_address(
	listener C.tc_handle_t,
	buffer *C.uint8_t,
	capacity C.size_t,
	out_length *C.size_t,
) C.int32_t {
	state.mu.Lock()
	l, ok := state.listeners[uint64(listener)]
	state.mu.Unlock()

	if !ok || l.closed.Load() {
		return TC_INVALID_HANDLE_ERROR
	}

	addrBytes := []byte(l.address)
	if out_length != nil {
		*out_length = C.size_t(len(addrBytes))
	}

	if buffer == nil || capacity < C.size_t(len(addrBytes)) {
		return TC_BUFFER_TOO_SMALL
	}

	C.memcpy(unsafe.Pointer(buffer), unsafe.Pointer(&addrBytes[0]), C.size_t(len(addrBytes)))
	return TC_OK
}

//export tc_listener_close
func tc_listener_close(listener C.tc_handle_t) C.int32_t {
	state.mu.Lock()
	l, ok := state.listeners[uint64(listener)]
	if ok {
		delete(state.listeners, uint64(listener))
	}
	state.mu.Unlock()

	if !ok {
		return TC_INVALID_HANDLE_ERROR
	}

	l.closed.Store(true)
	l.server.Close()
	return TC_OK
}

//export tc_wait_event
func tc_wait_event(timeout_ms C.uint32_t, out_event *C.tc_event_t) C.int32_t {
	if out_event == nil {
		return TC_INVALID_ARGUMENT
	}

	if timeout_ms == 0 {
		select {
		case ev := <-state.events:
			*out_event = ev
			return TC_OK
		default:
			return TC_TIMEOUT
		}
	}

	if timeout_ms == ^C.uint32_t(0) {
		ev := <-state.events
		*out_event = ev
		return TC_OK
	}

	select {
	case ev := <-state.events:
		*out_event = ev
		return TC_OK
	case <-time.After(time.Duration(timeout_ms) * time.Millisecond):
		return TC_TIMEOUT
	}
}

//export tc_stream_dial
func tc_stream_dial(
	address *C.uint8_t,
	address_len C.size_t,
	derp_map_url *C.uint8_t,
	derp_map_url_len C.size_t,
	port C.uint16_t,
	timeout_ms C.uint32_t,
	out_stream *C.tc_handle_t,
) C.int32_t {
	if address == nil || address_len == 0 || out_stream == nil {
		return TC_INVALID_ARGUMENT
	}

	addr := string(C.GoBytes(unsafe.Pointer(address), C.int(address_len)))
	derpURL := ""
	if derp_map_url != nil && derp_map_url_len > 0 {
		derpURL = string(C.GoBytes(unsafe.Pointer(derp_map_url), C.int(derp_map_url_len)))
	}
	if derpURL == "" {
		derpURL = "https://tailcat.dev/derpmap.json"
	}

	timeout := 60 * time.Second
	if timeout_ms > 0 && timeout_ms != ^C.uint32_t(0) {
		timeout = time.Duration(timeout_ms) * time.Millisecond
	}

	priv := key.NewNode()
	cl := &tailcat.Client{
		Server:     tailcat.ConnBlob(addr),
		Key:        priv,
		Logf:       logger.Discard,
		DERPMapURL: derpURL,
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	for {
		pctx, pcancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := cl.Ping(pctx)
		pcancel()
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			cl.Close()
			setLastError("ping timeout: " + err.Error())
			return TC_TIMEOUT
		}
	}

	c, err := cl.DialTCPPort(ctx, uint16(port))
	if err != nil {
		cl.Close()
		setLastError(err.Error())
		return TC_NETWORK_ERROR
	}

	state.mu.Lock()
	sHandle := state.nextHandle
	state.nextHandle++
	sEntry := &streamEntry{
		handle: sHandle,
		conn:   c,
		client: cl,
	}
	state.streams[sHandle] = sEntry
	state.mu.Unlock()

	*out_stream = C.tc_handle_t(sHandle)
	return TC_OK
}

//export tc_stream_read
func tc_stream_read(
	stream C.tc_handle_t,
	buffer *C.uint8_t,
	capacity C.size_t,
	out_read *C.size_t,
	timeout_ms C.uint32_t,
) C.int32_t {
	if buffer == nil || capacity == 0 || out_read == nil {
		return TC_INVALID_ARGUMENT
	}

	state.mu.Lock()
	s, ok := state.streams[uint64(stream)]
	state.mu.Unlock()

	if !ok || s.closed.Load() {
		return TC_INVALID_HANDLE_ERROR
	}

	if timeout_ms > 0 && timeout_ms != ^C.uint32_t(0) {
		s.conn.SetReadDeadline(time.Now().Add(time.Duration(timeout_ms) * time.Millisecond))
	} else {
		s.conn.SetReadDeadline(time.Time{})
	}

	goSlice := unsafe.Slice((*byte)(unsafe.Pointer(buffer)), int(capacity))
	n, err := s.conn.Read(goSlice)
	*out_read = C.size_t(n)

	if n > 0 {
		return TC_OK
	}

	if errors.Is(err, io.EOF) {
		return TC_EOF
	}

	if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		return TC_TIMEOUT
	}

	if err != nil {
		setLastError(err.Error())
		return TC_NETWORK_ERROR
	}

	return TC_OK
}

//export tc_stream_write_all
func tc_stream_write_all(
	stream C.tc_handle_t,
	buffer *C.uint8_t,
	length C.size_t,
	timeout_ms C.uint32_t,
) C.int32_t {
	if buffer == nil || length == 0 {
		return TC_OK
	}

	state.mu.Lock()
	s, ok := state.streams[uint64(stream)]
	state.mu.Unlock()

	if !ok || s.closed.Load() {
		return TC_INVALID_HANDLE_ERROR
	}

	if timeout_ms > 0 && timeout_ms != ^C.uint32_t(0) {
		s.conn.SetWriteDeadline(time.Now().Add(time.Duration(timeout_ms) * time.Millisecond))
	} else {
		s.conn.SetWriteDeadline(time.Time{})
	}

	data := C.GoBytes(unsafe.Pointer(buffer), C.int(length))
	total := 0
	for total < len(data) {
		n, err := s.conn.Write(data[total:])
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				return TC_TIMEOUT
			}
			setLastError(err.Error())
			return TC_NETWORK_ERROR
		}
		total += n
	}

	return TC_OK
}

//export tc_stream_close_write
func tc_stream_close_write(stream C.tc_handle_t) C.int32_t {
	state.mu.Lock()
	s, ok := state.streams[uint64(stream)]
	state.mu.Unlock()

	if !ok || s.closed.Load() {
		return TC_INVALID_HANDLE_ERROR
	}

	if cw, ok := s.conn.(interface{ CloseWrite() error }); ok {
		if err := cw.CloseWrite(); err != nil {
			setLastError(err.Error())
			return TC_NETWORK_ERROR
		}
	}
	return TC_OK
}

//export tc_stream_close
func tc_stream_close(stream C.tc_handle_t) C.int32_t {
	state.mu.Lock()
	s, ok := state.streams[uint64(stream)]
	if ok {
		delete(state.streams, uint64(stream))
	}
	state.mu.Unlock()

	if !ok {
		return TC_INVALID_HANDLE_ERROR
	}

	s.closed.Store(true)
	s.conn.Close()
	if s.client != nil {
		s.client.Close()
	}
	return TC_OK
}

//export tc_cancel
func tc_cancel(handle C.tc_handle_t) C.int32_t {
	state.mu.Lock()
	s, okStream := state.streams[uint64(handle)]
	l, okListener := state.listeners[uint64(handle)]
	state.mu.Unlock()

	if okStream {
		s.conn.SetDeadline(time.Now())
		return TC_OK
	}
	if okListener {
		l.server.Close()
		return TC_OK
	}
	return TC_INVALID_HANDLE_ERROR
}

//export tc_last_error
func tc_last_error(buffer *C.uint8_t, capacity C.size_t, out_length *C.size_t) C.int32_t {
	state.mu.Lock()
	msg := state.lastErrorMsg
	state.mu.Unlock()

	msgBytes := []byte(msg)
	if out_length != nil {
		*out_length = C.size_t(len(msgBytes))
	}

	if buffer == nil || capacity < C.size_t(len(msgBytes)) {
		return TC_BUFFER_TOO_SMALL
	}

	if len(msgBytes) > 0 {
		C.memcpy(unsafe.Pointer(buffer), unsafe.Pointer(&msgBytes[0]), C.size_t(len(msgBytes)))
	}
	return TC_OK
}

//export tc_bridge_version
func tc_bridge_version(buffer *C.uint8_t, capacity C.size_t, out_length *C.size_t) C.int32_t {
	ver := "1.0.0-tailcat-4a25a91"
	verBytes := []byte(ver)
	if out_length != nil {
		*out_length = C.size_t(len(verBytes))
	}

	if buffer == nil || capacity < C.size_t(len(verBytes)) {
		return TC_BUFFER_TOO_SMALL
	}

	C.memcpy(unsafe.Pointer(buffer), unsafe.Pointer(&verBytes[0]), C.size_t(len(verBytes)))
	return TC_OK
}

func main() {}
