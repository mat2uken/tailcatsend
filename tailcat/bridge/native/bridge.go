package main

/*
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#ifdef __ANDROID__
#include <android/log.h>
static void tc_android_log(const char* msg) {
    __android_log_print(ANDROID_LOG_INFO, "TailcatGo", "%s", msg);
}
#else
static void tc_android_log(const char* msg) {}
#endif

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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
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

const staticDERPMapJSON = `{"Regions":{"301":{"RegionID":301,"RegionCode":"nyc","RegionName":"New York City","Latitude":40.7128,"Longitude":-74.006,"Nodes":[{"Name":"301a","RegionID":301,"HostName":"tc301a.ipn.dev","IPv4":"199.38.181.166","IPv6":"2607:f740:f::26b","CanPort80":true}]},"302":{"RegionID":302,"RegionCode":"sfo","RegionName":"San Francisco","Latitude":37.7775,"Longitude":-122.416389,"Nodes":[{"Name":"302a","RegionID":302,"HostName":"tc302a.ipn.dev","IPv4":"208.111.39.38","IPv6":"2607:f740:0:3f::720","CanPort80":true}]},"303":{"RegionID":303,"RegionCode":"fra","RegionName":"Frankfurt","Latitude":50.1109,"Longitude":8.6821,"Nodes":[{"Name":"303a","RegionID":303,"HostName":"tc303a.ipn.dev","IPv4":"185.178.202.197","IPv6":"2a00:dd80:20::207","CanPort80":true}]},"304":{"RegionID":304,"RegionCode":"tok","RegionName":"Tokyo","Latitude":35.6764,"Longitude":139.65,"Nodes":[{"Name":"304a","RegionID":304,"HostName":"tc304a.ipn.dev","IPv4":"172.238.7.124","IPv6":"2600:3c18::2000:31ff:fe29:e8e8","CanPort80":true}]}}}`

type staticDERPCache struct{}

func (staticDERPCache) Get(url string) ([]byte, string, time.Time, bool) {
	return []byte(staticDERPMapJSON), "", time.Now(), true
}

func (staticDERPCache) Put(url string, data []byte, etag string) error {
	return nil
}

func tcLogf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	cStr := C.CString(msg)
	defer C.free(unsafe.Pointer(cStr))
	C.tc_android_log(cStr)
	fmt.Printf("[TailcatGo] %s\n", msg)
}

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
) (retCode C.int32_t) {
	defer func() {
		if r := recover(); r != nil {
			buf := make([]byte, 4096)
			n := runtime.Stack(buf, false)
			msg := fmt.Sprintf("panic in tc_listener_create: %v\nstack:\n%s", r, buf[:n])
			setLastError(msg)
			fmt.Printf("❌ %s\n", msg)
			retCode = TC_INTERNAL_ERROR
		}
	}()
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
	pk.Public.RegionID = 304

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	ci := pk.Public
	if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(derpURL)); err != nil {
		var dm tailcfg.DERPMap
		if jErr := json.Unmarshal([]byte(staticDERPMapJSON), &dm); jErr == nil {
			if fErr := ci.Expand(context.Background(), tailcat.ExpandForServer, &dm); fErr != nil {
				setLastError("network err: " + err.Error() + " | fallback err: " + fErr.Error())
				return TC_NETWORK_ERROR
			}
		} else {
			setLastError(err.Error())
			return TC_NETWORK_ERROR
		}
	}
	var reg *tailcfg.DERPRegion
	if len(ci.Region) > 0 {
		reg = ci.Region[0]
	} else {
		var dm tailcfg.DERPMap
		_ = json.Unmarshal([]byte(staticDERPMapJSON), &dm)
		if r, ok := dm.Regions[ci.RegionID]; ok {
			reg = r
		} else if r304, ok2 := dm.Regions[304]; ok2 {
			reg = r304
		}
	}
	if reg == nil {
		setLastError("no valid DERP region found")
		return TC_INTERNAL_ERROR
	}
	pk.Public.Region = []*tailcfg.DERPRegion{reg}
	pk.Public.RegionID = reg.RegionID
	blob := pk.Public.ConnBlob()

	srv := &tailcat.Server{Key: pk.Private, Logf: tcLogf, Region: reg}

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

var (
	bridgeClientsMu sync.Mutex
	bridgeClients   = make(map[string]*tailcat.Client)
)

func getOrCreateBridgeClient(addr, derpURL string) *tailcat.Client {
	bridgeClientsMu.Lock()
	defer bridgeClientsMu.Unlock()
	if cl, ok := bridgeClients[addr]; ok {
		return cl
	}
	priv := key.NewNode()
	cl := &tailcat.Client{
		Server:       tailcat.ConnBlob(addr),
		Key:          priv,
		Logf:         tcLogf,
		DERPMapURL:   derpURL,
		DERPMapCache: staticDERPCache{},
	}
	bridgeClients[addr] = cl
	return cl
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
) (retCode C.int32_t) {
	defer func() {
		if r := recover(); r != nil {
			buf := make([]byte, 4096)
			n := runtime.Stack(buf, false)
			msg := fmt.Sprintf("panic in tc_stream_dial: %v\nstack:\n%s", r, buf[:n])
			setLastError(msg)
			fmt.Printf("❌ %s\n", msg)
			retCode = TC_INTERNAL_ERROR
		}
	}()
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

	cl := getOrCreateBridgeClient(addr, derpURL)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	c, err := cl.DialTCPPort(ctx, uint16(port))
	if err != nil {
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
