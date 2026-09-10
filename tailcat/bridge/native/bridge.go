//go:build !tailcat_daemon

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
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/tailscale/tailcat"
	_ "tailscale.com/feature/webrtc"
	"tailscale.com/net/netmon"
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

	TC_TRANSPORT_DIRECT_UDP = 0
	TC_TRANSPORT_WEBRTC     = 1
	TC_TRANSPORT_DERP       = 2
	TC_TRANSPORT_UNKNOWN    = 255
)

// bridgeVersion is overridden by release builds with -ldflags=-X. Keeping a
// useful fallback makes locally produced bridge artifacts diagnosable too.
var bridgeVersion = "tailcat-bridge/abi2/dev"

const staticDERPMapJSON = `{"Regions":{"301":{"RegionID":301,"RegionCode":"nyc","RegionName":"New York City","Latitude":40.7128,"Longitude":-74.006,"Nodes":[{"Name":"301a","RegionID":301,"HostName":"tc301a.ipn.dev","IPv4":"199.38.181.166","IPv6":"2607:f740:f::26b","CanPort80":true}]},"302":{"RegionID":302,"RegionCode":"sfo","RegionName":"San Francisco","Latitude":37.7775,"Longitude":-122.416389,"Nodes":[{"Name":"302a","RegionID":302,"HostName":"tc302a.ipn.dev","IPv4":"208.111.39.38","IPv6":"2607:f740:0:3f::720","CanPort80":true}]},"303":{"RegionID":303,"RegionCode":"fra","RegionName":"Frankfurt","Latitude":50.1109,"Longitude":8.6821,"Nodes":[{"Name":"303a","RegionID":303,"HostName":"tc303a.ipn.dev","IPv4":"185.178.202.197","IPv6":"2a00:dd80:20::207","CanPort80":true}]},"304":{"RegionID":304,"RegionCode":"tok","RegionName":"Tokyo","Latitude":35.6764,"Longitude":139.65,"Nodes":[{"Name":"304a","RegionID":304,"HostName":"tc304a.ipn.dev","IPv4":"172.238.7.124","IPv6":"2600:3c18::2000:31ff:fe29:e8e8","CanPort80":true}]}}}`

type staticDERPCache struct{}

func (staticDERPCache) Get(url string) ([]byte, string, time.Time, bool) {
	return []byte(staticDERPMapJSON), "", time.Now(), true
}

func (staticDERPCache) Put(url string, data []byte, etag string) error {
	return nil
}

func init() {
	netmon.RegisterInterfaceGetter(interfacesViaGetifaddrs)
}

func transportFromEndpoint(endpoint string) uint8 {
	endpoint = strings.TrimSpace(endpoint)
	if idx := strings.Index(endpoint, " ("); idx >= 0 {
		endpoint = endpoint[:idx]
	}
	if endpoint == "" {
		return TC_TRANSPORT_UNKNOWN
	}
	if strings.HasPrefix(endpoint, tailcfg.WebRTCMagicIP+":") {
		return TC_TRANSPORT_WEBRTC
	}
	return TC_TRANSPORT_DIRECT_UDP
}

func transportFromPing(endpoint, peerRelay string, usedDERP bool) uint8 {
	if path := transportFromEndpoint(endpoint); path != TC_TRANSPORT_UNKNOWN {
		return path
	}
	if peerRelay != "" || usedDERP {
		return TC_TRANSPORT_DERP
	}
	return TC_TRANSPORT_UNKNOWN
}

func transportFromServer(server *tailcat.Server) uint8 {
	if server == nil {
		return TC_TRANSPORT_UNKNOWN
	}
	status := server.Status()
	if status == nil {
		return TC_TRANSPORT_UNKNOWN
	}
	for _, peer := range status.Peer {
		if peer == nil {
			continue
		}
		if path := transportFromEndpoint(peer.CurAddr); path != TC_TRANSPORT_UNKNOWN {
			return path
		}
		if peer.PeerRelay != "" || peer.Relay != "" {
			return TC_TRANSPORT_DERP
		}
	}
	return TC_TRANSPORT_UNKNOWN
}

