#!/bin/sh
# Creates a local code-signing certificate, "Kurz Local Signing", in your login keychain, once.
#
# Why: macOS remembers permissions such as Full Disk Access per code signature. An ad-hoc signature
# changes with every build, so each new build looks like a new app and loses them. Signed with this
# certificate, every build keeps the same identity and keeps its permissions.
#
# What it changes: adds a certificate and its private key to your login keychain and trusts it for
# code signing only. macOS asks for your password to allow that. Remove it any time in Keychain
# Access (search "Kurz Local Signing").
set -eu

NAME="Kurz Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
# The system LibreSSL writes a PKCS#12 file that macOS's security tool can import.
OPENSSL=/usr/bin/openssl

if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
    echo "\"$NAME\" is already set up."
    exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cert.cnf" <<CNF
[ req ]
distinguished_name = dn
x509_extensions = ext
prompt = no
[ dn ]
CN = $NAME
[ ext ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF

echo "Creating the certificate…"
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$TMP/cert.cnf" \
    -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
"$OPENSSL" pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" \
    -out "$TMP/identity.p12" -passout pass:kurz

echo "Adding it to your login keychain (codesign may use the key)…"
security import "$TMP/identity.p12" -k "$KEYCHAIN" -P kurz -T /usr/bin/codesign

echo "Trusting it for code signing. macOS will ask for your password…"
security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"

if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
    echo "Done. scripts/install.sh now signs Kurz with \"$NAME\"."
    echo "Run it once more and turn on Full Disk Access for Kurz one last time; later builds keep it."
else
    echo "The certificate was added but isn't usable for signing yet; see Keychain Access."
    exit 1
fi
