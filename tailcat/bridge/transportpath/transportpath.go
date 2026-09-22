// Package transportpath classifies the path selected by Tailcat's peer
// discovery result. It is shared by the native and WebAssembly bridges and
// can be tested on the host build.
package transportpath

import (
	"context"
	"net"
	"net/netip"
	"strings"
	"time"

	"github.com/tailscale/tailcat"

	"tailscale.com/ipn/ipnstate"
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

// FromPeer reports the path for the connection's remote peer. Unrelated peers
// can retain relay metadata after disconnecting, so they must not be used as a
// fallback when the connection's peer or its path is unknown.
func FromPeer(status *ipnstate.Status, remote net.Addr) uint8 {
	if status == nil || remote == nil {
		return Unknown
	}
	addr, err := netip.ParseAddrPort(remote.String())
	if err != nil {
		return Unknown
	}
	remoteIP := addr.Addr().Unmap()
	for _, peer := range status.Peer {
		if peer == nil {
			continue
		}
		for _, ip := range peer.TailscaleIPs {
			if ip.Unmap() == remoteIP {
				return FromPing(peer.CurAddr, peer.PeerRelay, peer.Relay != "")
			}
		}
	}
	return Unknown
}

// FromServer looks up only the established connection's remote peer.
func FromServer(server *tailcat.Server, remote net.Addr) uint8 {
	if server == nil || remote == nil {
		return Unknown
	}
	return FromPeer(server.Status(), remote)
}

// FromClient probes the selected path with a bounded discovery ping.
func FromClient(client *tailcat.Client) uint8 {
	if client == nil {
		return Unknown
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result, err := client.DiscoPing(ctx)
	if err != nil || result == nil {
		return Unknown
	}
	return FromPing(result.Endpoint, result.PeerRelay, result.DERPRegionID != 0)
}
