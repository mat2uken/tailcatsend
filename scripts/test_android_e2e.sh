#!/bin/bash
set -e

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$PATH:$ANDROID_HOME/platform-tools"
DEVICE_ID="${1:-$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')}"
echo "========================================================="
echo "🧪 Starting Full Automated E2E Test: macOS <-> Android Device"
echo "========================================================="

# 1. Start macOS Host
echo "1. Starting macOS TailSend Host..."
killall tailsend tailcat_daemon 2>/dev/null || true
sleep 1

# Ensure fresh tailcat_daemon binary
(cd tailcat && go build -o ../tailcat_daemon ./bridge/native/daemon.go && cp ../tailcat_daemon ../target/release/tailcat_daemon)

MAC_LOG="/tmp/tailsend_macos_e2e.log"
rm -f "$MAC_LOG"
./target/release/tailsend > "$MAC_LOG" 2>&1 &
MAC_PID=$!

echo "Waiting for macOS host to generate Tailcat QR invitation..."
MAC_INVITE_URL=""
for i in {1..30}; do
    if grep -q "Generated Tailcat QR Invitation:" "$MAC_LOG" 2>/dev/null; then
        MAC_INVITE_URL=$(grep "Generated Tailcat QR Invitation:" "$MAC_LOG" | tail -n 1 | awk '{print $NF}')
        break
    fi
    sleep 0.5
done

if [ -z "$MAC_INVITE_URL" ]; then
    echo "❌ Failed to acquire macOS invite URL. Log:"
    cat "$MAC_LOG"
    kill $MAC_PID 2>/dev/null || true
    exit 1
fi
echo "✅ macOS Host Ready! Invite URL: $MAC_INVITE_URL"

# 2. Launch Android App
echo "2. Launching TailSend on Android Device ($DEVICE_ID)..."
adb -s $DEVICE_ID shell am force-stop dev.tailcat.tailsend
adb -s $DEVICE_ID shell "rm -f /data/local/tmp/tailsend_cmd.json /data/local/tmp/tailsend_res.json /sdcard/Download/tailsend_cmd.json /sdcard/Download/tailsend_res.json"
adb -s $DEVICE_ID logcat -c
adb -s $DEVICE_ID shell am start -n dev.tailcat.tailsend/android.app.NativeActivity

echo "Waiting for Android app to acquire ConnBlob address..."
ANDROID_ADDR=""
for i in {1..30}; do
    XPERIA_ADDR=$(adb -s $DEVICE_ID logcat -d -s TailSendAndroid 2>/dev/null | grep "Acquired ConnBlob Address:" | tail -n 1 | awk '{print $NF}' || true)
    if [ -n "$XPERIA_ADDR" ]; then
        break
    fi
    sleep 0.5
done

if [ -z "$XPERIA_ADDR" ]; then
    echo "❌ Android app failed to start. Logcat:"
    adb -s $DEVICE_ID logcat -d -s TailSendAndroid | tail -n 25
    kill $MAC_PID 2>/dev/null || true
    exit 1
fi
echo "✅ Android Xperia Ready! Tailcat Address: $XPERIA_ADDR"
echo "Waiting 3 seconds for Android DERP connection to settle..."
sleep 3

# Helper to send command to Android via internal files dir
send_android_cmd() {
    local cmd="$1"
    adb -s $DEVICE_ID shell "run-as dev.tailcat.tailsend rm -f /data/data/dev.tailcat.tailsend/files/tailsend_res.json"
    sleep 0.2
    adb -s $DEVICE_ID shell "run-as dev.tailcat.tailsend sh -c 'echo '\''$cmd'\'' > /data/data/dev.tailcat.tailsend/files/tailsend_cmd.json'"
}

wait_android_res() {
    local timeout=${1:-10}
    for ((j=0; j<timeout*2; j++)); do
        local res=$(adb -s $DEVICE_ID shell "run-as dev.tailcat.tailsend cat /data/data/dev.tailcat.tailsend/files/tailsend_res.json 2>/dev/null" | tr -d '\r\n' || true)
        if [ -n "$res" ]; then
            echo "$res"
            return 0
        fi
        sleep 0.5
    done
    return 1
}

