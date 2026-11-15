export function buildInstallCommand(
  origin: string,
  nodeId: string,
  token: string,
): string {
  const url = new URL(origin);
  const wsProto = url.protocol === "http:" ? "ws:" : "wss:";
  const wsOrigin = `${wsProto}//${url.host}`;
  return `curl -fsSL ${url.origin}/install.sh | sudo bash -s -- --url ${wsOrigin} --id ${nodeId} --token ${token}`;
}

function normalizeInstallDefaults(
  githubRepo?: string,
  defaultOrigin?: string,
): { safeRepo: string; safeOrigin: string } {
  const safeRepo =
    githubRepo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo.trim())
      ? githubRepo.trim()
      : "Cusnd/UniOB";
  const safeOrigin = (() => {
    if (!defaultOrigin) {
      return "";
    }
    try {
      return new URL(defaultOrigin).origin;
    } catch {
      return "";
    }
  })();
  return { safeRepo, safeOrigin };
}

function bashCommonHelpers(logTag: string): string {
  return `log() {
  echo "[${logTag}] $*"
}

warn() {
  echo "[${logTag}] WARN: $*" >&2
}

die() {
  echo "[${logTag}] ERROR: $*" >&2
  exit 1
}

require_arg() {
  local opt="$1"
  local argc="$2"
  if [[ "\${argc}" -lt 2 ]]; then
    die "Missing value for \${opt}"
  fi
}

toml_escape() {
  local val="$1"
  if [[ "\${val}" == *$'\\n'* || "\${val}" == *$'\\r'* ]]; then
    die "Configuration values must not contain newline characters"
  fi
  val="\${val//\\\\/\\\\\\\\}"
  val="\${val//\\"/\\\\\\"}"
  printf '%s' "\${val}"
}

is_valid_elf() {
  local magic
  magic="$(LC_ALL=C head -c 4 "$1" 2>/dev/null | tr -d '\\000')"
  [[ "\${magic}" == $'\\x7fELF' ]]
}

fetch_sha256sums() {
  local base_url="$1"
  local sums_file="$2"
  if command -v sha256sum >/dev/null 2>&1 && curl -fsSL --retry 2 --connect-timeout 10 -o "\${sums_file}" "\${base_url}/SHA256SUMS" 2>/dev/null; then
    return 0
  fi
  return 1
}

verify_sha256_if_available() {
  local file_path="$1"
  local asset_name="$2"
  local sums_file="$3"
  if [[ -z "\${sums_file}" || ! -f "\${sums_file}" ]] || ! command -v sha256sum >/dev/null 2>&1; then
    return 0
  fi
  local expected_hash actual_hash
  expected_hash="$(awk -v name="\${asset_name}" '$2 == name || $2 == ("*" name) { print $1; exit }' "\${sums_file}")"
  if [[ -n "\${expected_hash}" ]]; then
    actual_hash="$(sha256sum "\${file_path}" | awk '{ print $1 }')"
    if [[ "\${expected_hash}" != "\${actual_hash}" ]]; then
      die "SHA256 verification failed for \${asset_name} (expected \${expected_hash}, got \${actual_hash})"
    fi
    log "SHA256 verified for \${asset_name}."
  fi
}`;
}

