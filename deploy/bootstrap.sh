#!/usr/bin/env bash
set -euo pipefail

# One-time server bootstrap for the Simple IRC Client Gateway.
#
# Run ONCE as root on the production server. Idempotent — safe to re-run.
# It provisions a non-privileged `deploy` user with scoped sudo so the GitHub
# Actions deploy workflow never has to log in as root.
#
# Usage (from a repo checkout on the server, or after scp-ing the deploy/ dir):
#   sudo DEPLOY_PUBKEY="ssh-ed25519 AAAA... deploy@ci" bash deploy/bootstrap.sh
#
# DEPLOY_PUBKEY  - the PUBLIC half of the SSH key whose private half is stored
#                  in the GitHub Actions `SSH_KEY` secret. Required on first run
#                  (skip by exporting nothing only if the key is already installed).

DEPLOY_USER="deploy"
DEPLOY_HOME="/home/${DEPLOY_USER}"
APP_DIR="/opt/sic-gateway"
SUDOERS_FILE="/etc/sudoers.d/sic-deploy"

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: bootstrap.sh must be run as root" >&2
    exit 1
fi

# --- packages ---
echo "Installing packages (podman, caddy)..."
if ! command -v podman >/dev/null 2>&1; then
    apt-get update
    apt-get install -y podman
fi
if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
        | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install -y caddy
fi

# --- deploy user ---
echo "Ensuring '${DEPLOY_USER}' user exists..."
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi

if [ -n "${DEPLOY_PUBKEY:-}" ]; then
    echo "Installing deploy SSH public key..."
    install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "${DEPLOY_HOME}/.ssh"
    AUTH_KEYS="${DEPLOY_HOME}/.ssh/authorized_keys"
    touch "$AUTH_KEYS"
    if ! grep -qxF "$DEPLOY_PUBKEY" "$AUTH_KEYS"; then
        printf '%s\n' "$DEPLOY_PUBKEY" >> "$AUTH_KEYS"
    fi
    chmod 600 "$AUTH_KEYS"
    chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH_KEYS"
elif [ ! -s "${DEPLOY_HOME}/.ssh/authorized_keys" ]; then
    echo "WARNING: DEPLOY_PUBKEY not set and no authorized_keys present." >&2
    echo "         Deploy logins will fail until a key is installed." >&2
fi

# --- app dir (deploy-owned: firewall script + .env live here, no sudo needed) ---
echo "Ensuring ${APP_DIR} exists (owned by ${DEPLOY_USER})..."
install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"

# --- scoped sudo ---
echo "Writing scoped sudoers to ${SUDOERS_FILE}..."
TMP_SUDOERS=$(mktemp)
cat > "$TMP_SUDOERS" << EOF
# Scoped privileges for the gateway deploy pipeline. Managed by deploy/bootstrap.sh.
${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl, /usr/bin/journalctl, \\
    /usr/bin/podman, /usr/sbin/nft, /usr/bin/apt-get, /usr/bin/tee, \\
    ${APP_DIR}/update-firewall.sh
EOF
# Validate before installing so a typo can never lock sudo.
visudo -cf "$TMP_SUDOERS"
install -m 440 -o root -g root "$TMP_SUDOERS" "$SUDOERS_FILE"
rm -f "$TMP_SUDOERS"

# --- optional SSH hardening ---
# Keep root reachable only via key (break-glass / future bootstrap runs), never password.
# The Hetzner firewall already restricts SSH to admin IPs.
DROPIN="/etc/ssh/sshd_config.d/10-sic-harden.conf"
if [ ! -f "$DROPIN" ]; then
    echo "Hardening SSH (PermitRootLogin prohibit-password)..."
    printf 'PermitRootLogin prohibit-password\n' > "$DROPIN"
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
fi

echo
echo "Bootstrap complete. Verify with:  sudo -u ${DEPLOY_USER} sudo -l"
