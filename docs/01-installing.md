# Installing JotNotes JDrive on a Fresh Server

## Overview

This guide covers installing JotNotes JDrive on a fresh server. The installation assumes an Ubuntu 22.04 or newer, or Debian 12 environment with systemd.

### Installation Process

The installation process involves several steps to ensure the system is set up correctly and securely:

#### Directories and Their Purposes

| Directory | Description | On Upgrade |
| --- | --- | --- |
| `/opt/jdrive` | Contains the JDrive code. Replaced wholesale during upgrades. | Replaced wholesale |
| `/var/lib/jdrive` | Stores databases, customer files, archives, and backups. | Never touched |
| `/etc/jdrive` | Houses configuration and signing secret. | Never touched |

**Backup Important Files:**
- **Back up both `/var/lib/jdrive` and `/etc/jdrive/jdrive.env`.**
  - The first directory contains all customer data.
  - The second file holds `JWT_SECRET`, which is essential for session management.

#### Installation Steps

1. **Run the installation script:**

   ```bash
   sudo ./server/tools/install.sh
   ```

2. **Create a system account and set up directories:**
   - The installer creates a `jdrive` user with no login access.
   - It generates the signing secret, installs dependencies, builds the interface, and starts a systemd service.

3. **Wait for the box to answer:**
   - The installer will ask for the first account details — typically provided by JotNotes JDrive support.

4. **Run the script again if needed:**
   - It will not overwrite the secret or data, and it will inform you about any existing configurations.

#### Front Door Configuration

- **Listen Address:** 
  - The box listens on `127.0.0.1:9990` only.
  - No TLS termination is done by the JDrive service itself; use a reverse proxy for external access.

**Example Nginx Configuration:**

```nginx
server {
    listen 443 ssl http2;
    server_name files.example.com;

    ssl_certificate     /etc/letsencrypt/live/files.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;

    client_max_body_size 2048m;

    location / {
        proxy_pass http://127.0.0.1:9990;
        proxy_http_version 1.1;

        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header Host              $host;

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

**Important Notes:**
- Ensure the client address is correctly forwarded by setting `X-Forwarded-For` and other headers.
- Use a single-hop proxy to maintain proper rate limiting.

#### Setting Public Base URL

```bash
sudo nano /etc/jdrive/jdrive.env   # set PUBLIC_BASE_URL
sudo systemctl restart jdrive
```

Until this step is completed, published files and password-reset emails will contain loopback addresses that are inaccessible externally.

#### Mail Configuration

- **Unconfigured by default:**
  - Messages land in `/var/lib/jdrive/data/mail-spool`.
  - Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM` as needed.
  
**Example Settings:**

| Setting | Description |
| --- | --- |
| `SMTP_HOST` | Your mail server. Leave unset for local spooling. |
| `SMTP_PORT` | Defaults to `587`. |
| `SMTP_SECURE` | `true` or `false`. Unset means `true` on port `465`. |
| `SMTP_USER` and `SMTP_PASS` | Credentials if required by the server. |
| `MAIL_FROM` | Default is `files@localhost`, which most servers reject. |

**Restart JDrive after setting:**

```bash
sudo systemctl restart jdrive
```

#### Upgrading

To upgrade:

```bash
sudo ./server/tools/install.sh --upgrade
```

This command installs new code, dependencies, and rebuilds the interface without touching data or configuration.

#### Backup and Restore

- **Backup Steps:**

  ```bash
  sudo systemctl stop jdrive
  sudo tar -C /var/lib -czf jdrive-$(date +%F).tar.gz jdrive
  sudo cp /etc/jdrive/jdrive.env jdrive-env-$(date +%F).bak
  sudo systemctl start jdrive
  ```

- **Restore Steps:**

  ```bash
  cd /opt/jdrive/server
  sudo -u jdrive node --env-file=/etc/jdrive/jdrive.env tools/restore.js --list
  sudo -u jdrive node --env-file=/etc/jdrive/jdrive.env tools/restore.js --verify <backup id>
  sudo -u jdrive node --env-file=/etc/jdrive/jdrive.env tools/restore.js --from <backup id>
  ```

**Environment File Required:**
- The environment file is necessary to point the tool to `/var/lib/jdrive`.

#### Offsite Backup

Set up an offsite backup in `jdrive.env`:

| Setting | Description |
| --- | --- |
| `OFFSITE_S3_ENDPOINT` | Provider's endpoint. |
| `OFFSITE_S3_BUCKET` | The bucket name. |
| `OFFSITE_S3_REGION` | Defaults to `us-east-1`. |
| `OFFSITE_S3_KEY` and `OFFSITE_S3_SECRET` | Credentials for the provider. |
| `OFFSITE_S3_PREFIX` | Optional folder inside the bucket. |

#### Uninstalling

To uninstall:

```bash
sudo ./server/tools/install.sh --uninstall
```

This command stops and removes the service but leaves data, configuration, and code intact.

#### Running in a Container

- **Dockerfile:**

  ```bash
  docker build -t jdrive .
  
  docker run -d --name jdrive \
    -p 127.0.0.1:9990:9990 \
    -v jdrive-data:/var/lib/jdrive \
    -e JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')" \
    -e PUBLIC_BASE_URL=https://files.example.com \
    jdrive
  ```

- **Bootstrap Account Creation:**

  ```bash
  docker exec -i jdrive node -e '
    const b=JSON.stringify({name:"Your Company",email:"you@example.com",password:"a-long-enough-password"});
    const r=require("http").request({host:"127.0.0.1",port:9991,path:"/bootstrap/owner",method:"POST",
      headers:{"Content-Type":"application/json","Content-Length":b.length}},
      s=>s.on("data",d=>process.stdout.write(d)));
    r.end(b);'
  ```

**Key Points:**
- `JWT_SECRET` is not baked into the image.
- `BIND_HOST=0.0.0.0` is set inside the container, ensuring loopback-only access.
- Published ports are to the host's loopback only.

#### Troubleshooting

To check service status:

```bash
systemctl status jdrive
journalctl -u jdrive -n 50 --no-pager
```

Common issues:
- **JWT_SECRET not set:** Check `/etc/jdrive/jdrive.env`.
- **Port 9990 in use:** Verify the port setting.
- **Permission denied under `/var/lib/jdrive`:** Adjust ownership if necessary.
- **Interface loads but nothing works:** Ensure correct proxy settings and `PUBLIC_BASE_URL`.

## What This Does Not Cover

This guide does not cover:
- Detailed configuration of third-party services like Let's Encrypt for SSL certificates.
- Advanced security configurations beyond the basic setup.
- Customization of JDrive features or integrations.