func transportFromClient(client *tailcat.Client) uint8 {
	if client == nil {
		return TC_TRANSPORT_UNKNOWN
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result, err := client.DiscoPing(ctx)
	if err != nil || result == nil {
		return TC_TRANSPORT_UNKNOWN
	}
	return transportFromPing(result.Endpoint, result.PeerRelay, result.DERPRegionID != 0)
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
	dials        map[uint64]*dialOperation
	events       chan C.tc_event_t
	stopCh       chan struct{}
	lastErrorMsg string
	shuttingDown atomic.Bool
	generation   uint64
}

type listenerEntry struct {
	mu      sync.Mutex // serializes Start and Close
	handle  uint64
	server  *tailcat.Server
	address string
	closed  atomic.Bool
}

type streamEntry struct {
	handle      uint64
	owner       uint64
	conn        net.Conn
	client      *tailcat.Client
	clientKey   string
	transportMu sync.Mutex
	transport   uint8
	closed      atomic.Bool
	cancelled   atomic.Bool
}

func (s *streamEntry) transportPath() uint8 {
	s.transportMu.Lock()
	defer s.transportMu.Unlock()
	return s.transport
}

func (s *streamEntry) setTransport(path uint8) {
	s.transportMu.Lock()
	s.transport = path
	s.transportMu.Unlock()
}

type bridgeClientEntry struct {
	client *tailcat.Client
	refs   int
}

type dialResult struct {
	stream uint64
	code   C.int32_t
	err    string
}

type dialOperation struct {
	handle     uint64
	generation uint64
	cancel     context.CancelFunc
	done       chan struct{}
	mu         sync.Mutex
	result     dialResult
	finished   bool
	cancelled  bool
}

// Prevent a new generation from starting while old clients are being closed.
var lifecycleMu sync.Mutex

var state = &bridgeState{
	nextHandle: 1,
	listeners:  make(map[uint64]*listenerEntry),
	streams:    make(map[uint64]*streamEntry),
	dials:      make(map[uint64]*dialOperation),
	events:     make(chan C.tc_event_t, 1024),
	stopCh:     make(chan struct{}),
}

func setLastError(msg string) {
	state.mu.Lock()
	state.lastErrorMsg = msg
	state.mu.Unlock()
}

func isInfiniteTimeout(timeout C.uint32_t) bool {
	return timeout == 0 || timeout == ^C.uint32_t(0)
}

func timeoutDuration(timeout C.uint32_t, fallback time.Duration) time.Duration {
	if isInfiniteTimeout(timeout) {
		return fallback
	}
	return time.Duration(timeout) * time.Millisecond
}

func stateStopped() bool {
	return state.shuttingDown.Load()
}

func currentGeneration() uint64 {
	state.mu.Lock()
	generation := state.generation
	state.mu.Unlock()
	return generation
}

func generationActive(generation uint64) bool {
	state.mu.Lock()
	active := !state.shuttingDown.Load() && state.generation == generation
	state.mu.Unlock()
	return active
}

func nextHandleLocked() uint64 {
	h := state.nextHandle
	state.nextHandle++
	return h
}

func takeStream(handle uint64) *streamEntry {
	state.mu.Lock()
	s := state.streams[handle]
	if s != nil {
		delete(state.streams, handle)
	}
	state.mu.Unlock()
	return s
}

func closeStreamEntry(s *streamEntry) {
	if s == nil || s.closed.Swap(true) {
		return
	}
	_ = s.conn.Close()
	if s.clientKey != "" {
		releaseBridgeClient(s.clientKey, s.client, !s.cancelled.Load())
	}
}

func closeListenerEntry(l *listenerEntry) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed.Swap(true) {
		return
	}
	_ = l.server.Close()
}

func enqueueEvent(ev C.tc_event_t, streamHandle uint64) {
	state.mu.Lock()
	owner := state.listeners[uint64(ev.owner_handle)]
	if !state.shuttingDown.Load() && owner != nil && !owner.closed.Load() {
		select {
		case state.events <- ev:
			state.mu.Unlock()
			return
		default:
			// An incoming stream that cannot be reported must not remain in the
			// handle table. Closing it is safer than leaking a live connection with
			// no owner visible to the caller.
		}
	}
	state.mu.Unlock()
	if streamHandle != 0 {
		if s := takeStream(streamHandle); s != nil {
			closeStreamEntry(s)
		}
	}
	setLastError("tailcat bridge event queue is full")
}

