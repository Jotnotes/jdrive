# Installing JotNotes JDrive

For the person putting this on a machine, and for whoever has to keep it running
afterwards. It assumes Ubuntu 22.04 or 24.04, or Debian 12 or 13, with systemd.

The script is safe to re-run, loud about what it changed, and it stops rather than
guessing.

## The shape of an install

Three directories, kept apart on purpose:

| Where | What | On upgrade |
|---|---|---|
| `/opt/jdrive` | the code | replaced wholesale |
| `/var/lib/jdrive` | databases, customer files, archives, backups | **never touched** |
| `/etc/jdrive` | configuration and the signing secret | **never touched** |

**Back up `/var/lib/jdrive` and `/etc/jdrive/jdrive.env` together.**
The first is every customer's files. The second holds `JWT_SECRET`, which signs
every session on the box — restore the files without it and everybody is signed
out.

## Installing

Download the archive, its `.sig`, its `.sig.txt`, and `verify-release.js` into
one directory. Before extracting anything, verify it:

```bash
node verify-release.js jdrive-0.1.0.tgz
```

That command recomputes the SHA-256 named in the readable signed statement and
checks JotNotes' Ed25519 signature. It prints one sentence and exits non-zero if
the download is unsigned, changed, or signed by anybody else. Node's built-in
`crypto` is the portable path on Ubuntu 22.04/24.04 and Debian 12/13; the
installer needs Node 20 or newer in any case. OpenSSL's Ed25519 command-line
behaviour differs between the versions those releases ship, so it is not the
documented verification path.

Only after it says `JDrive release verified.` extract it and install:

```bash
tar -xzf jdrive-0.1.0.tgz
cd jdrive-0.1.0
sudo ./server/tools/install.sh
```

It creates a `jdrive` system account with no login, makes the directories,
generates the signing secret, installs dependencies (the interface arrives already built),
installs and starts a systemd service, waits for the box to answer, and then asks
you for the first account — whoever runs the box.

Run it again any time. It will not overwrite the secret, will not touch the data,
and will tell you what was already there rather than doing it twice.

The first account is created through the product's own bootstrap route on
`127.0.0.1:9991`, which is loopback only and refuses the moment an account
exists. There is no second way to mint an operator, and that is on purpose.

**You type the password.** The installer will not generate one — a password a
script invents is a password that ends up in terminal scrollback and, on an
assisted install, in a call recording.

## The front door

**The box listens on `127.0.0.1:9990` and nowhere else.** It does not terminate
TLS. Until you put a proxy in front of it, nothing outside the machine can reach
it — including published files and share links, which is the point: those go out
through the proxy, so this is a security question rather than a deployment
detail.

**Open the web ports first.** Many VPS images, Vultr's Ubuntu among them, ship with
the firewall on and only SSH allowed. Everything below works on the machine and nothing
reaches it from outside until you do this:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

Install nginx with `sudo apt install nginx`, and get a certificate for your hostname
from Let's Encrypt or your usual provider. The paths below are where Let's Encrypt puts
it.

A worked nginx example:

```nginx
server {
    listen 443 ssl http2;
    server_name files.example.com;

    ssl_certificate     /etc/letsencrypt/live/files.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;

    # Customers upload real files. The box's own ceiling is MAX_UPLOAD_MB
    # (2048 by default); nginx has to allow at least as much or it will refuse
    # the upload before the box ever sees it, with an error the customer cannot
    # act on.
    client_max_body_size 2048m;

    location / {
        proxy_pass http://127.0.0.1:9990;
        proxy_http_version 1.1;

        # Not optional. The box runs with Express's `trust proxy` set to one
        # hop, so it reads the client's address out of X-Forwarded-For. Without
        # these, every request arrives looking like 127.0.0.1 and every rate
        # limit on the box — sign-ins, password resets, published files — is
        # shared by the whole internet instead of being per-caller.
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header Host              $host;

        # Big uploads over slow lines.
        proxy_read_timeout    600s;
        proxy_send_timeout    600s;
        proxy_request_buffering off;
    }
}

server {
    listen 80;
    server_name files.example.com;
    return 301 https://$host$request_uri;
}
```

**If you put anything else in front of nginx** — Cloudflare, a load balancer —
that is a second hop, and `trust proxy` is set to one. The client address the box
sees will be your own proxy's, and its rate limiting will be keyed on that.
Either terminate at a single hop or change the setting deliberately.

