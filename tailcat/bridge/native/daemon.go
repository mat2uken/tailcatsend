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
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

type DaemonMessage struct {
	Event    string  `json:"event"`
	Address  string  `json:"address,omitempty"`
	Port     uint16  `json:"port,omitempty"`
	Handle   uint64  `json:"handle,omitempty"`
	Text     string  `json:"text,omitempty"`
	Filename string  `json:"filename,omitempty"`
	Size     int64   `json:"size,omitempty"`
	Bytes    int64   `json:"bytes,omitempty"`
	Progress float64 `json:"progress,omitempty"`
	Speed    string  `json:"speed,omitempty"`
	Path     string  `json:"path,omitempty"`
	Error    string  `json:"error,omitempty"`
}

type CommandMessage struct {
	Action   string `json:"action"`
	Address  string `json:"address,omitempty"`
	Port     uint16 `json:"port,omitempty"`
	Handle   uint64 `json:"handle,omitempty"`
	Text     string `json:"text,omitempty"`
	Filename string `json:"filename,omitempty"`
	Path     string `json:"path,omitempty"`
}

var (
	derpMapURL = flag.String("derp", "https://tailcat.dev/derpmap.json", "DERP map URL")
	ipcPort    = flag.Int("ipc-port", 49152, "Local IPC Port for Rust bridge")
	verbose    = flag.Bool("v", false, "Verbose logging")
)

var daemonLogf logger.Logf = logger.Discard

type daemonDERPCache struct{}

func (daemonDERPCache) Get(url string) ([]byte, string, time.Time, bool) {
	return []byte(staticDERPMapJSON), "", time.Now(), true
}

func (daemonDERPCache) Put(url string, data []byte, etag string) error {
	return nil
}

const staticDERPMapJSON = `{"Regions":{"301":{"RegionID":301,"RegionCode":"nyc","RegionName":"New York City","Latitude":40.7128,"Longitude":-74.006,"Nodes":[{"Name":"301a","RegionID":301,"HostName":"tc301a.ipn.dev","IPv4":"199.38.181.166","IPv6":"2607:f740:f::26b","CanPort80":true}]},"302":{"RegionID":302,"RegionCode":"sfo","RegionName":"San Francisco","Latitude":37.7775,"Longitude":-122.416389,"Nodes":[{"Name":"302a","RegionID":302,"HostName":"tc302a.ipn.dev","IPv4":"208.111.39.38","IPv6":"2607:f740:0:3f::720","CanPort80":true}]},"303":{"RegionID":303,"RegionCode":"fra","RegionName":"Frankfurt","Latitude":50.1109,"Longitude":8.6821,"Nodes":[{"Name":"303a","RegionID":303,"HostName":"tc303a.ipn.dev","IPv4":"185.178.202.197","IPv6":"2a00:dd80:20::207","CanPort80":true}]},"304":{"RegionID":304,"RegionCode":"tok","RegionName":"Tokyo","Latitude":35.6764,"Longitude":139.65,"Nodes":[{"Name":"304a","RegionID":304,"HostName":"tc304a.ipn.dev","IPv4":"172.238.7.124","IPv6":"2600:3c18::2000:31ff:fe29:e8e8","CanPort80":true}]}}}`