func takeListenerStreams(owner uint64) []*streamEntry {
	state.mu.Lock()
	var streams []*streamEntry
	for handle, s := range state.streams {
		if s.owner == owner {
			delete(state.streams, handle)
			streams = append(streams, s)
		}
	}
	state.mu.Unlock()
	return streams
}

func closeAllBridgeClients() {
	bridgeClientsMu.Lock()
	clients := make([]*tailcat.Client, 0, len(bridgeClients))
	for key, entry := range bridgeClients {
		clients = append(clients, entry.client)
		delete(bridgeClients, key)
	}
	bridgeClientsMu.Unlock()
	for _, client := range clients {
		_ = client.Close()
	}
}

//export tc_init
func tc_init() C.int32_t {
	lifecycleMu.Lock()
	defer lifecycleMu.Unlock()
	state.mu.Lock()
	if state.shuttingDown.Load() {
		state.generation++
		state.events = make(chan C.tc_event_t, 1024)
		state.stopCh = make(chan struct{})
		state.listeners = make(map[uint64]*listenerEntry)
		state.streams = make(map[uint64]*streamEntry)
		state.dials = make(map[uint64]*dialOperation)
		state.shuttingDown.Store(false)
	}
	state.mu.Unlock()
	return TC_OK
}

//export tc_shutdown
func tc_shutdown() C.int32_t {
	lifecycleMu.Lock()
	defer lifecycleMu.Unlock()
	state.mu.Lock()
	if state.shuttingDown.Swap(true) {
		state.mu.Unlock()
		return TC_OK
	}
	state.generation++
	close(state.stopCh)
	events := state.events
	listeners := make([]*listenerEntry, 0, len(state.listeners))
	for handle, l := range state.listeners {
		listeners = append(listeners, l)
		delete(state.listeners, handle)
	}
	streams := make([]*streamEntry, 0, len(state.streams))
	for handle, s := range state.streams {
		streams = append(streams, s)
		delete(state.streams, handle)
	}
	dials := make([]*dialOperation, 0, len(state.dials))
	for handle, op := range state.dials {
		dials = append(dials, op)
		delete(state.dials, handle)
	}
	state.mu.Unlock()

	for _, op := range dials {
		op.requestCancel()
	}
	for _, l := range listeners {
		closeListenerEntry(l)
	}
	for _, s := range streams {
		closeStreamEntry(s)
	}
	closeAllBridgeClients()

	// Keep the channel open so a concurrent wait cannot panic; tc_init creates
	// a fresh channel after shutdown and waiters observe stopCh in the meantime.
	for {
		select {
		case <-events:
		default:
			return TC_OK
		}
	}
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
	*out_listener = 0
	generation := currentGeneration()
	if stateStopped() {
		return TC_CANCELLED
	}
	derpURL, validURL := copyCBytes(derp_map_url, derp_map_url_len)
	if !validURL {
		return TC_INVALID_ARGUMENT
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
	if pk.Public.PresharedKey.IsZero() {
		pk.Public.PresharedKey = tailcat.NewPresharedKey()
	}
	pk.Public.Region = []*tailcfg.DERPRegion{reg}
	pk.Public.RegionID = reg.RegionID
	blob := pk.Public.ConnBlob()

	srv := &tailcat.Server{Key: pk.Private, PresharedKey: pk.Public.PresharedKey, Logf: tcLogf, Region: reg}

	state.mu.Lock()
	if state.shuttingDown.Load() || state.generation != generation {
		state.mu.Unlock()
		return TC_CANCELLED
	}
	handle := nextHandleLocked()

	lEntry := &listenerEntry{
		handle:  handle,
		server:  srv,
		address: string(blob),
	}
	state.listeners[handle] = lEntry
	state.mu.Unlock()

	srv.OnTCP = func(port uint16) func(net.Conn) {
		return func(c net.Conn) {
			if stateStopped() || lEntry.closed.Load() {
				_ = c.Close()
				return
			}
			state.mu.Lock()
			if state.shuttingDown.Load() || lEntry.closed.Load() {
				state.mu.Unlock()
				_ = c.Close()
				return
			}
			sHandle := nextHandleLocked()
			sEntry := &streamEntry{
				handle:    sHandle,
				owner:     handle,
				conn:      c,
				transport: transportFromServer(lEntry.server),
			}
			state.streams[sHandle] = sEntry
			state.mu.Unlock()

			var ev C.tc_event_t
			ev.struct_size = C.uint32_t(unsafe.Sizeof(ev))
			ev.event_type = TC_EVENT_INCOMING_STREAM
			ev.owner_handle = C.tc_handle_t(handle)
			ev.object_handle = C.tc_handle_t(sHandle)
			ev.port = C.uint16_t(port)
			ev.reserved = C.uint16_t(transportFromServer(lEntry.server))

			enqueueEvent(ev, sHandle)
		}
	}

	lEntry.mu.Lock()
	var startErr error
	if lEntry.closed.Load() {
		startErr = context.Canceled
	} else {
		startErr = srv.Start()
	}
	lEntry.mu.Unlock()
	if startErr != nil {
		closeListenerEntry(lEntry)
		state.mu.Lock()
		delete(state.listeners, handle)
		state.mu.Unlock()
		setLastError(startErr.Error())
		return TC_NETWORK_ERROR
	}
	if !generationActive(generation) || lEntry.closed.Load() {
		state.mu.Lock()
		delete(state.listeners, handle)
		state.mu.Unlock()
		closeListenerEntry(lEntry)
		return TC_CANCELLED
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

	if capacity < C.size_t(len(addrBytes)) || (len(addrBytes) > 0 && buffer == nil) {
		return TC_BUFFER_TOO_SMALL
	}

	if len(addrBytes) > 0 {
		C.memcpy(unsafe.Pointer(buffer), unsafe.Pointer(&addrBytes[0]), C.size_t(len(addrBytes)))
	}
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

	closeListenerEntry(l)
	// Mark the listener closed before collecting child streams so the accept
	// callback cannot create a new handle between the two operations.
	streams := takeListenerStreams(uint64(listener))
	for _, s := range streams {
		closeStreamEntry(s)
	}
	return TC_OK
}

//export tc_wait_event
func tc_wait_event(timeout_ms C.uint32_t, out_event *C.tc_event_t) C.int32_t {
	if out_event == nil {
		return TC_INVALID_ARGUMENT
	}

	state.mu.Lock()
	events := state.events
	stopCh := state.stopCh
	state.mu.Unlock()

	if timeout_ms == 0 {
		select {
		case ev := <-events:
			*out_event = ev
			return TC_OK
		case <-stopCh:
			return TC_CANCELLED
		default:
			return TC_TIMEOUT
		}
	}

	if timeout_ms == ^C.uint32_t(0) {
		select {
		case ev := <-events:
			*out_event = ev
			return TC_OK
		case <-stopCh:
			return TC_CANCELLED
		}
	}

	timer := time.NewTimer(time.Duration(timeout_ms) * time.Millisecond)
	defer timer.Stop()
	select {
	case ev := <-events:
		*out_event = ev
		return TC_OK
	case <-stopCh:
		return TC_CANCELLED
	case <-timer.C:
		return TC_TIMEOUT
	}
}

var (
	bridgeClientsMu sync.Mutex
	bridgeClients   = make(map[string]*bridgeClientEntry)
)

func bridgeClientKey(addr, derpURL string) string {
	return addr + "\x00" + derpURL
}

func acquireBridgeClient(addr, derpURL string) (*tailcat.Client, string) {
	clientKey := bridgeClientKey(addr, derpURL)
	bridgeClientsMu.Lock()
	defer bridgeClientsMu.Unlock()
	if entry, ok := bridgeClients[clientKey]; ok {
		entry.refs++
		return entry.client, clientKey
	}
	priv := key.NewNode()
	cl := &tailcat.Client{
		Server:       tailcat.ConnBlob(addr),
		Key:          priv,
		Logf:         tcLogf,
		DERPMapURL:   derpURL,
		DERPMapCache: staticDERPCache{},
	}
	bridgeClients[clientKey] = &bridgeClientEntry{client: cl, refs: 1}
	return cl, clientKey
}

func releaseBridgeClient(clientKey string, client *tailcat.Client, drain bool) {
	if clientKey == "" || client == nil {
		return
	}
	bridgeClientsMu.Lock()
	entry, ok := bridgeClients[clientKey]
	if !ok || entry.client != client {
		bridgeClientsMu.Unlock()
		return
	}
	entry.refs--
	if entry.refs > 0 {
		bridgeClientsMu.Unlock()
		return
	}
	delete(bridgeClients, clientKey)
	bridgeClientsMu.Unlock()
	// A normal last-stream close must let the userspace TCP stack send its
	// final FIN/ACK before tearing down WireGuard. Failed/cancelled dials may
	// not have initialized the stack, and intentionally skip this drain.
	if drain {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = client.DrainTCP(ctx)
		cancel()
	}
	_ = client.Close()
}

func copyCBytes(ptr *C.uint8_t, length C.size_t) (string, bool) {
	if length == 0 {
		return "", true
	}
	if ptr == nil || uint64(length) > uint64(int(^uint(0)>>1)) {
		return "", false
	}
	return string(unsafe.Slice((*byte)(unsafe.Pointer(ptr)), int(length))), true
}

func dialStatus(ctx context.Context, err error) C.int32_t {
	if err == nil {
		return TC_OK
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return TC_CANCELLED
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return TC_TIMEOUT
	}
	if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		return TC_TIMEOUT
	}
	return TC_NETWORK_ERROR
}

func dialBridge(ctx context.Context, addr, derpURL string, port uint16, generation uint64) (uint64, C.int32_t, error) {
	state.mu.Lock()
	if state.shuttingDown.Load() || state.generation != generation {
		state.mu.Unlock()
		return 0, TC_CANCELLED, context.Canceled
	}
	client, clientKey := acquireBridgeClient(addr, derpURL)
	state.mu.Unlock()
	c, err := client.DialTCPPort(ctx, port)
	if err != nil {
		releaseBridgeClient(clientKey, client, false)
		code := dialStatus(ctx, err)
		if code != TC_TIMEOUT && code != TC_CANCELLED {
			setLastError(err.Error())
		}
		return 0, code, err
	}
	if ctx.Err() != nil || !generationActive(generation) {
		_ = c.Close()
		releaseBridgeClient(clientKey, client, false)
		return 0, TC_CANCELLED, context.Canceled
	}
	transport := transportFromClient(client)

	state.mu.Lock()
	if state.shuttingDown.Load() || state.generation != generation {
		state.mu.Unlock()
		_ = c.Close()
		releaseBridgeClient(clientKey, client, false)
		return 0, TC_CANCELLED, context.Canceled
	}
	handle := nextHandleLocked()
	state.streams[handle] = &streamEntry{
		handle:    handle,
		conn:      c,
		client:    client,
		clientKey: clientKey,
		transport: transport,
	}
	state.mu.Unlock()
	return handle, TC_OK, nil
}

func (op *dialOperation) finish(result dialResult) {
	op.mu.Lock()
	if op.finished {
		op.mu.Unlock()
		return
	}
	var abandoned uint64
	if op.cancelled {
		abandoned = result.stream
		result = dialResult{code: TC_CANCELLED}
	}
	op.result = result
	op.finished = true
	close(op.done)
	op.mu.Unlock()
	op.cancel()
	if abandoned != 0 {
		closeStreamEntry(takeStream(abandoned))
	}
}

// Cancellation also owns a completed stream until wait transfers it to the
// caller. Merely cancelling the context would leak a successfully dialled one.
func (op *dialOperation) requestCancel() {
	op.mu.Lock()
	op.cancelled = true
	abandoned := op.result.stream
	if op.finished {
		op.result = dialResult{code: TC_CANCELLED}
	}
	op.mu.Unlock()
	op.cancel()
	if abandoned != 0 {
		closeStreamEntry(takeStream(abandoned))
	}
}

func startDialOperation(addr, derpURL string, port uint16, timeout C.uint32_t) (uint64, *dialOperation) {
	baseCtx, cancel := context.WithCancel(context.Background())
	op := &dialOperation{cancel: cancel, done: make(chan struct{})}
	state.mu.Lock()
	if state.shuttingDown.Load() {
		state.mu.Unlock()
		cancel()
		return 0, nil
	}
	op.handle = nextHandleLocked()
	op.generation = state.generation
	state.dials[op.handle] = op
	state.mu.Unlock()

	go func() {
		ctx := baseCtx
		var timeoutCancel context.CancelFunc
		if !isInfiniteTimeout(timeout) {
			ctx, timeoutCancel = context.WithTimeout(baseCtx, time.Duration(timeout)*time.Millisecond)
		} else {
			ctx, timeoutCancel = context.WithTimeout(baseCtx, 60*time.Second)
		}
		stream, code, err := dialBridge(ctx, addr, derpURL, port, op.generation)
		if timeoutCancel != nil {
			timeoutCancel()
		}
		if err != nil && code != TC_TIMEOUT && code != TC_CANCELLED {
			setLastError(err.Error())
		}
		op.finish(dialResult{stream: stream, code: code, err: errorString(err)})
	}()
	return op.handle, op
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
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

	addr, ok := copyCBytes(address, address_len)
	if !ok {
		return TC_INVALID_ARGUMENT
	}
	derpURL, ok := copyCBytes(derp_map_url, derp_map_url_len)
	if !ok {
		return TC_INVALID_ARGUMENT
	}
	if derpURL == "" {
		derpURL = "https://tailcat.dev/derpmap.json"
	}

	if stateStopped() {
		return TC_CANCELLED
	}
	timeout := timeoutDuration(timeout_ms, 60*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	stream, code, _ := dialBridge(ctx, addr, derpURL, uint16(port), currentGeneration())
	if code == TC_OK {
		*out_stream = C.tc_handle_t(stream)
	}
	return code
}

//export tc_stream_dial_start
func tc_stream_dial_start(
	address *C.uint8_t,
	address_len C.size_t,
	derp_map_url *C.uint8_t,
	derp_map_url_len C.size_t,
	port C.uint16_t,
	timeout_ms C.uint32_t,
	out_operation *C.tc_handle_t,
) C.int32_t {
	if address == nil || address_len == 0 || out_operation == nil {
		return TC_INVALID_ARGUMENT
	}
	addr, ok := copyCBytes(address, address_len)
	if !ok {
		return TC_INVALID_ARGUMENT
	}
	derpURL, ok := copyCBytes(derp_map_url, derp_map_url_len)
	if !ok {
		return TC_INVALID_ARGUMENT
	}
	if derpURL == "" {
		derpURL = "https://tailcat.dev/derpmap.json"
	}
	opHandle, op := startDialOperation(addr, derpURL, uint16(port), timeout_ms)
	if op == nil {
		return TC_CANCELLED
	}
	*out_operation = C.tc_handle_t(opHandle)
	return TC_OK
}

//export tc_stream_dial_wait
func tc_stream_dial_wait(
	operation C.tc_handle_t,
	timeout_ms C.uint32_t,
	out_stream *C.tc_handle_t,
) C.int32_t {
	if out_stream == nil {
		return TC_INVALID_ARGUMENT
	}
	*out_stream = 0
	state.mu.Lock()
	op, ok := state.dials[uint64(operation)]
	stopCh := state.stopCh
	state.mu.Unlock()
	if !ok {
		return TC_INVALID_HANDLE_ERROR
	}

	if timeout_ms == 0 {
		select {
		case <-op.done:
		case <-stopCh:
			return TC_CANCELLED
		default:
			return TC_TIMEOUT
		}
	} else if timeout_ms == ^C.uint32_t(0) {
		select {
		case <-op.done:
		case <-stopCh:
			return TC_CANCELLED
		}
	} else {
		timer := time.NewTimer(time.Duration(timeout_ms) * time.Millisecond)
		defer timer.Stop()
		select {
		case <-op.done:
		case <-stopCh:
			return TC_CANCELLED
		case <-timer.C:
			return TC_TIMEOUT
		}
	}

	state.mu.Lock()
	if state.shuttingDown.Load() || state.generation != op.generation {
		state.mu.Unlock()
		return TC_CANCELLED
	}
	if state.dials[uint64(operation)] != op {
		state.mu.Unlock()
		return TC_INVALID_HANDLE_ERROR
	}
	delete(state.dials, uint64(operation))
	op.mu.Lock()
	result := op.result
	op.result.stream = 0 // ownership has transferred; cancellation cannot close it
	op.mu.Unlock()
	state.mu.Unlock()
	if result.code == TC_OK {
		*out_stream = C.tc_handle_t(result.stream)
	}
	return result.code
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
	*out_read = 0

	state.mu.Lock()
	s, ok := state.streams[uint64(stream)]
	state.mu.Unlock()

	if !ok || s.closed.Load() {
		return TC_INVALID_HANDLE_ERROR
	}
	if s.cancelled.Load() {
		return TC_CANCELLED
	}

	var deadline time.Time
	if !isInfiniteTimeout(timeout_ms) {
		deadline = time.Now().Add(time.Duration(timeout_ms) * time.Millisecond)
	}
	if err := s.conn.SetReadDeadline(deadline); err != nil {
		setLastError(err.Error())
		return TC_NETWORK_ERROR
	}

	if uint64(capacity) > uint64(int(^uint(0)>>1)) {
		return TC_INVALID_ARGUMENT
	}
	goSlice := unsafe.Slice((*byte)(unsafe.Pointer(buffer)), int(capacity))
	n, err := s.conn.Read(goSlice)
	*out_read = C.size_t(n)

	// A Reader may return data and an error together. The bytes must remain
	// visible to the caller; the following call reports the terminal error.
	if n > 0 {
		if err != nil && !errors.Is(err, io.EOF) {
			setLastError(err.Error())
		}
		return TC_OK
	}

	if s.cancelled.Load() {
		return TC_CANCELLED
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

func streamWriteAll(s *streamEntry, data []byte, timeout_ms C.uint32_t) (int, C.int32_t) {
	if s.cancelled.Load() {
		return 0, TC_CANCELLED
	}
	var deadline time.Time
	if !isInfiniteTimeout(timeout_ms) {
		deadline = time.Now().Add(time.Duration(timeout_ms) * time.Millisecond)
	}
	if err := s.conn.SetWriteDeadline(deadline); err != nil {
		setLastError(err.Error())
		return 0, TC_NETWORK_ERROR
	}

	total := 0
	for total < len(data) {
		if s.cancelled.Load() {
			return total, TC_CANCELLED
		}
		n, err := s.conn.Write(data[total:])
		if n < 0 || n > len(data)-total {
			setLastError("tailcat bridge connection returned invalid write length")
			return total, TC_INTERNAL_ERROR
		}
		total += n
		if err != nil {
			if s.cancelled.Load() {
				return total, TC_CANCELLED
			}
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				return total, TC_TIMEOUT
			}
			setLastError(err.Error())
			return total, TC_NETWORK_ERROR
		}
		if n == 0 {
			setLastError("tailcat bridge connection returned zero-byte write")
			return total, TC_INTERNAL_ERROR
		}
	}
	return total, TC_OK
}

//export tc_stream_write
func tc_stream_write(
	stream C.tc_handle_t,
	buffer *C.uint8_t,
	length C.size_t,
	out_written *C.size_t,
	timeout_ms C.uint32_t,
) C.int32_t {
	if out_written == nil || (buffer == nil && length != 0) {
		return TC_INVALID_ARGUMENT
	}
	*out_written = 0
	if length == 0 {
		return TC_OK
	}
	if uint64(length) > uint64(int(^uint(0)>>1)) {
		return TC_INVALID_ARGUMENT
	}

	state.mu.Lock()
	s, ok := state.streams[uint64(stream)]
	state.mu.Unlock()
	if !ok || s.closed.Load() {
		return TC_INVALID_HANDLE_ERROR
	}

	// The C caller owns this memory and promises to keep it alive until this
	// call returns. net.Conn.Write must not retain the slice after returning,
	// so this avoids the old C.GoBytes allocation and copy per write.
	data := unsafe.Slice((*byte)(unsafe.Pointer(buffer)), int(length))
	written, code := streamWriteAll(s, data, timeout_ms)
	*out_written = C.size_t(written)
	return code
}

//export tc_stream_write_all
func tc_stream_write_all(
	stream C.tc_handle_t,
	buffer *C.uint8_t,
	length C.size_t,
	timeout_ms C.uint32_t,
) C.int32_t {
	var written C.size_t
	return tc_stream_write(stream, buffer, length, &written, timeout_ms)
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
	} else {
		setLastError("tailcat stream does not support half-close")
		return TC_NETWORK_ERROR
	}
	return TC_OK
}

//export tc_stream_close
func tc_stream_close(stream C.tc_handle_t) C.int32_t {
	s := takeStream(uint64(stream))
	if s == nil {
		return TC_INVALID_HANDLE_ERROR
	}
	closeStreamEntry(s)
	return TC_OK
}

//export tc_stream_transport
func tc_stream_transport(stream C.tc_handle_t, outTransport *C.uint8_t) C.int32_t {
	if outTransport == nil {
		return TC_INVALID_ARGUMENT
	}
	state.mu.Lock()
	s, ok := state.streams[uint64(stream)]
	state.mu.Unlock()
	if !ok || s.closed.Load() {
		return TC_INVALID_HANDLE_ERROR
	}
	path := s.transportPath()
	if path == TC_TRANSPORT_UNKNOWN {
		if s.client != nil {
			path = transportFromClient(s.client)
		} else {
			state.mu.Lock()
			listener := state.listeners[s.owner]
			state.mu.Unlock()
			if listener != nil {
				path = transportFromServer(listener.server)
			}
		}
		if path != TC_TRANSPORT_UNKNOWN {
			s.setTransport(path)
		}
	}
	*outTransport = C.uint8_t(path)
	return TC_OK
}

//export tc_cancel
func tc_cancel(handle C.tc_handle_t) C.int32_t {
	state.mu.Lock()
	s, okStream := state.streams[uint64(handle)]
	l, okListener := state.listeners[uint64(handle)]
	op, okDial := state.dials[uint64(handle)]
	if okDial {
		// A caller that cancels a dial does not wait on the operation handle.
		// Remove it now so repeated start/cancel cycles cannot retain entries
		// until the next bridge shutdown. The operation goroutine still owns its
		// context and will close any late stream in op.finish.
		delete(state.dials, uint64(handle))
	}
	state.mu.Unlock()

	if okDial {
		op.requestCancel()
		return TC_OK
	}
	if okStream {
		if s.cancelled.Swap(true) {
			return TC_OK
		}
		// Closing the connection is needed to wake a blocked gVisor read/write;
		// the handle remains until tc_stream_close so the caller can finish its
		// normal cleanup path.
		_ = s.conn.SetDeadline(time.Now())
		_ = s.conn.Close()
		return TC_OK
	}
	if okListener {
		closeListenerEntry(l)
		for _, child := range takeListenerStreams(uint64(handle)) {
			closeStreamEntry(child)
		}
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

	if capacity < C.size_t(len(msgBytes)) || (len(msgBytes) > 0 && buffer == nil) {
		return TC_BUFFER_TOO_SMALL
	}

	if len(msgBytes) > 0 {
		C.memcpy(unsafe.Pointer(buffer), unsafe.Pointer(&msgBytes[0]), C.size_t(len(msgBytes)))
	}
	return TC_OK
}

//export tc_bridge_version
func tc_bridge_version(buffer *C.uint8_t, capacity C.size_t, out_length *C.size_t) C.int32_t {
	ver := bridgeVersion
	verBytes := []byte(ver)
	if out_length != nil {
		*out_length = C.size_t(len(verBytes))
	}

	if capacity < C.size_t(len(verBytes)) || (len(verBytes) > 0 && buffer == nil) {
		return TC_BUFFER_TOO_SMALL
	}

	C.memcpy(unsafe.Pointer(buffer), unsafe.Pointer(&verBytes[0]), C.size_t(len(verBytes)))
	return TC_OK
}

func main() {}
