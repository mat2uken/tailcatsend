//go:build windows && !tailcat_daemon

package main

import (
	"net"

	"tailscale.com/net/netmon"
)

// Windows uses the standard library enumeration. Unix-only getifaddrs
// headers are kept out of the c-shared DLL build.
func interfacesViaGetifaddrs() ([]netmon.Interface, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	result := make([]netmon.Interface, 0, len(interfaces))
	for index := range interfaces {
		result = append(result, netmon.Interface{Interface: &interfaces[index]})
	}
	return result, nil
}