type Daemon struct {
	mu         sync.Mutex
	server     *tailcat.Server
	address    string
	streams    map[uint64]net.Conn
	clients    map[string]*tailcat.Client
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
		daemonLogf = logf
	}

	d := &Daemon{
		streams:    make(map[uint64]net.Conn),
		nextHandle: 1,
		ipcClients: make(map[net.Conn]bool),
	}

	// 1. Initialize Ephemeral Key & Expand Server
	pk := tailcat.NewPrivateKey()
	pk.Public.RegionID = 304

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	ci := pk.Public
	if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(*derpMapURL)); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: Server Expand failed: %v\n", err)
		os.Exit(1)
	}

	reg := ci.Region[0]
	pk.Public.Region = []*tailcfg.DERPRegion{reg}
	pk.Public.RegionID = reg.RegionID
	if pk.Public.PresharedKey.IsZero() {
		pk.Public.PresharedKey = tailcat.NewPresharedKey()
	}

	srv := &tailcat.Server{
		Key:          pk.Private,
		PresharedKey: pk.Public.PresharedKey,
		Logf:         logf,
		Region:       reg,
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
					outDir := filepath.Join(userHome, "Downloads", "tailcatSend")
					_ = os.MkdirAll(outDir, 0755)

					reader := bufio.NewReader(conn)
					header, err := reader.ReadString('\n')
					filename := fmt.Sprintf("received_%d.bin", time.Now().Unix())
					var expectedSize int64 = 0

					if err == nil && strings.HasPrefix(header, "NAME:") {
						meta := strings.TrimSpace(strings.TrimPrefix(header, "NAME:"))
						if parts := strings.Split(meta, ":"); len(parts) == 2 {
							filename = parts[0]
							fmt.Sscanf(parts[1], "%d", &expectedSize)
						} else {
							filename = meta
						}
					}

					d.broadcast(DaemonMessage{
						Event:    "incoming_file_start",
						Port:     102,
						Handle:   h,
						Filename: filename,
						Size:     expectedSize,
					})

					outPath := filepath.Join(outDir, filename)
					outFile, err := os.Create(outPath)
					if err == nil {
						defer outFile.Close()
						buf := make([]byte, 64*1024)
						var totalBytes int64
						startTime := time.Now()
						lastProgress := time.Now()

						for {
							n, rErr := reader.Read(buf)
							if n > 0 {
								_, wErr := outFile.Write(buf[:n])
								if wErr != nil {
									break
								}
								totalBytes += int64(n)

								// Broadcast progress every 100ms
								if time.Since(lastProgress) >= 100*time.Millisecond {
									lastProgress = time.Now()
									var progress float64
									if expectedSize > 0 {
										progress = float64(totalBytes) / float64(expectedSize)
									}
									elapsed := time.Since(startTime).Seconds()
									speed := ""
									if elapsed > 0 {
										speed = fmt.Sprintf("%.1f MB/s", (float64(totalBytes)/1048576.0)/elapsed)
									}

									d.broadcast(DaemonMessage{
										Event:    "incoming_file_progress",
										Port:     102,
										Handle:   h,
										Filename: filename,
										Bytes:    totalBytes,
										Size:     expectedSize,
										Progress: progress,
										Speed:    speed,
									})
								}
							}
							if rErr != nil {
								break
							}
						}

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
	d.address = string(srv.TailcatAddr())
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

		case "send_text":
			go d.handleSendText(conn, cmd)

		case "send_file":
			go d.handleSendFile(conn, cmd)
		}
	}
}

func (d *Daemon) getOrCreateClient(addr string) *tailcat.Client {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.clients == nil {
		d.clients = make(map[string]*tailcat.Client)
	}
	if cl, ok := d.clients[addr]; ok {
		return cl
	}
	priv := key.NewNode()
	cl := &tailcat.Client{
		Server:       tailcat.Addr(addr),
		Key:          priv,
		Logf:         daemonLogf,
		DERPMapURL:   *derpMapURL,
		DERPMapCache: daemonDERPCache{},
	}
	d.clients[addr] = cl
	return cl
}

func (d *Daemon) handleSendText(ipcConn net.Conn, cmd CommandMessage) {
	cl := d.getOrCreateClient(cmd.Address)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	conn, err := cl.DialTCPPort(ctx, 101)
	if err != nil {
		res, _ := json.Marshal(DaemonMessage{Event: "error", Error: err.Error()})
		ipcConn.Write(append(res, '\n'))
		return
	}
	defer conn.Close()

	_, _ = conn.Write([]byte(cmd.Text))
	res, _ := json.Marshal(DaemonMessage{Event: "send_text_success", Text: cmd.Text})
	ipcConn.Write(append(res, '\n'))
}

func (d *Daemon) handleSendFile(ipcConn net.Conn, cmd CommandMessage) {
	fileData, err := os.ReadFile(cmd.Path)
	if err != nil {
		res, _ := json.Marshal(DaemonMessage{Event: "error", Error: err.Error()})
		ipcConn.Write(append(res, '\n'))
		return
	}

	cl := d.getOrCreateClient(cmd.Address)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	conn, err := cl.DialTCPPort(ctx, 102)
	if err != nil {
		res, _ := json.Marshal(DaemonMessage{Event: "error", Error: err.Error()})
		ipcConn.Write(append(res, '\n'))
		return
	}
	defer conn.Close()

	header := fmt.Sprintf("NAME:%s:%d\n", cmd.Filename, len(fileData))
	_, _ = conn.Write([]byte(header))
	_, _ = conn.Write(fileData)

	res, _ := json.Marshal(DaemonMessage{
		Event:    "send_file_success",
		Filename: cmd.Filename,
		Size:     int64(len(fileData)),
	})
	ipcConn.Write(append(res, '\n'))
}

func (d *Daemon) handleDial(ipcConn net.Conn, cmd CommandMessage) {
	priv := key.NewNode()
	cl := &tailcat.Client{
		Server:       tailcat.Addr(cmd.Address),
		Key:          priv,
		Logf:         daemonLogf,
		DERPMapURL:   *derpMapURL,
		DERPMapCache: daemonDERPCache{},
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
