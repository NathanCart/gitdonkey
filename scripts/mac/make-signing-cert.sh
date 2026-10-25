#!/bin/bash
# Make GitDonkey's self-signed code-signing certificate, once, outside the repo.
#
# Every Mac release is signed with it (see after-sign.js), so macOS sees each
# update as the same app and "Always Allow" on the keychain prompt sticks.
# It doesn't replace an Apple Developer ID: Gatekeeper still asks on first open.
#
# Keep ~/.gitdonkey-signing backed up. Lose it and users get one more keychain
# prompt with the first release signed by a new one.
set -euo pipefail
DIR="${GITDONKEY_SIGNING_DIR:-$HOME/.gitdonkey-signing}"
NAME="GitDonkey Self-Signed"
if [ -f "$DIR/gitdonkey-signing.p12" ]; then
  echo "Already there: $DIR/gitdonkey-signing.p12"
  exit 0
fi
mkdir -p "$DIR"
chmod 700 "$DIR"
cd "$DIR"
umask 077
cat > openssl.cnf <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
O = GitDonkey
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF
openssl rand -hex 24 > password
openssl req -x509 -newkey rsa:3072 -sha256 -days 7300 -nodes -keyout key.pem -out certificate.pem -config openssl.cnf 2>/dev/null
# LibreSSL's default PKCS#12 ciphers are the ones macOS's security tool reads.
openssl pkcs12 -export -inkey key.pem -in certificate.pem -name "$NAME" -out gitdonkey-signing.p12 -passout file:password
rm -f key.pem openssl.cnf
chmod 600 gitdonkey-signing.p12 password certificate.pem
echo "Made $DIR/gitdonkey-signing.p12"
openssl x509 -in certificate.pem -noout -subject -enddate -fingerprint -sha256