export function renderInstallScript(githubRepo?: string, defaultOrigin?: string): string {
  const { safeRepo, safeOrigin } = normalizeInstallDefaults(githubRepo, defaultOrigin);

  return `#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO="${safeRepo}"
DEFAULT_ORIGIN="${safeOrigin}"
BINARY_PATH="/usr/local/bin/uniob-agent"
BACKUP_BINARY_PATH="/usr/local/bin/uniob-agent.prev"
APPLY_HELPER_PATH="/usr/local/sbin/uniob-agent-apply-update"
CONFIG_DIR="/etc/uniob"
CONFIG_PATH="\${CONFIG_DIR}/agent.toml"
STATE_DIR="/var/lib/uniob"
UPDATE_DIR="\${STATE_DIR}/update"
SERVICE_NAME="uniob-agent"
SERVICE_PATH="/etc/systemd/system/\${SERVICE_NAME}.service"
UPDATE_PATH_NAME="uniob-agent-update.path"
UPDATE_SERVICE_NAME="uniob-agent-update.service"
UPDATE_PATH_UNIT="/etc/systemd/system/\${UPDATE_PATH_NAME}"
UPDATE_SERVICE_UNIT="/etc/systemd/system/\${UPDATE_SERVICE_NAME}"

URL=""
NODE_ID=""
TOKEN=""
CMDLINE_MODE="sanitized"
CMDLINE_EXPLICIT="false"
PROC_ENABLED="true"
DISABLE_PROC_EXPLICIT="false"
REPO="\${DEFAULT_REPO}"
REPO_EXPLICIT="false"
VERSION="latest"
BIN_URL=""
UNINSTALL="false"

usage() {
  cat <<'EOF'
UniOB Agent Installer (Linux systemd)

Usage:
  install.sh --url <wss_or_https_url> --id <node_id> --token <agent_token> [options]
  install.sh                         # Upgrade binary while preserving existing /etc/uniob/agent.toml
  install.sh --uninstall

Options:
  --url <url>          Worker base or WebSocket URL (https:// or wss://)
  --id <node_id>       Node ID from UniOB dashboard
  --token <token>      Agent bearer token (uob_live_...)
  --cmdline <mode>     sanitized (default) | comm_only | full
  --disable-proc       Disable process inspection ([process] enabled = false)
  --repo <owner/repo>  GitHub release repository (default: ${safeRepo})
  --version <tag>      Release tag or "latest" (default: latest)
  --bin-url <url>      Explicit binary download URL
  --uninstall          Stop service and remove uniob-agent files
  -h, --help           Show this help message
EOF
}

${bashCommonHelpers("uniob-install")}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      require_arg "$1" "$#"
      URL="$2"
      shift 2
      ;;
    --url=*)
      URL="\${1#*=}"
      shift
      ;;
    --id)
      require_arg "$1" "$#"
      NODE_ID="$2"
      shift 2
      ;;
    --id=*)
      NODE_ID="\${1#*=}"
      shift
      ;;
    --token)
      require_arg "$1" "$#"
      TOKEN="$2"
      shift 2
      ;;
    --token=*)
      TOKEN="\${1#*=}"
      shift
      ;;
    --cmdline)
      require_arg "$1" "$#"
      CMDLINE_MODE="$2"
      CMDLINE_EXPLICIT="true"
      shift 2
      ;;
    --cmdline=*)
      CMDLINE_MODE="\${1#*=}"
      CMDLINE_EXPLICIT="true"
      shift
      ;;
    --disable-proc)
      PROC_ENABLED="false"
      DISABLE_PROC_EXPLICIT="true"
      shift
      ;;
    --repo)
      require_arg "$1" "$#"
      REPO="$2"
      REPO_EXPLICIT="true"
      shift 2
      ;;
    --repo=*)
      REPO="\${1#*=}"
      REPO_EXPLICIT="true"
      shift
      ;;
    --version)
      require_arg "$1" "$#"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="\${1#*=}"
      shift
      ;;
    --bin-url)
      require_arg "$1" "$#"
      BIN_URL="$2"
      shift 2
      ;;
    --bin-url=*)
      BIN_URL="\${1#*=}"
      shift
      ;;
    --uninstall)
      UNINSTALL="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || die "Please run as root (e.g. via sudo)"
[[ "$(uname -s)" == "Linux" ]] || die "uniob-agent systemd installer supports Linux only"
command -v systemctl >/dev/null 2>&1 || die "systemctl is required"

if [[ "\${UNINSTALL}" == "true" ]]; then
  log "Uninstalling \${SERVICE_NAME}..."
  systemctl disable --now "\${UPDATE_PATH_NAME}" >/dev/null 2>&1 || true
  systemctl stop "\${UPDATE_SERVICE_NAME}" >/dev/null 2>&1 || true
  systemctl disable --now "\${SERVICE_NAME}" >/dev/null 2>&1 || true
  rm -f "\${UPDATE_PATH_UNIT}" "\${UPDATE_SERVICE_UNIT}" "\${SERVICE_PATH}" "\${APPLY_HELPER_PATH}" "\${BINARY_PATH}" "\${BACKUP_BINARY_PATH}"
  rm -rf "\${CONFIG_DIR}" "\${STATE_DIR}"
  systemctl daemon-reload
  systemctl reset-failed "\${SERVICE_NAME}" "\${UPDATE_SERVICE_NAME}" "\${UPDATE_PATH_NAME}" 2>/dev/null || true
  log "uniob-agent removed."
  exit 0
fi

case "\${CMDLINE_MODE}" in
  sanitized|comm_only|full) ;;
  *) die "Invalid --cmdline mode: \${CMDLINE_MODE} (expected sanitized, comm_only, or full)" ;;
esac

if [[ -z "\${BIN_URL}" && ! "\${REPO}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  die "Invalid --repo '\${REPO}': expected <owner>/<repo>"
fi

WRITE_CONFIG="false"
if [[ -n "\${URL}" || -n "\${NODE_ID}" || -n "\${TOKEN}" ]]; then
  [[ -n "\${URL}" ]] || die "--url is required"
  [[ -n "\${NODE_ID}" ]] || die "--id is required"
  [[ -n "\${TOKEN}" ]] || die "--token is required"
  WRITE_CONFIG="true"
else
  if [[ ! -f "\${CONFIG_PATH}" || "\${CMDLINE_EXPLICIT}" == "true" || "\${DISABLE_PROC_EXPLICIT}" == "true" ]]; then
    die "Missing required options: --url, --id, and --token are required for installation"
  fi
fi

normalize_ws_url() {
  local raw="$1"
  case "\${raw}" in
    https://*)
      raw="wss://\${raw#https://}"
      ;;
    http://*)
      raw="ws://\${raw#http://}"
      ;;
    wss://*|ws://*)
      ;;
    *)
      die "Invalid --url '\${raw}': must start with wss://, ws://, https://, or http://"
      ;;
  esac
  raw="\${raw%/}"
  if [[ "\${raw}" != */api/agent/ws ]]; then
    raw="\${raw}/api/agent/ws"
  fi
  printf '%s' "\${raw}"
}

WS_URL=""
if [[ "\${WRITE_CONFIG}" == "true" ]]; then
  WS_URL="$(normalize_ws_url "\${URL}")"
fi

ARCH_RAW="$(uname -m)"
case "\${ARCH_RAW}" in
  x86_64|amd64)
    TARGET_TRIPLE="x86_64-unknown-linux-musl"
    ;;
  aarch64|arm64)
    TARGET_TRIPLE="aarch64-unknown-linux-musl"
    ;;
  *)
    die "Unsupported CPU architecture: \${ARCH_RAW}"
    ;;
esac

derive_http_origin() {
  local raw="$1"
  local proto=""
  local rest=""
  if [[ "\${raw}" == wss://* ]]; then
    proto="https://"
    rest="\${raw#wss://}"
  elif [[ "\${raw}" == ws://* ]]; then
    proto="http://"
    rest="\${raw#ws://}"
  elif [[ "\${raw}" == https://* ]]; then
    proto="https://"
    rest="\${raw#https://}"
  elif [[ "\${raw}" == http://* ]]; then
    proto="http://"
    rest="\${raw#http://}"
  else
    printf '%s' "\${DEFAULT_ORIGIN}"
    return
  fi
  rest="\${rest%%/*}"
  if [[ -n "\${rest}" ]]; then
    printf '%s%s' "\${proto}" "\${rest}"
  else
    printf '%s' "\${DEFAULT_ORIGIN}"
  fi
}

HTTP_ORIGIN="\${DEFAULT_ORIGIN}"
if [[ -n "\${URL}" ]]; then
  HTTP_ORIGIN="$(derive_http_origin "\${URL}")"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"

TMP_DIR="$(mktemp -d)"
TMP_BIN="\${TMP_DIR}/uniob-agent"
TMP_SUMS="\${TMP_DIR}/SHA256SUMS"
trap 'rm -rf "\${TMP_DIR}"' EXIT

if [[ -n "\${BIN_URL}" ]]; then
  log "Downloading \${BIN_URL}..."
  curl -fsSL --retry 3 --connect-timeout 15 "\${BIN_URL}" -o "\${TMP_BIN}"
  [[ -s "\${TMP_BIN}" ]] && is_valid_elf "\${TMP_BIN}" || die "Downloaded file is not a valid Linux ELF binary: \${BIN_URL}"
else
  BIN_NAME="uniob-agent-\${TARGET_TRIPLE}"
  if [[ "\${VERSION}" == "latest" ]]; then
    GH_BASE_URL="https://github.com/\${REPO}/releases/latest/download"
  else
    GH_BASE_URL="https://github.com/\${REPO}/releases/download/\${VERSION}"
  fi
  GH_BIN_URL="\${GH_BASE_URL}/\${BIN_NAME}"

  DOWNLOADED="false"
  VERIFY_BASE=""
  if [[ "\${REPO_EXPLICIT}" == "false" && "\${VERSION}" == "latest" && -n "\${HTTP_ORIGIN}" ]]; then
    SELF_BIN_URL="\${HTTP_ORIGIN}/releases/\${BIN_NAME}"
    log "Downloading \${SELF_BIN_URL}..."
    if curl -fsSL --retry 2 --connect-timeout 10 "\${SELF_BIN_URL}" -o "\${TMP_BIN}" 2>/dev/null && [[ -s "\${TMP_BIN}" ]] && is_valid_elf "\${TMP_BIN}"; then
      DOWNLOADED="true"
      VERIFY_BASE="\${HTTP_ORIGIN}/releases"
    else
      warn "Self-hosted binary unavailable, falling back to GitHub Releases..."
    fi
  fi

  if [[ "\${DOWNLOADED}" != "true" ]]; then
    log "Downloading \${GH_BIN_URL}..."
    curl -fsSL --retry 3 --connect-timeout 15 "\${GH_BIN_URL}" -o "\${TMP_BIN}"
    [[ -s "\${TMP_BIN}" ]] && is_valid_elf "\${TMP_BIN}" || die "Downloaded file is not a valid Linux ELF binary: \${GH_BIN_URL}"
    VERIFY_BASE="\${GH_BASE_URL}"
  fi

  if fetch_sha256sums "\${VERIFY_BASE}" "\${TMP_SUMS}"; then
    verify_sha256_if_available "\${TMP_BIN}" "\${BIN_NAME}" "\${TMP_SUMS}"
  fi
fi

SERVICE_GROUP="$(id -gn nobody 2>/dev/null || echo nogroup)"

if [[ "\${WRITE_CONFIG}" == "true" ]]; then
  ESC_URL="$(toml_escape "\${WS_URL}")"
  ESC_NODE_ID="$(toml_escape "\${NODE_ID}")"
  ESC_TOKEN="$(toml_escape "\${TOKEN}")"
  ESC_CMDLINE="$(toml_escape "\${CMDLINE_MODE}")"

  mkdir -p "\${CONFIG_DIR}"
  chmod 0750 "\${CONFIG_DIR}"
  chown root:"\${SERVICE_GROUP}" "\${CONFIG_DIR}"

  TMP_CFG="$(umask 077 && mktemp "\${CONFIG_DIR}/.agent.toml.XXXXXX")"
  cat > "\${TMP_CFG}" <<EOF
[server]
url = "\${ESC_URL}"
node_id = "\${ESC_NODE_ID}"
token = "\${ESC_TOKEN}"

[collector]
nic_allowlist = []
mount_ignore_prefixes = ["/snap", "/boot/efi", "/run"]

[process]
enabled = \${PROC_ENABLED}
cmdline_mode = "\${ESC_CMDLINE}"
EOF
  chown root:"\${SERVICE_GROUP}" "\${TMP_CFG}"
  chmod 0640 "\${TMP_CFG}"
  mv -f "\${TMP_CFG}" "\${CONFIG_PATH}"
else
  log "Existing \${CONFIG_PATH} preserved; upgrading binary and systemd unit only."
fi

TMP_BIN_STAGE="$(mktemp "$(dirname "\${BINARY_PATH}")/.uniob-agent.new.XXXXXX")"
cp "\${TMP_BIN}" "\${TMP_BIN_STAGE}"
chmod 0755 "\${TMP_BIN_STAGE}"
mv -f "\${TMP_BIN_STAGE}" "\${BINARY_PATH}"

TMP_UNIT="\${TMP_DIR}/uniob-agent.service"
cat > "\${TMP_UNIT}" <<EOF
[Unit]
Description=UniOB Lightweight Monitoring Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nobody
Group=\${SERVICE_GROUP}
StateDirectory=uniob
StateDirectoryMode=0750
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
MemoryMax=24M
Restart=always
RestartSec=3
ExecStart=\${BINARY_PATH} --config \${CONFIG_PATH}

[Install]
WantedBy=multi-user.target
EOF

chmod 0644 "\${TMP_UNIT}"
mv -f "\${TMP_UNIT}" "\${SERVICE_PATH}"

mkdir -p "$(dirname "\${APPLY_HELPER_PATH}")"
TMP_HELPER="\${TMP_DIR}/uniob-agent-apply-update"
cat > "\${TMP_HELPER}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

BINARY_PATH="/usr/local/bin/uniob-agent"
BACKUP_PATH="/usr/local/bin/uniob-agent.prev"
CONFIG_PATH="/etc/uniob/agent.toml"
READY_JSON="/var/lib/uniob/update/ready.json"
STAGED_BIN="/var/lib/uniob/update/uniob-agent.bin"
SERVICE_NAME="uniob-agent"

if [[ ! -f "\${READY_JSON}" || ! -f "\${STAGED_BIN}" ]]; then
  exit 0
fi

if ! "\${BINARY_PATH}" --config "\${CONFIG_PATH}" --verify-staged-update; then
  rm -f "\${READY_JSON}" "\${STAGED_BIN}"
  exit 1
fi

TMP_NEW="$(mktemp /usr/local/bin/.uniob-agent.new.XXXXXX)"
cleanup() {
  rm -f "\${TMP_NEW}"
}
trap cleanup EXIT

cp -f "\${STAGED_BIN}" "\${TMP_NEW}"
chmod 0755 "\${TMP_NEW}"

if [[ -f "\${BINARY_PATH}" ]]; then
  cp -f "\${BINARY_PATH}" "\${BACKUP_PATH}"
  chmod 0755 "\${BACKUP_PATH}"
fi

mv -f "\${TMP_NEW}" "\${BINARY_PATH}"
trap - EXIT
rm -f "\${READY_JSON}" "\${STAGED_BIN}"

systemctl restart "\${SERVICE_NAME}"
sleep 2

if ! systemctl is-active --quiet "\${SERVICE_NAME}"; then
  if [[ -f "\${BACKUP_PATH}" ]]; then
    mv -f "\${BACKUP_PATH}" "\${BINARY_PATH}"
    chmod 0755 "\${BINARY_PATH}"
    systemctl restart "\${SERVICE_NAME}" || true
  fi
  exit 1
fi
EOF
chmod 0755 "\${TMP_HELPER}"
mv -f "\${TMP_HELPER}" "\${APPLY_HELPER_PATH}"

TMP_UPD_PATH="\${TMP_DIR}/\${UPDATE_PATH_NAME}"
cat > "\${TMP_UPD_PATH}" <<EOF
[Unit]
Description=Watch UniOB agent staged auto-update marker

[Path]
PathChanged=/var/lib/uniob/update/ready.json

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "\${TMP_UPD_PATH}"
mv -f "\${TMP_UPD_PATH}" "\${UPDATE_PATH_UNIT}"

TMP_UPD_SVC="\${TMP_DIR}/\${UPDATE_SERVICE_NAME}"
cat > "\${TMP_UPD_SVC}" <<EOF
[Unit]
Description=Apply UniOB agent staged auto-update
After=\${SERVICE_NAME}.service

[Service]
Type=oneshot
ExecStart=\${APPLY_HELPER_PATH}
EOF
chmod 0644 "\${TMP_UPD_SVC}"
mv -f "\${TMP_UPD_SVC}" "\${UPDATE_SERVICE_UNIT}"

systemctl daemon-reload
if systemctl is-active --quiet "\${SERVICE_NAME}" 2>/dev/null; then
  systemctl enable "\${SERVICE_NAME}"
  systemctl restart "\${SERVICE_NAME}"
else
  systemctl enable --now "\${SERVICE_NAME}"
fi
systemctl enable --now "\${UPDATE_PATH_NAME}"

log "uniob-agent installed and started successfully."
`;
}

