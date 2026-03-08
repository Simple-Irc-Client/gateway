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
    local response http_code body_file
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
    response=$(cat "$body_file")
    rm -f "$body_file"
    if [ "$http_code" -ge 400 ]; then
        echo "ERROR: Hetzner API $method $endpoint returned HTTP $http_code:" >&2
        echo "$response" >&2
        exit 1
    fi
    echo "$response"
}

echo "Fetching GitHub Actions IP ranges..."
GITHUB_META=$(curl -sf --max-time 30 "$GITHUB_META_URL") || {
    echo "ERROR: Failed to fetch GitHub Actions IP ranges" >&2
    exit 1
}

# Aggregate overlapping/adjacent CIDRs using Python's ipaddress module to reduce
# the number of entries. Hetzner limits: 100 source_ips per rule, 50 effective rules.
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

print(f'IPv4: {len(v4)} -> {len(v4_agg)}, IPv6: {len(v6)} -> {len(v6_agg)}', file=sys.stderr)

for net in v4_agg + v6_agg:
    print(net)
" > "$CIDRS_FILE" || exit 1

CIDR_COUNT=$(wc -l < "$CIDRS_FILE")
echo "Aggregated to $CIDR_COUNT CIDRs"

MAX_SOURCE_IPS=100

# Build the entire rules JSON in a single jq invocation
build_rules() {
    jq -Rn --argjson max "$MAX_SOURCE_IPS" '
        # Read all CIDRs from the file
        [inputs | select(length > 0)] as $all_ips |

        # Static rules
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
                "protocol": "tcp",
                "port": "22",
                "source_ips": ["45.142.162.33/32"],
                "description": "Admin SSH"
            },
            {
                "direction": "in",
                "protocol": "icmp",
                "source_ips": ["0.0.0.0/0", "::/0"],
                "description": "ICMP"
            }
        ] +

        # Split GitHub Actions CIDRs into chunks of $max
        [
            range(0; ($all_ips | length); $max) as $i |
            {
                "direction": "in",
                "protocol": "tcp",
                "port": "22",
                "source_ips": $all_ips[$i:$i + $max],
                "description": "GitHub Actions SSH \($i / $max + 1 | floor)"
            }
        ]
    ' "$CIDRS_FILE"
}

echo "Building firewall rules..."
RULES_FILE=$(mktemp)
trap 'rm -f "$CIDRS_FILE" "$RULES_FILE"' EXIT
build_rules > "$RULES_FILE"

RULE_COUNT=$(jq length "$RULES_FILE")
echo "Built $RULE_COUNT rules"

# Find or create firewall
echo "Looking up firewall '$HCLOUD_FIREWALL'..."
FIREWALLS=$(hcloud_api GET "/firewalls?name=$HCLOUD_FIREWALL")
FIREWALL_ID=$(echo "$FIREWALLS" | jq -r '.firewalls[0].id // empty')

if [ -z "$FIREWALL_ID" ]; then
    echo "Firewall not found, creating..."
    BODY_FILE=$(mktemp)
    jq -n --arg name "$HCLOUD_FIREWALL" --slurpfile rules "$RULES_FILE" \
        '{name: $name, rules: $rules[0]}' > "$BODY_FILE"
    CREATE_RESP=$(hcloud_api POST "/firewalls" -d @"$BODY_FILE")
    rm -f "$BODY_FILE"
    FIREWALL_ID=$(echo "$CREATE_RESP" | jq -r '.firewall.id')
    echo "Created firewall ID: $FIREWALL_ID"
else
    echo "Found firewall ID: $FIREWALL_ID, updating rules..."
    BODY_FILE=$(mktemp)
    jq -n --slurpfile rules "$RULES_FILE" '{rules: $rules[0]}' > "$BODY_FILE"
    hcloud_api POST "/firewalls/$FIREWALL_ID/actions/set_rules" -d @"$BODY_FILE" >/dev/null
    rm -f "$BODY_FILE"
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

echo "Firewall updated successfully with $RULE_COUNT rules ($CIDR_COUNT aggregated CIDRs)"