## Telling the box its own address

```bash
sudo nano /etc/jdrive/jdrive.env   # set PUBLIC_BASE_URL
sudo systemctl restart jdrive
```

Until you do, published files and password-reset mails carry a loopback address
nobody outside the machine can open.

## Showing it inside your own site

Nothing else may put the box in a frame, because a page that frames it can lay its own buttons over
it. To show it inside your client area or intranet, name that site in `/etc/jdrive/jdrive.env`:

```bash
EMBED_ORIGINS=https://portal.example.com
```

Several are separated by commas. Each must be a whole https origin; anything else is ignored and the
box says so in its log when it starts. `sudo systemctl restart jdrive` to apply.

A web page on another domain calling the API is a separate setting. It is allowed by default; to allow
only your own sites, set `ALLOWED_ORIGINS=https://portal.example.com`.

## Mail

Unconfigured out of the box. Messages land in
`/var/lib/jdrive/data/mail-spool` as files, and the box says so in its log
at every start. Confirmations, password resets and the notice a customer gets
when their account changes hands all go through it, so a box with no mail is a
box where nobody can confirm an address.

Set these in `/etc/jdrive/jdrive.env`, then `sudo systemctl restart jdrive`:

| Setting | What it is |
|---|---|
| `SMTP_HOST` | your mail server. Leave it unset and mail goes to the spool |
| `SMTP_PORT` | defaults to `587` |
| `SMTP_SECURE` | `true` or `false`. Unset, it is on for port `465` and off otherwise |
| `SMTP_USER` and `SMTP_PASS` | the credentials, if the server wants them |
| `MAIL_FROM` | the address messages come from. Defaults to `files@localhost`, which most servers refuse |

The start-up warning disappears once `SMTP_HOST` is set.


## Upgrading

```bash
sudo /opt/jdrive/server/tools/upgrade.sh /path/to/jdrive-0.1.1.tgz
```

Use the upgrader from the code already installed. It checks the new archive's
JotNotes signature and SHA-256 before it extracts or runs anything from that
archive, then runs the new release's `install.sh --upgrade`. New code, new
dependencies, a rebuilt interface, and a restart follow; the data and the
configuration are left alone. The old direct `install.sh --upgrade` path still
works, but it cannot establish where the files came from and is not the normal
upgrade path.

For local development only, `upgrade.sh --allow-unsigned` bypasses both the
signature and signed checksum with a loud warning. A missing or lapsed Hosting
licence never affects release verification or installation.

### Update notices

Once a day the box reads a signed release notice from
`https://jdrive.jotnotes.com/releases/latest.json`. The console shows a single
line to the box operator when a newer version exists, marks security fixes, and
links to the release notes. Customers and resellers never see it and it never
installs anything automatically.

Set `JDRIVE_UPDATES_URL=https://updates.example/latest.json` in
`/etc/jdrive/jdrive.env` to use a mirror, or `JDRIVE_UPDATES_URL=off` to disable
the check. The signature is still mandatory at a mirror. Requests contain no
licence, hostname, account or usage information: only `User-Agent:
JDrive/<installed version>`. A failed, unsigned, or altered notice is ignored
and produces one log line for that day's attempt.

**Take a backup first, and this is not boilerplate.** Schema changes are applied
on start, in order, once each. A box whose database was written by a newer build
refuses to start rather than write to it, and a change that fails part way leaves
no record of itself, so the next start tries it again. The log names the schema
version at every start.

## Backup and restore

The operator's own backup lives in the console. On disk:

```bash
sudo systemctl stop jdrive
sudo tar -C /var/lib -czf jdrive-$(date +%F).tar.gz jdrive
sudo cp /etc/jdrive/jdrive.env jdrive-env-$(date +%F).bak
sudo systemctl start jdrive
```

Stopping first matters: SQLite is being written to, and a tar of a live database
is a tar of a database mid-write.

To put a backup back, with the service stopped:

```bash
cd /opt/jdrive/server
sudo -u jdrive node --env-file=/etc/jdrive/jdrive.env tools/restore.js --list
sudo -u jdrive node --env-file=/etc/jdrive/jdrive.env tools/restore.js --verify <backup id>
sudo systemctl stop jdrive
sudo -u jdrive node --env-file=/etc/jdrive/jdrive.env tools/restore.js --from <backup id> --force
sudo systemctl start jdrive
```