/** Render the POSIX shell installer for self-hosted \`uniob-hub\`. */
export function renderInstallHubScript(githubRepo?: string, defaultOrigin?: string): string {
  const { safeRepo, safeOrigin } = normalizeInstallDefaults(githubRepo, defaultOrigin);

  return `#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO="${safeRepo}"
DEFAULT_ORIGIN="${safeOrigin}"
BINARY_PATH="/usr/local/bin/uniob-hub"
CONFIG_DIR="/etc/uniob-hub"
CONFIG_PATH="\${CONFIG_DIR}/hub.toml"
STATE_DIR="/var/lib/uniob-hub"
DB_PATH="\${STATE_DIR}/uniob.db"
SHARE_DIR="/usr/local/share/uniob-hub"
WEB_DIR="\${SHARE_DIR}/web"
RELEASES_DIR="\${SHARE_DIR}/releases"
SERVICE_NAME="uniob-hub"
SERVICE_PATH="/etc/systemd/system/\${SERVICE_NAME}.service"

LISTEN_ADDR="127.0.0.1:8787"
LISTEN_EXPLICIT="false"
DOMAIN=""
DOMAIN_EXPLICIT="false"
WATCHDOG_URL=""
WATCHDOG_URL_EXPLICIT="false"
WATCHDOG_SECRET=""
WATCHDOG_SECRET_EXPLICIT="false"
IMPORT_BUNDLE=""
BIN_URL=""
REPO="\${DEFAULT_REPO}"
REPO_EXPLICIT="false"
VERSION="latest"
UNINSTALL="false"

usage() {
  cat <<'USAGE'
Usage: install-hub.sh [OPTIONS]

Options:
  --listen <addr>             Listen address (default: 127.0.0.1:8787)
  --domain <domain>           Public domain for HTTPS/origin URLs (optional)
  --watchdog-url <url>        Worker watchdog ping URL (optional)
  --watchdog-secret <secret>  Worker watchdog HMAC secret (optional)
  --import-bundle <path|url>  Export bundle JSON file path or URL to import (optional)
  --bin-url <url>             Direct uniob-hub binary download URL (optional)
  --repo <owner/repo>         GitHub repository (default: ${safeRepo})
  --version <tag>             Release version or 'latest' (default: latest)
  --uninstall                 Stop service and remove uniob-hub files
  -h, --help                  Show this help message
USAGE
}

${bashCommonHelpers("uniob-hub-install")}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --listen)
      require_arg "$1" "$#"
      LISTEN_ADDR="$2"
      LISTEN_EXPLICIT="true"
      shift 2
      ;;
    --listen=*)
      LISTEN_ADDR="\${1#*=}"
      LISTEN_EXPLICIT="true"
      shift
      ;;
    --domain)
      require_arg "$1" "$#"
      DOMAIN="$2"
      DOMAIN_EXPLICIT="true"
      shift 2
      ;;
    --domain=*)
      DOMAIN="\${1#*=}"
      DOMAIN_EXPLICIT="true"
      shift
      ;;
    --watchdog-url)
      require_arg "$1" "$#"
      WATCHDOG_URL="$2"
      WATCHDOG_URL_EXPLICIT="true"
      shift 2
      ;;
    --watchdog-url=*)
      WATCHDOG_URL="\${1#*=}"
      WATCHDOG_URL_EXPLICIT="true"
      shift
      ;;
    --watchdog-secret)
      require_arg "$1" "$#"
      WATCHDOG_SECRET="$2"
      WATCHDOG_SECRET_EXPLICIT="true"
      shift 2
      ;;
    --watchdog-secret=*)
      WATCHDOG_SECRET="\${1#*=}"
      WATCHDOG_SECRET_EXPLICIT="true"
      shift
      ;;
    --import-bundle)
      require_arg "$1" "$#"
      IMPORT_BUNDLE="$2"
      shift 2
      ;;
    --import-bundle=*)
      IMPORT_BUNDLE="\${1#*=}"
      shift
      ;;
    --bin-url)
      require_arg "$1" "$#"
      BIN_URL="$2"
      shift 2
      ;;
    --bin-url=*)
      BIN_URL="\${1#*=}"
      shift
      ;;
    --repo)
      require_arg "$1" "$#"
      REPO="$2"
      REPO_EXPLICIT="true"
      shift 2
      ;;
    --repo=*)
      REPO="\${1#*=}"
      REPO_EXPLICIT="true"
      shift
      ;;
    --version)
      require_arg "$1" "$#"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="\${1#*=}"
      shift
      ;;
    --uninstall)
      UNINSTALL="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || die "Please run as root (e.g. sudo bash ...)."
[[ "$(uname -s)" == "Linux" ]] || die "uniob-hub installer supports Linux only."

if [[ "\${UNINSTALL}" == "true" ]]; then
  log "Uninstalling \${SERVICE_NAME}..."
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "\${SERVICE_NAME}" >/dev/null 2>&1 || true
  fi
  rm -f "\${SERVICE_PATH}" "\${BINARY_PATH}"
  rm -rf "\${CONFIG_DIR}" "\${STATE_DIR}" "\${SHARE_DIR}"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
    systemctl reset-failed "\${SERVICE_NAME}" 2>/dev/null || true
  fi
  log "uniob-hub removed."
  exit 0
fi

for cmd in curl uname tar systemctl; do
  command -v "\${cmd}" >/dev/null 2>&1 || die "Missing required command: \${cmd}"
done

if [[ -z "\${BIN_URL}" && ! "\${REPO}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  die "Invalid --repo '\${REPO}': expected <owner>/<repo>"
fi

UNAME_ARCH="$(uname -m)"
case "\${UNAME_ARCH}" in
  x86_64|amd64)
    TARGET_TRIPLE="x86_64-unknown-linux-musl"
    ;;
  aarch64|arm64)
    TARGET_TRIPLE="aarch64-unknown-linux-musl"
    ;;
  *)
    die "Unsupported architecture: \${UNAME_ARCH}"
    ;;
esac

BIN_NAME="uniob-hub-\${TARGET_TRIPLE}"
TMP_DIR="$(mktemp -d)"
TMP_BIN="\${TMP_DIR}/\${BIN_NAME}"
TMP_WEB="\${TMP_DIR}/uniob-web-dist.tar.gz"
TMP_SUMS="\${TMP_DIR}/SHA256SUMS"
TMP_BUNDLE="\${TMP_DIR}/import-bundle.json"
trap 'rm -rf "\${TMP_DIR}"' EXIT

SELF_BASE_URL=""
SELF_BIN_URL=""
if [[ -n "\${DEFAULT_ORIGIN}" ]]; then
  SELF_BASE_URL="\${DEFAULT_ORIGIN}/releases"
  SELF_BIN_URL="\${SELF_BASE_URL}/\${BIN_NAME}"
fi

if [[ "\${VERSION}" == "latest" ]]; then
  GH_BASE_URL="https://github.com/\${REPO}/releases/latest/download"
else
  GH_BASE_URL="https://github.com/\${REPO}/releases/download/\${VERSION}"
fi
GH_BIN_URL="\${GH_BASE_URL}/\${BIN_NAME}"

VERIFY_BASE=""
if [[ -n "\${BIN_URL}" ]]; then
  log "Downloading \${BIN_NAME} from \${BIN_URL}..."
  curl -fsSL --retry 3 --connect-timeout 15 "\${BIN_URL}" -o "\${TMP_BIN}"
  [[ -s "\${TMP_BIN}" ]] && is_valid_elf "\${TMP_BIN}" || die "Downloaded file is not a valid Linux ELF binary: \${BIN_URL}"
elif [[ "\${REPO_EXPLICIT}" != "true" && "\${VERSION}" == "latest" && -n "\${SELF_BIN_URL}" ]]; then
  log "Downloading \${BIN_NAME} from \${SELF_BIN_URL}..."
  if curl -fsSL --retry 2 --connect-timeout 10 "\${SELF_BIN_URL}" -o "\${TMP_BIN}" 2>/dev/null && [[ -s "\${TMP_BIN}" ]] && is_valid_elf "\${TMP_BIN}"; then
    VERIFY_BASE="\${SELF_BASE_URL}"
  else
    warn "Self-hosted download failed, retrying \${GH_BIN_URL}..."
    curl -fsSL --retry 3 --connect-timeout 15 "\${GH_BIN_URL}" -o "\${TMP_BIN}"
    [[ -s "\${TMP_BIN}" ]] && is_valid_elf "\${TMP_BIN}" || die "Downloaded file is not a valid Linux ELF binary: \${GH_BIN_URL}"
    VERIFY_BASE="\${GH_BASE_URL}"
  fi
else
  log "Downloading \${BIN_NAME} from \${GH_BIN_URL}..."
  curl -fsSL --retry 3 --connect-timeout 15 "\${GH_BIN_URL}" -o "\${TMP_BIN}"
  [[ -s "\${TMP_BIN}" ]] && is_valid_elf "\${TMP_BIN}" || die "Downloaded file is not a valid Linux ELF binary: \${GH_BIN_URL}"
  VERIFY_BASE="\${GH_BASE_URL}"
fi

SUMS_AVAILABLE="false"
if [[ -n "\${VERIFY_BASE}" ]] && fetch_sha256sums "\${VERIFY_BASE}" "\${TMP_SUMS}"; then
  SUMS_AVAILABLE="true"
  verify_sha256_if_available "\${TMP_BIN}" "\${BIN_NAME}" "\${TMP_SUMS}"
elif [[ -z "\${VERIFY_BASE}" && "\${REPO}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] && fetch_sha256sums "\${GH_BASE_URL}" "\${TMP_SUMS}"; then
  SUMS_AVAILABLE="true"
fi

TMP_BIN_STAGE="$(mktemp "$(dirname "\${BINARY_PATH}")/.uniob-hub.new.XXXXXX")"
cp "\${TMP_BIN}" "\${TMP_BIN_STAGE}"
chmod 0755 "\${TMP_BIN_STAGE}"
mv -f "\${TMP_BIN_STAGE}" "\${BINARY_PATH}"

mkdir -p "\${SHARE_DIR}" "\${WEB_DIR}" "\${RELEASES_DIR}"
chmod 0755 "\${SHARE_DIR}" "\${WEB_DIR}" "\${RELEASES_DIR}"

ASSET_BASE="\${VERIFY_BASE:-\${GH_BASE_URL}}"
WEB_DOWNLOADED="false"
WEB_URL="\${ASSET_BASE}/uniob-web-dist.tar.gz"
log "Downloading web UI bundle from \${WEB_URL}..."
if curl -fsSL --retry 3 --connect-timeout 15 "\${WEB_URL}" -o "\${TMP_WEB}" 2>/dev/null && [[ -s "\${TMP_WEB}" ]] && tar -tzf "\${TMP_WEB}" >/dev/null 2>&1; then
  WEB_DOWNLOADED="true"
elif [[ "\${ASSET_BASE}" != "\${GH_BASE_URL}" ]] && curl -fsSL --retry 3 --connect-timeout 15 "\${GH_BASE_URL}/uniob-web-dist.tar.gz" -o "\${TMP_WEB}" 2>/dev/null && [[ -s "\${TMP_WEB}" ]] && tar -tzf "\${TMP_WEB}" >/dev/null 2>&1; then
  WEB_DOWNLOADED="true"
  if fetch_sha256sums "\${GH_BASE_URL}" "\${TMP_SUMS}"; then
    SUMS_AVAILABLE="true"
  fi
fi

if [[ "\${WEB_DOWNLOADED}" == "true" ]]; then
  if [[ "\${SUMS_AVAILABLE}" == "true" ]]; then
    verify_sha256_if_available "\${TMP_WEB}" "uniob-web-dist.tar.gz" "\${TMP_SUMS}"
  fi
  TMP_WEB_STAGE="$(mktemp -d "\${SHARE_DIR}/.web.new.XXXXXX")"
  tar -xzf "\${TMP_WEB}" -C "\${TMP_WEB_STAGE}"
  chmod -R a+rX "\${TMP_WEB_STAGE}"
  rm -rf "\${WEB_DIR}"
  mv -f "\${TMP_WEB_STAGE}" "\${WEB_DIR}"
else
  warn "Could not download valid uniob-web-dist.tar.gz; existing \${WEB_DIR} kept."
fi

for agent_arch in x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
  AGENT_ASSET="uniob-agent-\${agent_arch}"
  STAGED_AGENT="\${TMP_DIR}/\${AGENT_ASSET}"
  if curl -fsSL --retry 2 --connect-timeout 10 "\${GH_BASE_URL}/\${AGENT_ASSET}" -o "\${STAGED_AGENT}" 2>/dev/null && [[ -s "\${STAGED_AGENT}" ]] && is_valid_elf "\${STAGED_AGENT}"; then
    if fetch_sha256sums "\${GH_BASE_URL}" "\${TMP_DIR}/AGENT_SUMS" 2>/dev/null; then
      verify_sha256_if_available "\${STAGED_AGENT}" "\${AGENT_ASSET}" "\${TMP_DIR}/AGENT_SUMS"
    fi
    chmod 0755 "\${STAGED_AGENT}"
    mv -f "\${STAGED_AGENT}" "\${RELEASES_DIR}/\${AGENT_ASSET}"
  elif [[ -n "\${SELF_BASE_URL}" ]] && curl -fsSL --retry 2 --connect-timeout 10 "\${SELF_BASE_URL}/\${AGENT_ASSET}" -o "\${STAGED_AGENT}" 2>/dev/null && [[ -s "\${STAGED_AGENT}" ]] && is_valid_elf "\${STAGED_AGENT}"; then
    chmod 0755 "\${STAGED_AGENT}"
    mv -f "\${STAGED_AGENT}" "\${RELEASES_DIR}/\${AGENT_ASSET}"
  else
    warn "Optional agent binary \${AGENT_ASSET} not cached; /install.sh will fall back to GitHub Releases."
  fi
done

SERVICE_GROUP="$(id -gn nobody 2>/dev/null || echo nogroup)"

if [[ ! -f "\${CONFIG_PATH}" || "\${LISTEN_EXPLICIT}" == "true" || "\${DOMAIN_EXPLICIT}" == "true" || "\${WATCHDOG_URL_EXPLICIT}" == "true" || "\${WATCHDOG_SECRET_EXPLICIT}" == "true" ]]; then
  PUBLIC_URL=""
  if [[ -n "\${DOMAIN}" ]]; then
    if [[ "\${DOMAIN}" == http://* || "\${DOMAIN}" == https://* ]]; then
      PUBLIC_URL="\${DOMAIN%/}"
    else
      PUBLIC_URL="https://\${DOMAIN}"
    fi
  fi

  ESC_LISTEN="$(toml_escape "\${LISTEN_ADDR}")"
  ESC_DB="$(toml_escape "\${DB_PATH}")"
  ESC_WEB="$(toml_escape "\${WEB_DIR}")"
  ESC_RELEASES="$(toml_escape "\${RELEASES_DIR}")"
  ESC_PUBLIC="$(toml_escape "\${PUBLIC_URL}")"
  ESC_REPO="$(toml_escape "\${REPO}")"
  ESC_WD_URL="$(toml_escape "\${WATCHDOG_URL}")"
  ESC_WD_SECRET="$(toml_escape "\${WATCHDOG_SECRET}")"

  mkdir -p "\${CONFIG_DIR}"
  chmod 0750 "\${CONFIG_DIR}"
  chown "root:\${SERVICE_GROUP}" "\${CONFIG_DIR}"

  TMP_CFG="$(umask 077 && mktemp "\${CONFIG_DIR}/.hub.toml.XXXXXX")"
  cat > "\${TMP_CFG}" <<EOF
[server]
listen = "\${ESC_LISTEN}"
db_path = "\${ESC_DB}"
web_dir = "\${ESC_WEB}"
releases_dir = "\${ESC_RELEASES}"
public_url = "\${ESC_PUBLIC}"
github_repo = "\${ESC_REPO}"

[auth]
mode = "builtin"

[self_probe]
enabled = true

[watchdog]
url = "\${ESC_WD_URL}"
secret = "\${ESC_WD_SECRET}"
interval_sec = 300
EOF
  chown "root:\${SERVICE_GROUP}" "\${TMP_CFG}"
  chmod 0640 "\${TMP_CFG}"
  mv -f "\${TMP_CFG}" "\${CONFIG_PATH}"
else
  log "Existing \${CONFIG_PATH} preserved; upgrading binary, web assets, and unit only."
fi

mkdir -p "\${STATE_DIR}"
chown -R "nobody:\${SERVICE_GROUP}" "\${STATE_DIR}"
chmod 0750 "\${STATE_DIR}"

if [[ -n "\${IMPORT_BUNDLE}" ]]; then
  BUNDLE_FILE="\${IMPORT_BUNDLE}"
  if [[ "\${IMPORT_BUNDLE}" == http://* || "\${IMPORT_BUNDLE}" == https://* ]]; then
    curl -fsSL --retry 2 --connect-timeout 10 "\${IMPORT_BUNDLE}" -o "\${TMP_BUNDLE}"
    BUNDLE_FILE="\${TMP_BUNDLE}"
  fi
  [[ -f "\${BUNDLE_FILE}" ]] || die "Bundle file not found: \${BUNDLE_FILE}"

  if systemctl is-active --quiet "\${SERVICE_NAME}" 2>/dev/null; then
    log "Stopping \${SERVICE_NAME} cleanly before importing bundle..."
    systemctl stop "\${SERVICE_NAME}"
  fi

  log "Importing state bundle into \${DB_PATH}..."
  "\${BINARY_PATH}" --config "\${CONFIG_PATH}" --db "\${DB_PATH}" --import-bundle "\${BUNDLE_FILE}" --import-only
  chown -R "nobody:\${SERVICE_GROUP}" "\${STATE_DIR}"
  chmod 0750 "\${STATE_DIR}"
fi

TMP_UNIT="\${TMP_DIR}/uniob-hub.service"
cat > "\${TMP_UNIT}" <<EOF
[Unit]
Description=UniOB Self-Hosted Monitoring Hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nobody
Group=\${SERVICE_GROUP}
StateDirectory=uniob-hub
StateDirectoryMode=0750
ExecStart=\${BINARY_PATH} --config \${CONFIG_PATH}
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

chmod 0644 "\${TMP_UNIT}"
mv -f "\${TMP_UNIT}" "\${SERVICE_PATH}"
systemctl daemon-reload
if systemctl is-active --quiet "\${SERVICE_NAME}" 2>/dev/null; then
  systemctl enable "\${SERVICE_NAME}"
  systemctl restart "\${SERVICE_NAME}"
else
  systemctl enable --now "\${SERVICE_NAME}"
fi

log "uniob-hub installed and started successfully."
`;
}
