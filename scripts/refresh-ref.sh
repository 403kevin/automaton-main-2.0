#!/usr/bin/env bash
# Download the read-only reference catalogs into ref/. Run this at deploy time.
# The committed copies are what agents see until the next refresh.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/ref"
mkdir -p "$dest"

public_apis="https://raw.githubusercontent.com/public-apis/public-apis/master/README.md"
datasets="https://raw.githubusercontent.com/awesomedata/awesome-public-datasets/master/README.rst"
fetched="$(date -u +%Y-%m-%d)"

curl -fsSL "$public_apis" -o "$dest/public-apis.md"
curl -fsSL "$datasets" -o "$dest/datasets.rst"

cat > "$dest/SOURCES.md" << EOF
# Reference sources

Fetched ${fetched} (UTC).

- public-apis.md: ${public_apis}
- datasets.rst: ${datasets}

Agent containers mount this directory read-only at /ref.
EOF
