//go:build !windows && !tailcat_daemon

package main

/*
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <stdlib.h>
*/
import "C"

import (
	"fmt"
	"net"
	"unsafe"

	"tailscale.com/net/netmon"
)

// interfacesViaGetifaddrs enumerates interfaces with getifaddrs(3). Android
// uses the same bionic API because net.Interfaces may be denied by SELinux.
func interfacesViaGetifaddrs() ([]netmon.Interface, error) {
	var ifap *C.struct_ifaddrs
	if rc := C.getifaddrs(&ifap); rc != 0 {
		return nil, fmt.Errorf("getifaddrs: %v", int(rc))
	}
	defer C.freeifaddrs(ifap)

	type entry struct {
		iface *net.Interface
		addrs []net.Addr
	}
	entries := map[string]*entry{}
	var order []string
	for cur := ifap; cur != nil; cur = cur.ifa_next {
		name := C.GoString(cur.ifa_name)
		e, ok := entries[name]
		if !ok {
			e = &entry{iface: &net.Interface{Name: name, MTU: 1500}}
			entries[name] = e
			order = append(order, name)
		}
		e.iface.Flags |= cgoFlagsToNetFlags(cur.ifa_flags)
		if cur.ifa_addr == nil {
			continue
		}
		switch int(cur.ifa_addr.sa_family) {
		case C.AF_INET:
			sa := (*C.struct_sockaddr_in)(unsafe.Pointer(cur.ifa_addr))
			ip := net.IP(C.GoBytes(unsafe.Pointer(&sa.sin_addr.s_addr), 4))
			e.addrs = append(e.addrs, ipAddrWithMask(ip, cur.ifa_netmask))
		case C.AF_INET6:
			sa := (*C.struct_sockaddr_in6)(unsafe.Pointer(cur.ifa_addr))
			ip := net.IP(C.GoBytes(unsafe.Pointer(&sa.sin6_addr), 16))
			e.addrs = append(e.addrs, ipAddrWithMask(ip, cur.ifa_netmask))
		}
	}
	ret := make([]netmon.Interface, 0, len(order))
	for _, name := range order {
		e := entries[name]
		cs := C.CString(name)
		e.iface.Index = int(C.if_nametoindex(cs))
		C.free(unsafe.Pointer(cs))
		ret = append(ret, netmon.Interface{Interface: e.iface, AltAddrs: e.addrs})
	}
	return ret, nil
}

func cgoFlagsToNetFlags(f C.uint) net.Flags {
	var out net.Flags
	mask := map[C.uint]net.Flags{
		C.IFF_UP:          net.FlagUp,
		C.IFF_BROADCAST:   net.FlagBroadcast,
		C.IFF_LOOPBACK:    net.FlagLoopback,
		C.IFF_POINTOPOINT: net.FlagPointToPoint,
		C.IFF_RUNNING:     net.FlagRunning,
		C.IFF_MULTICAST:   net.FlagMulticast,
	}
	for key, value := range mask {
		if f&key != 0 {
			out |= value
		}
	}
	return out
}

func ipAddrWithMask(ip net.IP, netmask *C.struct_sockaddr) net.Addr {
	if netmask == nil {
		return &net.IPAddr{IP: ip}
	}
	var maskLen int
	switch int(netmask.sa_family) {
	case C.AF_INET:
		sa := (*C.struct_sockaddr_in)(unsafe.Pointer(netmask))
		mask := net.IPMask(C.GoBytes(unsafe.Pointer(&sa.sin_addr.s_addr), 4))
		maskLen, _ = net.IPv4Mask(mask[0], mask[1], mask[2], mask[3]).Size()
		return &net.IPNet{IP: ip, Mask: net.CIDRMask(maskLen, 32)}
	case C.AF_INET6:
		sa := (*C.struct_sockaddr_in6)(unsafe.Pointer(netmask))
		mask := net.IPMask(C.GoBytes(unsafe.Pointer(&sa.sin6_addr), 16))
		maskLen, _ = mask.Size()
		return &net.IPNet{IP: ip, Mask: net.CIDRMask(maskLen, 128)}
	}
	return &net.IPAddr{IP: ip}
}
