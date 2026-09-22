package transportpath

import (
	"net"
	"net/netip"
	"testing"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

func TestFromEndpoint(t *testing.T) {
	tests := []struct {
		name     string
		endpoint string
		want     uint8
	}{
		{name: "empty", endpoint: "", want: Unknown},
		{name: "direct udp", endpoint: "192.0.2.10:41641", want: DirectUDP},
		{name: "trimmed direct udp", endpoint: " 192.0.2.10:41641 ", want: DirectUDP},
		{name: "direct udp with annotation", endpoint: "192.0.2.10:41641 (peer)", want: DirectUDP},
		{name: "webrtc", endpoint: tailcfg.WebRTCMagicIP + ":443", want: WebRTC},
		{name: "webrtc with annotation", endpoint: tailcfg.WebRTCMagicIP + ":443 (198.51.100.8:443)", want: WebRTC},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := FromEndpoint(test.endpoint); got != test.want {
				t.Fatalf("FromEndpoint(%q) = %d, want %d", test.endpoint, got, test.want)
			}
		})
	}
}

func TestFromPing(t *testing.T) {
	tests := []struct {
		name     string
		endpoint string
		relay    string
		usedDERP bool
		want     uint8
	}{
		{name: "endpoint wins", endpoint: "192.0.2.10:41641", relay: "derp-1", usedDERP: true, want: DirectUDP},
		{name: "webrtc endpoint wins", endpoint: tailcfg.WebRTCMagicIP + ":443", relay: "derp-1", usedDERP: true, want: WebRTC},
		{name: "relay fallback", relay: "derp-1", want: DERP},
		{name: "derp flag fallback", usedDERP: true, want: DERP},
		{name: "unknown", want: Unknown},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := FromPing(test.endpoint, test.relay, test.usedDERP); got != test.want {
				t.Fatalf("FromPing(%q, %q, %t) = %d, want %d", test.endpoint, test.relay, test.usedDERP, got, test.want)
			}
		})
	}
}

func TestFromPeer(t *testing.T) {
	remoteIP := netip.MustParseAddr("fd7a:115c:a1e0::2")
	remote := &net.TCPAddr{IP: net.IP(remoteIP.AsSlice()), Port: 12345}
	otherIP := netip.MustParseAddr("fd7a:115c:a1e0::3")
	peerKey := key.NewNode().Public()
	otherKey := key.NewNode().Public()
	for _, test := range []struct {
		name   string
		status *ipnstate.Status
		remote net.Addr
		want   uint8
	}{
		{
			name: "webrtc peer with unrelated derp peer",
			status: &ipnstate.Status{Peer: map[key.NodePublic]*ipnstate.PeerStatus{
				peerKey:  {TailscaleIPs: []netip.Addr{otherIP, remoteIP}, CurAddr: tailcfg.WebRTCMagicIP + ":443 (198.51.100.8:443)", Relay: "tok"},
				otherKey: {TailscaleIPs: []netip.Addr{netip.MustParseAddr("fd7a:115c:a1e0::4")}, Relay: "tok"},
			}},
			remote: remote, want: WebRTC,
		},
		{
			name: "unknown matching peer does not use another peer",
			status: &ipnstate.Status{Peer: map[key.NodePublic]*ipnstate.PeerStatus{
				peerKey:  {TailscaleIPs: []netip.Addr{remoteIP}},
				otherKey: {TailscaleIPs: []netip.Addr{otherIP}, Relay: "tok"},
			}},
			remote: remote, want: Unknown,
		},
		{
			name: "unmatched peer",
			status: &ipnstate.Status{Peer: map[key.NodePublic]*ipnstate.PeerStatus{
				otherKey: {TailscaleIPs: []netip.Addr{otherIP}, Relay: "tok"},
			}},
			remote: remote, want: Unknown,
		},
		{
			name: "derp matching peer",
			status: &ipnstate.Status{Peer: map[key.NodePublic]*ipnstate.PeerStatus{
				peerKey: {TailscaleIPs: []netip.Addr{remoteIP}, PeerRelay: "198.51.100.3:443:vni:1"},
			}},
			remote: remote, want: DERP,
		},
		{
			name: "mapped ipv4 matches unmapped ip",
			status: &ipnstate.Status{Peer: map[key.NodePublic]*ipnstate.PeerStatus{
				peerKey: {TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.2")}, CurAddr: "192.0.2.2:12345"},
			}},
			remote: &net.TCPAddr{IP: net.ParseIP("::ffff:100.64.0.2"), Port: 12345}, want: DirectUDP,
		},
		{name: "missing peer IPs", status: &ipnstate.Status{Peer: map[key.NodePublic]*ipnstate.PeerStatus{peerKey: {Relay: "tok"}}}, remote: remote, want: Unknown},
		{name: "nil status", remote: remote, want: Unknown},
		{name: "nil peer", status: &ipnstate.Status{Peer: map[key.NodePublic]*ipnstate.PeerStatus{peerKey: nil}}, remote: remote, want: Unknown},
		{name: "nil remote", status: &ipnstate.Status{Peer: map[key.NodePublic]*ipnstate.PeerStatus{peerKey: {Relay: "tok"}}}, want: Unknown},
		{name: "non IP remote", status: &ipnstate.Status{Peer: map[key.NodePublic]*ipnstate.PeerStatus{peerKey: {Relay: "tok"}}}, remote: &net.UnixAddr{Name: "socket", Net: "unix"}, want: Unknown},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := FromPeer(test.status, test.remote); got != test.want {
				t.Fatalf("FromPeer() = %d, want %d", got, test.want)
			}
		})
	}
}
