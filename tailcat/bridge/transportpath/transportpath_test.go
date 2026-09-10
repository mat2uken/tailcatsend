package transportpath

import (
	"testing"

	"tailscale.com/tailcfg"
)

func TestFromEndpoint(t *testing.T) {
	tests := []struct {
		name     string
		endpoint string
		want     uint8
	}{
		{name: "empty", endpoint: "", want: Unknown},
		{name: "direct udp", endpoint: "192.0.2.10:41641", want: DirectUDP},
		{name: "direct udp with annotation", endpoint: "192.0.2.10:41641 (peer)", want: DirectUDP},
		{name: "webrtc", endpoint: tailcfg.WebRTCMagicIP + ":443", want: WebRTC},
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
