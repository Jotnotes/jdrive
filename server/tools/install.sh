#!/usr/bin/env bash
#
# JotNotes JDrive installer.
#
# The first person to run this is not a customer — it is somebody doing an
# assisted install on a call, on a stranger's box, possibly on a bad line. So
# every step here is written to survive being interrupted and run again:
#
#   - nothing is created twice, and re-running says "already there" rather than
#     clobbering. The secret in particular is generated once and never rewritten,
#     because rewriting it signs every existing session out
#   - the data directory is never touched after it exists
#   - every change is announced before it happens and confirmed after, so the
#     person on the other end of the call can read back what the box did
#
# It installs three things that are deliberately kept apart:
#
#   /opt/jdrive          the code. Replaced wholesale on upgrade.
#   /var/lib/jdrive      the product: databases, files, archives, backups.
#                             Never touched by an upgrade. This is the directory
#                             a hosting company backs up.
#   /etc/jdrive          the configuration and the secret.
#
# Usage:
#   sudo ./install.sh                    install, or resume an interrupted one
#   sudo ./install.sh --upgrade          new code, same data and configuration
#   sudo ./install.sh --assume-yes       never prompt (unattended)
#   sudo ./install.sh --uninstall        stop and remove the service, keep data
#
set -euo pipefail

APP_USER=jdrive
CODE_DIR=/opt/jdrive
DATA_ROOT=/var/lib/jdrive
CONF_DIR=/etc/jdrive
CONF_FILE="$CONF_DIR/jdrive.env"
UNIT=/etc/systemd/system/jdrive.service
PORT=9990
BOOTSTRAP_PORT=9991
NODE_MAJOR_MIN=20

ASSUME_YES=0
MODE=install
for arg in "$@"; do
  case "$arg" in
    --assume-yes|-y) ASSUME_YES=1 ;;
    --upgrade)       MODE=upgrade ;;
    --uninstall)     MODE=uninstall ;;
    --help|-h)       sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg. Try --help." >&2; exit 2 ;;
  esac
done

