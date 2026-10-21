#!/usr/bin/env bash
# Package the webgl-spoof extension as a CRX and force-install it via Chrome policy.
# Branded Chrome 155 ignores --load-extension; ExtensionInstallForcelist from a local
# update server is the supported path and lands in every profile (agents + manual-login).
set -eu
EXT=/opt/job-agent-runner/webgl-spoof/v1
DIST=/opt/job-agent-runner/webgl-spoof/dist
PORT=8931

mkdir -p "$DIST"
# Pack as the agent user (branded Chrome refuses to run as root). First pack
# generates v1.pem; keep it so the extension id stays stable across repacks.
chown -R agent:agent /opt/job-agent-runner/webgl-spoof
if [ ! -f "$DIST/webgl-spoof.crx" ]; then
  if [ ! -f /opt/job-agent-runner/webgl-spoof/v1.crx ]; then
    # headless=new + scratch profile: reliable under su, no X display needed.
    # Reuse v1.pem when present so the extension id (and the policy) stays stable.
    KEY_ARG=""
    [ -f /opt/job-agent-runner/webgl-spoof/v1.pem ] && KEY_ARG="--pack-extension-key=/opt/job-agent-runner/webgl-spoof/v1.pem"
    su agent -c "HOME=/home/agent google-chrome --pack-extension=$EXT $KEY_ARG --no-sandbox --disable-gpu --headless=new --user-data-dir=/tmp/pack-profile 2>/dev/null"
  fi
  mv -f /opt/job-agent-runner/webgl-spoof/v1.crx "$DIST/webgl-spoof.crx"
fi

# Extension id = a-p encoding of SHA-256(public key DER)[:16]. The public key is
# embedded in the CRX3 header (protobuf field 2 → field 1), so parse the package.
ID=$(python3 - "$DIST/webgl-spoof.crx" <<'PY'
import hashlib, struct, sys
data = open(sys.argv[1], "rb").read()
assert data[:4] == b"Cr24", "not a CRX"
hlen = struct.unpack("<I", data[8:12])[0]
header = data[12:12 + hlen]

def fields(buf, want_tag):
    out, i = [], 0
    while i < len(buf):
        tag = buf[i]; i += 1
        ln, shift = 0, 0
        while True:
            b = buf[i]; i += 1
            ln |= (b & 0x7F) << shift; shift += 7
            if not b & 0x80: break
        val = buf[i:i + ln]; i += ln
        if tag == want_tag: out.append(val)
    return out

pub = None
for proof in fields(header, 0x12):          # repeated Sha256WithRsaProof sha256_with_rsa256 = 2
    for pk in fields(proof, 0x0A):          # bytes public_key = 1
        pub = pk
        break
    if pub: break
assert pub, "no public key in CRX header"
h = hashlib.sha256(pub).digest()[:16]
print("".join(chr(97 + (b >> 4)) + chr(97 + (b & 15)) for b in h))
PY
)
echo "extension id: $ID"

cat > "$DIST/update.xml" <<EOF
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$ID'>
    <updatecheck codebase='http://127.0.0.1:$PORT/webgl-spoof.crx' version='1.0' />
  </app>
</gupdate>
EOF

mkdir -p /etc/opt/chrome/policies/managed
cat > /etc/opt/chrome/policies/managed/webgl-spoof.json <<EOF
{ "ExtensionInstallForcelist": [ "$ID;http://127.0.0.1:$PORT/update.xml" ] }
EOF

cat > /etc/systemd/system/webgl-spoof-dist.service <<EOF
[Unit]
Description=Local update server for the webgl-spoof Chrome extension
After=network.target

[Service]
ExecStart=/usr/bin/python3 -m http.server $PORT --bind 127.0.0.1 --directory $DIST
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now webgl-spoof-dist
sleep 1
curl -sf -o /dev/null -w "update.xml: %{http_code}\n" "http://127.0.0.1:$PORT/update.xml"
curl -sf -o /dev/null -w "crx: %{http_code}\n" "http://127.0.0.1:$PORT/webgl-spoof.crx"
echo "policy: $(cat /etc/opt/chrome/policies/managed/webgl-spoof.json)"
