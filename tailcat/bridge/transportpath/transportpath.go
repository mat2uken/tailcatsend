// Package transportpath classifies the path selected by Tailcat's peer
// discovery result. It has no WebAssembly or socket dependency so the
// classifier can be tested on the host build as well as used by the bridge.
package transportpath

import (
	"strings"

	"tailscale.com/tailcfg"
)

const (
	DirectUDP uint8 = iota
	WebRTC
	DERP
	Unknown uint8 = 255
)

func FromEndpoint(endpoint string) uint8 {
	endpoint = strings.TrimSpace(endpoint)
	if idx := strings.Index(endpoint, " ("); idx >= 0 {
		endpoint = endpoint[:idx]
	}
	if endpoint == "" {
		return Unknown
	}
	if strings.HasPrefix(endpoint, tailcfg.WebRTCMagicIP+":") {
		return WebRTC
	}
	return DirectUDP
}

func FromPing(endpoint, peerRelay string, usedDERP bool) uint8 {
	// PingResult documents Endpoint as the path that carried the reply.  A
	// relay field can remain populated as discovery metadata, so a concrete
	// endpoint takes precedence over the fallback relay indicators.
	if path := FromEndpoint(endpoint); path != Unknown {
		return path
	}
	if peerRelay != "" || usedDERP {
		return DERP
	}
	return Unknown
}