# ── Saying what is happening ────────────────────────────────────────────────
# Loud on purpose. Somebody is reading this aloud down a phone line, and the
# difference between "created" and "already there" is the whole of whether a
# re-run is safe.
say()   { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
did()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
kept()  { printf '    \033[90m·\033[0m %s\n' "$*"; }
warn()  { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()   { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

ask() {
  # $1 question. Returns 0 for yes. No terminal means no consent to assume, so an
  # unattended run has to say --assume-yes rather than be assumed to have meant it.
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -e /dev/tty ] || return 1
  local reply
  read -r -p "    $1 [y/N] " reply </dev/tty || return 1
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ── Preflight ───────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "Run this with sudo. It creates a system user and a service."
command -v systemctl >/dev/null 2>&1 || die "No systemd here. This installer sets up a systemd service; see docs/INSTALL.md for running it another way."

# The apt family, and only that, matching what the product claims. The rpm side
# is a second package manager and a second set of service conventions; it is not
# claimed here, so this says so plainly rather than half-working.
if ! command -v apt-get >/dev/null 2>&1; then
  die "This installer supports Debian and Ubuntu. See docs/INSTALL.md for running the box by hand elsewhere."
fi

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[ -f "$SRC_DIR/server/server.js" ] || die "Cannot find the product. Expected server/server.js under $SRC_DIR."

if [ "$MODE" = uninstall ]; then
  say "Removing the service. Your data and configuration are left alone."
  systemctl stop jdrive 2>/dev/null && did "stopped" || kept "was not running"
  systemctl disable jdrive 2>/dev/null && did "disabled" || true
  # A box that predates the rename is still running under the old unit name.
  systemctl stop pocketdrive 2>/dev/null && did "stopped the pre-rename service" || true
  systemctl disable pocketdrive 2>/dev/null || true
  [ -f /etc/systemd/system/pocketdrive.service ] && { rm -f /etc/systemd/system/pocketdrive.service; systemctl daemon-reload; did "removed the pre-rename unit"; } || true
  [ -f "$UNIT" ] && { rm -f "$UNIT"; systemctl daemon-reload; did "removed $UNIT"; } || kept "no unit file"
  echo
  echo "  Still on this machine, deliberately:"
  echo "    $DATA_ROOT   the databases, files and archives"
  echo "    $CONF_FILE   the configuration, including the secret"
  echo "    $CODE_DIR    the code"
  echo
  echo "  Remove them by hand if you mean to. Nothing here will delete a customer's files."
  exit 0
fi

# ── The rename ──────────────────────────────────────────────────────────────
# PocketDrive became JotNotes JDrive on 2026-09-10, and the paths moved with it.
# A box installed before that has the old ones. The operator asked for an
# install, so the move is part of the install: it happens once, it is idempotent,
# and it says what it did. Nothing is deleted and nothing is overwritten — if
# both names somehow exist, the old one is left where it is and named, because
# two databases with one silently winning is worse than a stop.
OLD_APP_USER=pocketdrive
OLD_CODE_DIR=/opt/pocketdrive
OLD_DATA_ROOT=/var/lib/pocketdrive
OLD_CONF_DIR=/etc/pocketdrive
OLD_CONF_FILE="$OLD_CONF_DIR/pocketdrive.env"
OLD_UNIT=/etc/systemd/system/pocketdrive.service

move_old() { # $1 old, $2 new, $3 what it is
  [ -e "$1" ] || return 0
  if [ -e "$2" ]; then
    warn "both $1 and $2 exist. Leaving $1 alone — move or remove it by hand."
    return 0
  fi
  mv "$1" "$2"
  did "moved $3: $1 -> $2"
}

if [ -e "$OLD_UNIT" ] || [ -e "$OLD_CONF_DIR" ] || [ -e "$OLD_DATA_ROOT" ] || [ -e "$OLD_CODE_DIR" ]; then
  say "This box predates the rename to JotNotes JDrive"
  if [ -e "$OLD_UNIT" ]; then
    systemctl stop pocketdrive 2>/dev/null && did "stopped the old service" || kept "the old service was not running"
    systemctl disable pocketdrive 2>/dev/null && did "disabled the old service" || true
    rm -f "$OLD_UNIT"; systemctl daemon-reload
    did "removed $OLD_UNIT (a new unit is written below)"
  fi
  move_old "$OLD_CONF_DIR" "$CONF_DIR" "the configuration"
  [ -e "$CONF_DIR/pocketdrive.env" ] && move_old "$CONF_DIR/pocketdrive.env" "$CONF_FILE" "the configuration file"
  move_old "$OLD_DATA_ROOT" "$DATA_ROOT" "the data"
  [ -e "$DATA_ROOT/data/pocketdrive.db" ] && move_old "$DATA_ROOT/data/pocketdrive.db" "$DATA_ROOT/data/jdrive.db" "the database"
  move_old "$OLD_CODE_DIR" "$CODE_DIR" "the code"
  if id -u "$OLD_APP_USER" >/dev/null 2>&1 && ! id -u "$APP_USER" >/dev/null 2>&1; then
    usermod -l "$APP_USER" "$OLD_APP_USER" 2>/dev/null && did "renamed the service account" \
      || warn "could not rename the $OLD_APP_USER account; the new one is created below and the files are re-owned."
  fi
fi

# ── Node ────────────────────────────────────────────────────────────────────
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
say "Checking Node.js"
HAVE=$(node_major)
if [ "$HAVE" -ge "$NODE_MAJOR_MIN" ]; then
  did "Node $(node -v) is new enough"
else
  if [ "$HAVE" = 0 ]; then warn "Node.js is not installed."; else warn "Node $(node -v) is too old; this needs $NODE_MAJOR_MIN or newer."; fi
  if ask "Install Node $NODE_MAJOR_MIN from NodeSource? This changes apt sources on this machine."; then
    # NEEDRESTART_MODE=l: list what wants restarting, restart nothing.
    #
    # Not a nicety. needrestart runs after apt on Debian and Ubuntu and restarts
    # every service whose libraries have moved, and ssh.service is on its list —
    # so installing a package over ssh restarts the daemon carrying the session
    # the installer is running in. What the operator sees is the install stopping
    # halfway with no error at all.
    #
    # Found by the Arca installer's distro matrix on 2026-08-29, where it wore
    # three costumes before anybody saw one mechanism: an scp that closed partway
    # through Debian 13, a connection reset partway through Ubuntu 26.04, and a
    # session that died silently and left a run hanging for two hours on a box
    # that had already finished. Anyone who provisions a VPS and runs a
    # one-command installer over ssh — which is everyone — is in that position.
    export NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_MIN}.x" | bash -
    apt-get install -y nodejs
    did "installed Node $(node -v)"
  else
    die "Install Node $NODE_MAJOR_MIN or newer and run this again."
  fi
fi

# ── The service account ─────────────────────────────────────────────────────
# A system account with no shell and no home worth having. The box handles other
# people's documents; it does not need to be able to log in anywhere.
say "Service account"
if id -u "$APP_USER" >/dev/null 2>&1; then
  kept "$APP_USER already exists"
else
  useradd --system --home-dir "$DATA_ROOT" --shell /usr/sbin/nologin "$APP_USER"
  did "created $APP_USER (system account, no login)"
fi

# ── Where the product lives ─────────────────────────────────────────────────
# Separated from the code on purpose. An upgrade replaces /opt and must not be
# able to touch this, and a hosting company backing the box up should have one
# directory to name.
say "Data directories"
for d in "$DATA_ROOT" "$DATA_ROOT/data" "$DATA_ROOT/uploads" "$DATA_ROOT/backups" "$DATA_ROOT/archives"; do
  if [ -d "$d" ]; then kept "$d already there"; else mkdir -p "$d"; did "created $d"; fi
done
chown -R "$APP_USER:$APP_USER" "$DATA_ROOT"
chmod 750 "$DATA_ROOT"
did "owned by $APP_USER, not readable by other users on this machine"

# ── Configuration and the secret ────────────────────────────────────────────
# The secret is generated once. Rewriting it on a re-run would sign every
# customer out of a working box, which is exactly the kind of thing an installer
# that is safe to re-run must not do.
say "Configuration"
mkdir -p "$CONF_DIR"
if [ -f "$CONF_FILE" ]; then
  kept "$CONF_FILE already there — left exactly as it is, secret included"
else
  SECRET=$(node -p 'require("crypto").randomBytes(48).toString("base64url")')
  cat > "$CONF_FILE" <<EOF
# JotNotes JDrive configuration. Written by install.sh on $(date -Is).
#
# JWT_SECRET signs every session on this box. Changing it signs everybody out.
# Keep it out of version control and include this file in your backups.
JWT_SECRET=$SECRET

PORT=$PORT
BOOTSTRAP_PORT=$BOOTSTRAP_PORT

# The product. Everything a customer would miss is under here.
DATA_DIR=$DATA_ROOT/data
UPLOADS_DIR=$DATA_ROOT/uploads
BACKUPS_DIR=$DATA_ROOT/backups
ARCHIVES_DIR=$DATA_ROOT/archives

# The address customers and share links actually reach, once the reverse proxy
# in front of this box is terminating TLS. Set this and restart, or published
# files and password-reset mails will carry a loopback address nobody can open.
# PUBLIC_BASE_URL=https://files.example.com
# APP_BASE_URL=https://files.example.com

# MAX_UPLOAD_MB=2048

# Once-a-day signed update notice. It sends only User-Agent: JDrive/<version>.
# JDRIVE_UPDATES_URL=https://jdrive.jotnotes.com/releases/latest.json
# Set JDRIVE_UPDATES_URL=off to disable it.
EOF
  chown root:"$APP_USER" "$CONF_FILE"
  chmod 640 "$CONF_FILE"
  did "wrote $CONF_FILE with a freshly generated secret (root:$APP_USER, 0640)"
fi

# ── The code ────────────────────────────────────────────────────────────────
say "Installing the code into $CODE_DIR"
if [ "$SRC_DIR" = "$CODE_DIR" ]; then
  kept "already running from $CODE_DIR"
else
  mkdir -p "$CODE_DIR"
  # Deliberately not --delete: node_modules and web/dist are built in place, and
  # an upgrade rebuilds them below rather than throwing them away first.
  tar -C "$SRC_DIR" --exclude=.git --exclude=node_modules --exclude=server/data \
      --exclude=server/uploads --exclude=server/backups --exclude=server/archives \
      --exclude='server/.env' -cf - . | tar -C "$CODE_DIR" -xf -
  did "copied the product into $CODE_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$CODE_DIR"

say "Installing dependencies and building the interface"
( cd "$CODE_DIR/server" && npm ci --omit=dev --no-audit --no-fund >/dev/null ) && did "server dependencies"
# A release arrives with the interface already compiled and no web source at all.
# A checkout of the repository still builds it here.
if [ -f "$SRC_DIR/web/dist/index.html" ] && [ ! -d "$SRC_DIR/web/src" ]; then
  did "the interface came compiled in the release"
else
  ( cd "$CODE_DIR/web" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null ) && did "built web/dist, which is what the box serves"
fi
chown -R "$APP_USER:$APP_USER" "$CODE_DIR"

# ── The service ─────────────────────────────────────────────────────────────
# Bound to loopback by the product itself, so the hardening below is about what
# happens if the process is ever taken over, not about who can reach it.
say "systemd service"
cat > "$UNIT" <<EOF
[Unit]
Description=JotNotes JDrive
Documentation=file://$CODE_DIR/docs/INSTALL.md
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$CODE_DIR/server
EnvironmentFile=$CONF_FILE
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

# The box writes to exactly one place. Everything else on the machine is read
# only as far as this process is concerned.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA_ROOT
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
EOF
did "wrote $UNIT"
systemctl daemon-reload
systemctl enable jdrive >/dev/null 2>&1 && did "enabled at boot"
systemctl restart jdrive
did "started"

say "Waiting for the box to answer"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    did "healthy on 127.0.0.1:$PORT"
    HEALTHY=1
    break
  fi
  sleep 1
done
[ "${HEALTHY:-0}" = 1 ] || { journalctl -u jdrive -n 30 --no-pager || true; die "The box did not come up. The last of its log is above."; }

if [ "$MODE" = upgrade ]; then
  say "Upgraded."
  echo "    The data in $DATA_ROOT and the secret in $CONF_FILE were not touched."
  echo
  warn "Schema changes are applied on start as guarded ALTER TABLEs, with no version number"
  warn "and no ordering. That is fine while every change only adds a column. Take a backup"
  warn "before an upgrade until there is a real migration runner — see 0g in docs/NEXT.md."
  exit 0
fi

# ── The first account ───────────────────────────────────────────────────────
# Through the product's own bootstrap route rather than a second way in. It is
# loopback only and refuses the moment an account exists, so it cannot mint a
# second operator later.
say "The first account: the hosting company that runs this box"
# Asked with a body the route will refuse anyway, purely to read the status: 409
# means an account already exists and this step is done, 400 means it is waiting
# for a real one. Nothing is created by asking.
EXISTS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$BOOTSTRAP_PORT/bootstrap/owner" \
  -H 'Content-Type: application/json' -d '{"name":"","email":"","password":""}' || true)
if [ "$EXISTS" = "409" ]; then
  kept "this box already has its first account — nothing to do"
else
  echo
  echo "    This account runs the box. It is created here and only here, and the"
  echo "    route closes for good the moment it exists."
  echo
  # Unattended when all three are in the environment, asked for otherwise.
  #
  # The environment path exists because an automated install has no terminal:
  # there is no /dev/tty on the far side of a non-interactive ssh, so the prompts
  # below do not merely go unanswered, they fail. That is how the distro matrix
  # runs this, and how a hosting company would drive it from their own tooling.
  #
  # Still typed by a person in the normal case. A password this script invents is
  # a password that ends up in terminal scrollback and, on an assisted install,
  # in a call recording.
  if [ -n "${JDRIVE_OWNER_EMAIL:-}" ] && [ -n "${JDRIVE_OWNER_PASSWORD:-}" ]; then
    OWNER_NAME="${JDRIVE_OWNER_NAME:-Operator}"
    OWNER_EMAIL="$JDRIVE_OWNER_EMAIL"
    OWNER_PASS="$JDRIVE_OWNER_PASSWORD"
    [ "${#OWNER_PASS}" -ge 12 ] || die "JDRIVE_OWNER_PASSWORD is shorter than 12 characters."
    kept "taking the first account from the environment (unattended)"
  else
    [ -e /dev/tty ] || die "No terminal to ask on. Set JDRIVE_OWNER_NAME, JDRIVE_OWNER_EMAIL and JDRIVE_OWNER_PASSWORD for an unattended install."
    read -r -p "    Name: " OWNER_NAME </dev/tty
    read -r -p "    Email address: " OWNER_EMAIL </dev/tty
    while :; do
      read -r -s -p "    Password (at least 12 characters): " OWNER_PASS </dev/tty; echo
      read -r -s -p "    Again: " OWNER_PASS2 </dev/tty; echo
      [ "$OWNER_PASS" = "$OWNER_PASS2" ] || { warn "Those did not match."; continue; }
      [ "${#OWNER_PASS}" -ge 12 ] || { warn "Too short."; continue; }
      break
    done
  fi
  RESULT=$(curl -s -w '\n%{http_code}' -X POST "http://127.0.0.1:$BOOTSTRAP_PORT/bootstrap/owner" \
    -H 'Content-Type: application/json' \
    --data-binary "$(node -e 'const [n,e,p]=process.argv.slice(1);process.stdout.write(JSON.stringify({name:n,email:e,password:p}))' "$OWNER_NAME" "$OWNER_EMAIL" "$OWNER_PASS")")
  CODE=$(printf '%s' "$RESULT" | tail -n1)
  if [ "$CODE" = "200" ]; then did "created $OWNER_EMAIL as the account that runs this box"
  else die "The box refused it: $(printf '%s' "$RESULT" | sed '$d')"; fi
fi

# ── What is left, which is the part that is not automatic ───────────────────
cat <<EOF

$(printf '\033[1m')Installed.$(printf '\033[0m')

  The box is listening on 127.0.0.1:$PORT and nowhere else. That is deliberate:
  it does not terminate TLS, and it is not reachable from the network until you
  put a reverse proxy in front of it.

  Two things left, and neither is optional:

  1. Put a proxy in front of it and terminate TLS there. Published files and
     share links go out through it, so this is a security question and not a
     deployment detail. There is a worked nginx example in:

       $CODE_DIR/docs/INSTALL.md

  2. Set PUBLIC_BASE_URL in $CONF_FILE to the address customers
     actually reach, then:

       sudo systemctl restart jdrive

     Until you do, published files and password-reset mails carry a loopback
     address nobody outside this machine can open.

  Mail is unconfigured, so messages land in $DATA_ROOT/data/mail-spool
  as files. The box says so in its log at every start.

  Back up $DATA_ROOT and $CONF_FILE together. The first is
  every customer's files; the second is the secret that makes their sessions work.

    systemctl status jdrive
    journalctl -u jdrive -f

EOF
