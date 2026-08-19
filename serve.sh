#!/bin/sh
# Serve the app over HTTPS on the LAN (camera access requires HTTPS on phones).
cd "$(dirname "$0")"
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1)
if [ ! -f .certs/cert.pem ]; then
  mkdir -p .certs
  openssl req -x509 -newkey rsa:2048 -nodes -keyout .certs/key.pem -out .certs/cert.pem -days 365 \
    -subj "/CN=$IP" -addext "subjectAltName=IP:$IP,DNS:localhost" 2>/dev/null
fi
echo "Open on your phone:  https://$IP:8443/   (accept the self-signed cert warning)"
python3 -m http.server 8443 --tls-cert .certs/cert.pem --tls-key .certs/key.pem
