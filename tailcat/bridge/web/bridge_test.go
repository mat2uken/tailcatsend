package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

func TestTailcatServerAndClientDirect(t *testing.T) {
	derpURL := "https://tailcat.dev/derpmap.json"

	// 1. Initialize Server with Ephemeral Key
	pk := tailcat.NewPrivateKey()
	pk.Public.RegionID = -1

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	ci := pk.Public
	if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(derpURL)); err != nil {
		t.Fatalf("Server Expand failed: %v", err)
	}
	reg := ci.Region[0]
	pk.Public.RegionID = reg.RegionID

	serverAccepted := make(chan net.Conn, 1)
	serverPort := make(chan uint16, 1)

	srv := &tailcat.Server{
		Key:          pk.Private,
		PresharedKey: pk.Public.PresharedKey,
		Logf:         logger.Discard,
		Region:       reg,
	}
	srv.OnTCP = func(port uint16) func(net.Conn) {
		return func(c net.Conn) {
			serverPort <- port
			serverAccepted <- c
		}
	}
	if err := srv.Start(); err != nil {
		t.Fatalf("Server Start failed: %v", err)
	}
	defer srv.Close()

	addr := srv.TailcatAddr()

	// 2. Initialize Client
	clientKey := key.NewNode()
	cl := &tailcat.Client{
		Server:     addr,
		Key:        clientKey,
		Logf:       logger.Discard,
		DERPMapURL: derpURL,
	}
	defer cl.Close()

	// 3. Ping until ready
	var pingErr error
	for i := 0; i < 15; i++ {
		pctx, pcancel := context.WithTimeout(ctx, 4*time.Second)
		_, pingErr = cl.Ping(pctx)
		pcancel()
		if pingErr == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if pingErr != nil {
		t.Fatalf("Ping failed: %v", pingErr)
	}

	// 4. Client dials TCP port 100
	clientConn, err := cl.DialTCPPort(ctx, 100)
	if err != nil {
		t.Fatalf("DialTCPPort failed: %v", err)
	}
	defer clientConn.Close()

	select {
	case p := <-serverPort:
		if p != 100 {
			t.Fatalf("Expected incoming port 100, got %d", p)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Timeout waiting for server connection accept")
	}

	serverConn := <-serverAccepted
	defer serverConn.Close()

	// 5. Test Full-Duplex Data Transfer (64 KiB buffer)
	testPayload := make([]byte, 64<<10)
	rand.Read(testPayload)

	var wg sync.WaitGroup
	wg.Add(2)

	// Sender goroutine
	go func() {
		defer wg.Done()
		if _, err := clientConn.Write(testPayload); err != nil {
			t.Errorf("Client write failed: %v", err)
		}
		if cw, ok := clientConn.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		}
	}()

	// Receiver goroutine
	var receivedBuf bytes.Buffer
	go func() {
		defer wg.Done()
		buf := make([]byte, 8192)
		for {
			n, err := serverConn.Read(buf)
			if n > 0 {
				receivedBuf.Write(buf[:n])
			}
			if err != nil {
				if err == io.EOF {
					break
				}
				t.Errorf("Server read error: %v", err)
				break
			}
		}
	}()

	wg.Wait()

	if !bytes.Equal(receivedBuf.Bytes(), testPayload) {
		t.Fatalf("Payload mismatch: sent %d bytes, received %d bytes", len(testPayload), receivedBuf.Len())
	}
}
