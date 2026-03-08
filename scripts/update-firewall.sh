#!/usr/bin/env bash
set -euo pipefail

# Update Hetzner Cloud Firewall with GitHub Actions SSH rules + static rules.
# Intended to run as a cronjob to keep the GitHub Actions IP allow-list current.
#
# Required environment:
#   HCLOUD_TOKEN       - Hetzner Cloud API token
#   HCLOUD_FIREWALL    - Firewall name (created if missing)
#   HCLOUD_SERVER      - Server name to apply firewall to
#
# Rules applied:
#   - Allow any to port 113/tcp (identd)
#   - Allow any to port 443/tcp (HTTPS)
#   - Allow 45.142.162.33 to port 22/tcp (admin SSH)
#   - Allow all ICMP
#   - Allow GitHub Actions IPs to port 22/tcp

HCLOUD_API="https://api.hetzner.cloud/v1"
GITHUB_META_URL="https://api.github.com/meta"

: "${HCLOUD_TOKEN:?HCLOUD_TOKEN is required}"
: "${HCLOUD_FIREWALL:?HCLOUD_FIREWALL is required}"
: "${HCLOUD_SERVER:?HCLOUD_SERVER is required}"

hcloud_api() {
    local method="$1" endpoint="$2"
    shift 2
    local response
    response=$(curl -sf --max-time 30 \
        -X "$method" \
        -H "Authorization: Bearer $HCLOUD_TOKEN" \
        -H "Content-Type: application/json" \
        "${HCLOUD_API}${endpoint}" \
        "$@") || {
        echo "ERROR: Hetzner API request failed: $method $endpoint" >&2
        exit 1
    }
    echo "$response"
}

echo "Fetching GitHub Actions IP ranges..."
GITHUB_META=$(curl -sf --max-time 30 "$GITHUB_META_URL") || {
    echo "ERROR: Failed to fetch GitHub Actions IP ranges" >&2
    exit 1
}

CIDRS_V4=$(echo "$GITHUB_META" | jq -r '.actions[] | select(contains(":") | not)')
CIDRS_V6=$(echo "$GITHUB_META" | jq -r '.actions[] | select(contains(":"))')
V4_COUNT=$(echo "$CIDRS_V4" | wc -l)
V6_COUNT=$(echo "$CIDRS_V6" | wc -l)

if [ -z "$CIDRS_V4" ]; then
    echo "ERROR: Got empty GitHub Actions IPv4 ranges" >&2
    exit 1
fi

echo "Got $V4_COUNT IPv4 and $V6_COUNT IPv6 CIDRs"

# Build the rules JSON array
build_rules() {
    local rules="[]"

    # Allow any → port 113 (identd)
    rules=$(echo "$rules" | jq '. + [{
        "direction": "in",
        "protocol": "tcp",
        "port": "113",
        "source_ips": ["0.0.0.0/0", "::/0"],
        "description": "identd"
    }]')

    # Allow any → port 443 (HTTPS)
    rules=$(echo "$rules" | jq '. + [{
        "direction": "in",
        "protocol": "tcp",
        "port": "443",
        "source_ips": ["0.0.0.0/0", "::/0"],
        "description": "HTTPS"
    }]')

    # Allow admin SSH
    rules=$(echo "$rules" | jq '. + [{
        "direction": "in",
        "protocol": "tcp",
        "port": "22",
        "source_ips": ["45.142.162.33/32"],
        "description": "Admin SSH"
    }]')

    # Allow ICMP
    rules=$(echo "$rules" | jq '. + [{
        "direction": "in",
        "protocol": "icmp",
        "source_ips": ["0.0.0.0/0", "::/0"],
        "description": "ICMP"
    }]')

    # GitHub Actions SSH — build source_ips array from all CIDRs
    local gh_source_ips="[]"
    while IFS= read -r cidr; do
        gh_source_ips=$(echo "$gh_source_ips" | jq --arg c "$cidr" '. + [$c]')
    done <<< "$CIDRS_V4"
    while IFS= read -r cidr; do
        gh_source_ips=$(echo "$gh_source_ips" | jq --arg c "$cidr" '. + [$c]')
    done <<< "$CIDRS_V6"

    rules=$(echo "$rules" | jq --argjson ips "$gh_source_ips" '. + [{
        "direction": "in",
        "protocol": "tcp",
        "port": "22",
        "source_ips": $ips,
        "description": "GitHub Actions SSH"
    }]')

    echo "$rules"
}

echo "Building firewall rules..."
RULES=$(build_rules)

# Find or create firewall
echo "Looking up firewall '$HCLOUD_FIREWALL'..."
FIREWALLS=$(hcloud_api GET "/firewalls?name=$HCLOUD_FIREWALL")
FIREWALL_ID=$(echo "$FIREWALLS" | jq -r '.firewalls[0].id // empty')

if [ -z "$FIREWALL_ID" ]; then
    echo "Firewall not found, creating..."
    CREATE_RESP=$(hcloud_api POST "/firewalls" \
        -d "$(jq -n --arg name "$HCLOUD_FIREWALL" --argjson rules "$RULES" \
            '{name: $name, rules: $rules}')")
    FIREWALL_ID=$(echo "$CREATE_RESP" | jq -r '.firewall.id')
    echo "Created firewall ID: $FIREWALL_ID"
else
    echo "Found firewall ID: $FIREWALL_ID, updating rules..."
    hcloud_api POST "/firewalls/$FIREWALL_ID/actions/set_rules" \
        -d "$(jq -n --argjson rules "$RULES" '{rules: $rules}')" >/dev/null
    echo "Rules updated"
fi

# Apply firewall to server
echo "Looking up server '$HCLOUD_SERVER'..."
SERVERS=$(hcloud_api GET "/servers?name=$HCLOUD_SERVER")
SERVER_ID=$(echo "$SERVERS" | jq -r '.servers[0].id // empty')

if [ -z "$SERVER_ID" ]; then
    echo "ERROR: Server '$HCLOUD_SERVER' not found" >&2
    exit 1
fi

# Check if already applied
APPLIED=$(hcloud_api GET "/firewalls/$FIREWALL_ID")
ALREADY_APPLIED=$(echo "$APPLIED" | jq --arg sid "$SERVER_ID" \
    '.firewall.applied_to[]? | select(.server.id == ($sid | tonumber))' 2>/dev/null)

if [ -z "$ALREADY_APPLIED" ]; then
    echo "Applying firewall to server $SERVER_ID..."
    hcloud_api POST "/firewalls/$FIREWALL_ID/actions/apply_to_resources" \
        -d "$(jq -n --arg sid "$SERVER_ID" \
            '{apply_to: [{type: "server", server: {id: ($sid | tonumber)}}]}')" >/dev/null
    echo "Firewall applied to server"
else
    echo "Firewall already applied to server"
fi

RULE_COUNT=$(echo "$RULES" | jq length)
echo "Firewall updated successfully with $RULE_COUNT rules ($V4_COUNT + $V6_COUNT GitHub Actions CIDRs)"