**The environment file is not optional.** It is what tells the tool the data is in
`/var/lib/jdrive`. Run it without and it looks beside the code instead, finds no
backups, and says so.

On an installed box `--force` is always needed, because there is always a
database there to restore over; without it the tool stops and says so. It refuses a
backup that does not verify, and renames what it displaces aside rather than
deleting it, into `/var/lib/jdrive/data.superseded-…` and
`/var/lib/jdrive/uploads.superseded-…`. Everybody signs in again afterwards. There
is deliberately no web route for this.

This sequence was run on a fresh Ubuntu 24.04 install on 2026-09-13: a file
uploaded after the backup was gone after the restore, and the one before it was
back.

### An offsite copy

A backup on the same disk as the data dies with the disk, and the box warns about
it at every start. Point it at any S3-compatible bucket in
`/etc/jdrive/jdrive.env`:

| Setting | What it is |
|---|---|
| `OFFSITE_S3_ENDPOINT` | the provider's endpoint |
| `OFFSITE_S3_BUCKET` | the bucket |
| `OFFSITE_S3_REGION` | defaults to `us-east-1` |
| `OFFSITE_S3_KEY` and `OFFSITE_S3_SECRET` | the credential |
| `OFFSITE_S3_PREFIX` | optional folder inside the bucket |

## Removing it

```bash
sudo ./server/tools/install.sh --uninstall
```

Stops and removes the service. It deliberately leaves the data, the
configuration and the code where they are, and tells you where. Nothing in this
installer deletes a customer's files.

## Running it in a container

The script is the supported path, because it is what every panel in this category
does and because not every hosting company runs containers. The `Dockerfile` in
the repository root is the documented alternative for people who already do.

```bash
docker build -t jdrive .

docker run -d --name jdrive \
  -p 127.0.0.1:9990:9990 \
  -v jdrive-data:/var/lib/jdrive \
  -e JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')" \
  -e PUBLIC_BASE_URL=https://files.example.com \
  jdrive
```

Then create the account that runs the box, once:

```bash
docker exec -i jdrive node -e '
  const b=JSON.stringify({name:"Your Company",email:"you@example.com",password:"a-long-enough-password"});
  const r=require("http").request({host:"127.0.0.1",port:9991,path:"/bootstrap/owner",method:"POST",
    headers:{"Content-Type":"application/json","Content-Length":b.length}},
    s=>s.on("data",d=>process.stdout.write(d)));
  r.end(b);'
```

Four things about that, and none of them are incidental:

- **`JWT_SECRET` is not baked into the image**, and the box refuses to start
  without one. A secret in an image is a secret every copy of that image shares.
  Keep the one you generate — losing it signs every customer out.
- **`BIND_HOST=0.0.0.0` is set inside the image, and only inside it.** Loopback
  in a container is the container's own, so a published port would reach nothing
  and the box could not be run this way at all. On metal the default is still
  `127.0.0.1` and should stay there.
- **`-p 127.0.0.1:9990:9990` publishes to the host's loopback, not the world.**
  The box still does not terminate TLS, so the reverse proxy above is still
  required and still has to set `X-Forwarded-For`.
- **The bootstrap port is never published.** It creates the account that runs the
  box, so it stays on the container's own loopback where that one `docker exec`
  can reach it and nothing else can.

**One real difference from the script install:** the image ships the web bundle it
serves, built at image-build time, rather than building it on the customer's
machine. Faster, and a hoster inspecting a white-label product no longer watches
it build what it serves. `L1` and `L2` in the audit hold the two listen rules
above.

## When it will not start

```bash
systemctl status jdrive
journalctl -u jdrive -n 50 --no-pager
```

The usual causes, in the order they happen:

- **`JWT_SECRET not set`** — `/etc/jdrive/jdrive.env` is missing or the
  service cannot read it. It is `root:jdrive` and `0640` on purpose.
- **Port 9990 already in use** — something else is on it. `PORT` in the same file.
- **Permission denied under `/var/lib/jdrive`** — ownership drifted;
  `chown -R jdrive:jdrive /var/lib/jdrive`.
- **The interface loads but nothing works** — the proxy is not passing
  `X-Forwarded-For`, or `PUBLIC_BASE_URL` still says loopback.