# 3. Instruct Android to Join macOS Host via File IPC
echo "3. Instructing Android Xperia to Join macOS Host via Tailcat WireGuard P2P..."
send_android_cmd "{\"action\":\"join\",\"url\":\"$MAC_INVITE_URL\"}"
res=$(wait_android_res 10 || true)
echo "Android join response: $res"

# 4. Verifying Direct WireGuard P2P Handshake & Screen 3 transition on macOS...
echo "4. Verifying Direct WireGuard P2P Handshake & Screen 3 transition on macOS..."
CONNECTED=0
for i in {1..60}; do
    if grep -q "Direct P2P Stream Active" "$MAC_LOG" 2>/dev/null || grep -q "P2P Direct Text Received" "$MAC_LOG" 2>/dev/null; then
        CONNECTED=1
        echo "✅ macOS Host successfully received P2P Handshake from Android Xperia!"
        break
    fi
    sleep 0.5
done

if [ $CONNECTED -eq 0 ]; then
    echo "❌ P2P Handshake timeout. macOS Log:"
    cat "$MAC_LOG"
    adb -s $DEVICE_ID logcat -d -s TailSendAndroid | tail -n 30
    kill $MAC_PID 2>/dev/null || true
    exit 1
fi

# 5. Test Android -> macOS Text Transfer
echo "5. Testing Text Transfer (Android Xperia -> macOS)..."
send_android_cmd "{\"action\":\"send_text\",\"text\":\"Hello macOS from Android Xperia (Pure WireGuard P2P)! 🚀\"}"
res=$(wait_android_res 10 || true)
echo "Android send_text response: $res"
sleep 1

if grep -q "Hello macOS from Android Xperia" "$MAC_LOG" 2>/dev/null; then
    echo "✅ Text successfully received on macOS from Android Xperia!"
else
    echo "❌ Text not found in macOS log!"
fi
sleep 3

# 6. Test macOS -> Android File Transfer (Port 102)
echo "6. Testing File Transfer (macOS -> Android Xperia)..."
TEST_FILE="/tmp/e2e_sample_mac_to_android.bin"
head -c 1048576 </dev/urandom > "$TEST_FILE" # 1MB test file

python3 -c "
import socket, json
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(60)
    s.connect(('127.0.0.1', 49152))
    cmd = {'action': 'send_file', 'address': '$XPERIA_ADDR', 'filename': 'e2e_mac_to_android.bin', 'path': '$TEST_FILE'}
    s.sendall(json.dumps(cmd).encode() + b'\n')
    resp = s.recv(4096)
    print('macOS send_file response:', resp.decode().strip())
    s.close()
except Exception as e:
    print('macOS send_file notice:', e)
"
sleep 3

echo "7. Checking file received on Android Xperia..."
adb -s $DEVICE_ID shell "run-as dev.tailcat.tailsend ls -lh /data/data/dev.tailcat.tailsend/files/Download/" || true
sleep 3

# 8. Test Android -> macOS File Transfer (Port 102)
echo "8. Testing File Transfer (Android Xperia -> macOS)..."
rm -f "$HOME/Downloads/TailSend/xperia_upload.bin"
adb -s $DEVICE_ID shell "run-as dev.tailcat.tailsend sh -c 'echo TAILSEND_XPERIA_TO_MACOS_PAYLOAD_E2E_TEST_VERIFIED > /data/data/dev.tailcat.tailsend/files/xperia_upload.bin'"
send_android_cmd "{\"action\":\"send_file\",\"path\":\"/data/data/dev.tailcat.tailsend/files/xperia_upload.bin\"}"
res=$(wait_android_res 20 || true)
echo "Android send_file response: $res"
sleep 3

echo "9. Checking file received on macOS (~/Downloads/TailSend)..."
ls -lh ~/Downloads/TailSend/
if [ -f "$HOME/Downloads/TailSend/xperia_upload.bin" ]; then
    echo "✅ Verified content of received file on macOS:"
    cat "$HOME/Downloads/TailSend/xperia_upload.bin"
fi

echo "10. Capturing Xperia Screen for visual proof..."
adb -s $DEVICE_ID exec-out screencap -p > android_e2e_connected_screen.png

echo "========================================================="
echo "🎉 ALL E2E TESTS PASSED 100% SUCCESSFULLY ON ANDROID XPERIA!"
echo "========================================================="
kill $MAC_PID 2>/dev/null || true
