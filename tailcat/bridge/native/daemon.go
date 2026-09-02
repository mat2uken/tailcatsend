package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

type DaemonMessage struct {
	Event    string `json:"event"`
	Address  string `json:"address,omitempty"`
	Port     uint16 `json:"port,omitempty"`
	Handle   uint64 `json:"handle,omitempty"`
	Text     string `json:"text,omitempty"`
	Filename string `json:"filename,omitempty"`
	Size     int64  `json:"size,omitempty"`
	Path     string `json:"path,omitempty"`
	Error    string `json:"error,omitempty"`
}

type CommandMessage struct {
	Action  string `json:"action"`
	Address string `json:"address,omitempty"`
	Port    uint16 `json:"port,omitempty"`
	Handle  uint64 `json:"handle,omitempty"`
	Text    string `json:"text,omitempty"`
}

var (
	derpMapURL = flag.String("derp", "https://tailcat.dev/derpmap.json", "DERP map URL")
	ipcPort    = flag.Int("ipc-port", 49152, "Local IPC Port for Rust bridge")
	verbose    = flag.Bool("v", false, "Verbose logging")
)

type Daemon struct {
	mu         sync.Mutex
	server     *tailcat.Server
	address    string
	streams    map[uint64]net.Conn
	nextHandle uint64
	ipcClients map[net.Conn]bool
}

func main() {
	flag.Parse()

	logf := logger.Discard
	if *verbose {
		logf = func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "[tailcat-daemon] "+format+"\n", args...)
		}
	}

	d := &Daemon{
		streams:    make(map[uint64]net.Conn),
		nextHandle: 1,
		ipcClients: make(map[net.Conn]bool),
	}

	// 1. Initialize Ephemeral Key & Expand Server
	pk := tailcat.NewPrivateKey()
	pk.Public.RegionID = -1

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	ci := pk.Public
	if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(*derpMapURL)); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: Server Expand failed: %v\n", err)
		os.Exit(1)
	}

	reg := ci.Region[0]
	pk.Public.RegionID = reg.RegionID
	blob := pk.Public.ConnBlob()
	d.address = string(blob)

	srv := &tailcat.Server{
		Key:    pk.Private,
		Logf:   logf,
		Region: reg,
	}

	srv.OnTCP = func(port uint16) func(net.Conn) {
		return func(c net.Conn) {
			d.mu.Lock()
			handle := d.nextHandle
			d.nextHandle++
			d.streams[handle] = c
			d.mu.Unlock()

			d.broadcast(DaemonMessage{
				Event:  "incoming_stream",
				Port:   port,
				Handle: handle,
			})

			// Handle Port 101 (Text message) and Port 102 (File transfer)
			if port == 101 {
				go func(conn net.Conn, h uint64) {
					defer conn.Close()
					buf := make([]byte, 65536)
					n, err := conn.Read(buf)
					if n > 0 {
						msgText := strings.TrimSpace(string(buf[:n]))
						d.broadcast(DaemonMessage{
							Event:  "incoming_text",
							Port:   101,
							Handle: h,
							Text:   msgText,
						})
					}
					if err != nil && err != io.EOF {
						fmt.Fprintf(os.Stderr, "[tailcat-daemon] port 101 read error: %v\n", err)
					}
				}(c, handle)
			} else if port == 102 {
				go func(conn net.Conn, h uint64) {
					defer conn.Close()
					userHome, _ := os.UserHomeDir()
					outDir := filepath.Join(userHome, "Downloads", "TailSend")
					_ = os.MkdirAll(outDir, 0755)

					reader := bufio.NewReader(conn)
					header, err := reader.ReadString('\n')
					filename := fmt.Sprintf("received_%d.bin", time.Now().Unix())
					var hasPrefix bool
					if err == nil && strings.HasPrefix(header, "NAME:") {
						hasPrefix = true
						filename = strings.TrimSpace(strings.TrimPrefix(header, "NAME:"))
					}

					outPath := filepath.Join(outDir, filename)
					outFile, err := os.Create(outPath)
					if err == nil {
						var totalBytes int64
						if hasPrefix {
							n, _ := io.Copy(outFile, reader)
							totalBytes = n
						} else {
							outFile.Write([]byte(header))
							n, _ := io.Copy(outFile, reader)
							totalBytes = int64(len(header)) + n
						}
						outFile.Close()

						d.broadcast(DaemonMessage{
							Event:    "incoming_file",
							Port:     102,
							Handle:   h,
							Filename: filename,
							Size:     totalBytes,
							Path:     outPath,
						})
					}
				}(c, handle)
			}
		}
	}

	if err := srv.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: Server Start failed: %v\n", err)
		os.Exit(1)
	}
	d.server = srv
	defer srv.Close()

	// 2. Output ready message to stdout for parent process
	readyMsg, _ := json.Marshal(DaemonMessage{
		Event:   "ready",
		Address: d.address,
	})
	fmt.Println(string(readyMsg))
	os.Stdout.Sync()

	// 3. Start Local IPC Listener for Rust
	ipcListener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *ipcPort))
	if err != nil {
		fmt.Fprintf(os.Stderr, "WARN: IPC Listen on port %d failed: %v\n", *ipcPort, err)
	} else {
		defer ipcListener.Close()
		go d.acceptIPC(ipcListener)
	}

	// 4. Wait for shutdown signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh
	fmt.Fprintf(os.Stderr, "[tailcat-daemon] Shutting down...\n")
}

