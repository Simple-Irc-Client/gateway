#!/usr/bin/env bash
set -euo pipefail

# Hybrid firewall setup:
#   1. Hetzner Cloud Firewall — static rules (identd, HTTPS, ICMP) + admin SSH IPs
#      (managed via Hetzner Dashboard, source of truth for SSH admin IPs)
#   2. nftables on host — SSH access for admin IPs (read from Hetzner) + GitHub Actions CIDRs
#
# The cronjob runs this script periodically to:
#   - Read SSH admin IPs from the Hetzner Cloud Firewall rules
#   - Fetch and aggregate GitHub Actions CIDRs
#   - Update nftables to allow SSH from both sets of IPs
#
# Required environment:
#   HCLOUD_TOKEN       - Hetzner Cloud API token
#   HCLOUD_FIREWALL    - Firewall name
#
# To add/change admin SSH IPs: edit the "Admin SSH" rule in Hetzner Cloud Dashboard.
# The next cron run will pick up the change and update nftables.

HCLOUD_API="https://api.hetzner.cloud/v1"
GITHUB_META_URL="https://api.github.com/meta"
NFT_TABLE="inet sic-firewall"
NFT_SET_V4="ssh-allow-v4"
NFT_SET_V6="ssh-allow-v6"

: "${HCLOUD_TOKEN:?HCLOUD_TOKEN is required}"
: "${HCLOUD_FIREWALL:?HCLOUD_FIREWALL is required}"

# --- Hetzner Cloud Firewall: set static rules ---

hcloud_api() {
    local method="$1" endpoint="$2"
    shift 2
    local http_code body_file
    body_file=$(mktemp)
    http_code=$(curl -s --max-time 30 -o "$body_file" -w '%{http_code}' \
        -X "$method" \
        -H "Authorization: Bearer $HCLOUD_TOKEN" \
        -H "Content-Type: application/json" \
        "${HCLOUD_API}${endpoint}" \
        "$@") || {
        echo "ERROR: Hetzner API request failed: $method $endpoint (curl error)" >&2
        rm -f "$body_file"
        exit 1
    }
    local response
    response=$(cat "$body_file")
    rm -f "$body_file"
    if [ "$http_code" -ge 400 ]; then
        echo "ERROR: Hetzner API $method $endpoint returned HTTP $http_code:" >&2
        echo "$response" >&2
        exit 1
    fi
    echo "$response"
}

echo "Looking up Hetzner firewall '$HCLOUD_FIREWALL'..."
FIREWALLS=$(hcloud_api GET "/firewalls?name=$HCLOUD_FIREWALL")
FIREWALL_ID=$(echo "$FIREWALLS" | jq -r '.firewalls[0].id // empty')
EXISTING_RULES=$(echo "$FIREWALLS" | jq '.firewalls[0].rules // []')

if [ -z "$FIREWALL_ID" ]; then
    echo "ERROR: Firewall '$HCLOUD_FIREWALL' not found. Create it in the Hetzner Dashboard first." >&2
    exit 1
fi
echo "Found firewall ID: $FIREWALL_ID"

# Read admin SSH IPs from the Hetzner firewall (any rule with port 22),
# filtering out wildcard entries (0.0.0.0/0, ::/0) since the whole point
# is to restrict SSH access to specific IPs only.
ADMIN_SSH_IPS=$(echo "$EXISTING_RULES" | jq -r '
    [.[] | select(.direction == "in" and .port == "22") | .source_ips[]
     | select(. != "0.0.0.0/0" and . != "::/0")]
    | unique | .[]
')

if [ -z "$ADMIN_SSH_IPS" ]; then
    echo "WARNING: No admin SSH IPs found in Hetzner firewall. Add an SSH rule in the Dashboard." >&2
fi

ADMIN_COUNT=$(echo "$ADMIN_SSH_IPS" | grep -c . || true)
echo "Read $ADMIN_COUNT admin SSH IPs from Hetzner firewall"

# Ensure static rules exist (identd, HTTPS, ICMP) — preserve any existing SSH rules
STATIC_RULES=$(echo "$EXISTING_RULES" | jq '
    # Keep existing SSH rules as-is (admin manages these via Dashboard)
    [.[] | select(.port == "22")] as $ssh_rules |
    [
        {
            "direction": "in",
            "protocol": "tcp",
            "port": "113",
            "source_ips": ["0.0.0.0/0", "::/0"],
            "description": "identd"
        },
        {
            "direction": "in",
            "protocol": "tcp",
            "port": "443",
            "source_ips": ["0.0.0.0/0", "::/0"],
            "description": "HTTPS"
        },
        {
            "direction": "in",
            "protocol": "icmp",
            "source_ips": ["0.0.0.0/0", "::/0"],
            "description": "ICMP"
        }
    ] + $ssh_rules
')

# Check if rules need updating (avoid unnecessary API calls)
NEEDS_UPDATE=$(jq -n --argjson existing "$EXISTING_RULES" --argjson target "$STATIC_RULES" '
    ($existing | sort_by(.description)) != ($target | sort_by(.description))
')

if [ "$NEEDS_UPDATE" = "true" ]; then
    echo "Updating Hetzner Cloud Firewall static rules..."
    BODY_FILE=$(mktemp)
    jq -n --argjson rules "$STATIC_RULES" '{rules: $rules}' > "$BODY_FILE"
    hcloud_api POST "/firewalls/$FIREWALL_ID/actions/set_rules" -d @"$BODY_FILE" >/dev/null
    rm -f "$BODY_FILE"
    echo "Hetzner firewall rules updated"
else
    echo "Hetzner firewall rules already up to date"
fi

# --- nftables: SSH access for admin IPs + GitHub Actions CIDRs ---

echo "Fetching GitHub Actions IP ranges..."
GITHUB_META=$(curl -sf --max-time 30 "$GITHUB_META_URL") || {
    echo "ERROR: Failed to fetch GitHub Actions IP ranges" >&2
    exit 1
}

# Aggregate CIDRs to minimize nftables set size
CIDRS_FILE=$(mktemp)
trap 'rm -f "$CIDRS_FILE"' EXIT

echo "$GITHUB_META" | python3 -c "
import sys, json, ipaddress

data = json.load(sys.stdin)
cidrs = data.get('actions', [])
if not cidrs:
    print('ERROR: No GitHub Actions CIDRs found', file=sys.stderr)
    sys.exit(1)

v4 = sorted(set(ipaddress.ip_network(c) for c in cidrs if ':' not in c))
v6 = sorted(set(ipaddress.ip_network(c) for c in cidrs if ':' in c))

v4_agg = list(ipaddress.collapse_addresses(v4))
v6_agg = list(ipaddress.collapse_addresses(v6))

print(f'GitHub Actions: {len(v4)} -> {len(v4_agg)} IPv4, {len(v6)} -> {len(v6_agg)} IPv6', file=sys.stderr)

for net in v4_agg:
    print(f'v4 {net}')
for net in v6_agg:
    print(f'v6 {net}')
" > "$CIDRS_FILE" || exit 1

GH_V4=$(grep '^v4 ' "$CIDRS_FILE" | cut -d' ' -f2)
GH_V6=$(grep '^v6 ' "$CIDRS_FILE" | cut -d' ' -f2)

# Combine admin IPs + GitHub Actions CIDRs
ALL_V4=""
ALL_V6=""

# Add admin SSH IPs from Hetzner
while IFS= read -r ip; do
    [ -z "$ip" ] && continue
    if [[ "$ip" == *":"* ]]; then
        ALL_V6="${ALL_V6}${ALL_V6:+, }${ip}"
    else
        ALL_V4="${ALL_V4}${ALL_V4:+, }${ip}"
    fi
done <<< "$ADMIN_SSH_IPS"

# Add GitHub Actions CIDRs
while IFS= read -r cidr; do
    [ -z "$cidr" ] && continue
    ALL_V4="${ALL_V4}${ALL_V4:+, }${cidr}"
done <<< "$GH_V4"

while IFS= read -r cidr; do
    [ -z "$cidr" ] && continue
    ALL_V6="${ALL_V6}${ALL_V6:+, }${cidr}"
done <<< "$GH_V6"

V4_COUNT=$(echo "$ALL_V4" | tr ',' '\n' | grep -c . || true)
V6_COUNT=$(echo "$ALL_V6" | tr ',' '\n' | grep -c . || true)
echo "Total SSH allow list: $V4_COUNT IPv4, $V6_COUNT IPv6 entries"

# Write nftables rules atomically
NFT_RULES_FILE=$(mktemp)
trap 'rm -f "$CIDRS_FILE" "$NFT_RULES_FILE"' EXIT

if nft list table $NFT_TABLE >/dev/null 2>&1; then
    echo "delete table $NFT_TABLE" > "$NFT_RULES_FILE"
else
    : > "$NFT_RULES_FILE"
fi

cat >> "$NFT_RULES_FILE" << EOF
table $NFT_TABLE {
    set $NFT_SET_V4 {
        type ipv4_addr
        flags interval
        elements = { $ALL_V4 }
    }

    set $NFT_SET_V6 {
        type ipv6_addr
        flags interval
        elements = { $ALL_V6 }
    }

    chain input {
        type filter hook input priority filter; policy accept;
        tcp dport 22 ip saddr @$NFT_SET_V4 accept
        tcp dport 22 ip6 saddr @$NFT_SET_V6 accept
        tcp dport 22 reject with icmp port-unreachable
    }
}
EOF

echo "Applying nftables rules..."
nft -f "$NFT_RULES_FILE" || {
    echo "ERROR: Failed to apply nftables rules" >&2
    cat "$NFT_RULES_FILE" >&2
    exit 1
}

echo "Firewall updated successfully: $V4_COUNT IPv4 + $V6_COUNT IPv6 SSH entries"