func (d *Daemon) broadcast(msg DaemonMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	// Print to stdout for direct parent reader
	fmt.Println(string(data))
	os.Stdout.Sync()

	// Send to IPC clients
	data = append(data, '\n')
	d.mu.Lock()
	defer d.mu.Unlock()
	for client := range d.ipcClients {
		client.Write(data)
	}
}

func (d *Daemon) acceptIPC(l net.Listener) {
	for {
		conn, err := l.Accept()
		if err != nil {
			return
		}
		d.mu.Lock()
		d.ipcClients[conn] = true
		d.mu.Unlock()

		go d.handleIPCClient(conn)
	}
}

func (d *Daemon) handleIPCClient(conn net.Conn) {
	defer func() {
		d.mu.Lock()
		delete(d.ipcClients, conn)
		d.mu.Unlock()
		conn.Close()
	}()

	dec := json.NewDecoder(conn)
	for {
		var cmd CommandMessage
		if err := dec.Decode(&cmd); err != nil {
			return
		}

		switch cmd.Action {
		case "get_address":
			res, _ := json.Marshal(DaemonMessage{
				Event:   "address",
				Address: d.address,
			})
			conn.Write(append(res, '\n'))

		case "dial":
			go d.handleDial(conn, cmd)
		}
	}
}

func (d *Daemon) handleDial(ipcConn net.Conn, cmd CommandMessage) {
	priv := key.NewNode()
	cl := &tailcat.Client{
		Server:     tailcat.ConnBlob(cmd.Address),
		Key:        priv,
		Logf:       logger.Discard,
		DERPMapURL: *derpMapURL,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	for {
		pctx, pcancel := context.WithTimeout(ctx, 4*time.Second)
		_, err := cl.Ping(pctx)
		pcancel()
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			cl.Close()
			res, _ := json.Marshal(DaemonMessage{
				Event: "error",
				Error: "Ping timeout to remote peer",
			})
			ipcConn.Write(append(res, '\n'))
			return
		}
		time.Sleep(300 * time.Millisecond)
	}

	c, err := cl.DialTCPPort(ctx, cmd.Port)
	if err != nil {
		cl.Close()
		res, _ := json.Marshal(DaemonMessage{
			Event: "error",
			Error: err.Error(),
		})
		ipcConn.Write(append(res, '\n'))
		return
	}

	d.mu.Lock()
	handle := d.nextHandle
	d.nextHandle++
	d.streams[handle] = c
	d.mu.Unlock()

	res, _ := json.Marshal(DaemonMessage{
		Event:  "dial_success",
		Port:   cmd.Port,
		Handle: handle,
	})
	ipcConn.Write(append(res, '\n'))
}
