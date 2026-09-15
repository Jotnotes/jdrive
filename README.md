# JotNotes JDrive Community

Your own place for files, on your own server: a desktop in the browser with big pictures of your files,
four places to keep them, public addresses and share links, earlier versions, search and a Trash.

This is the free edition, under the GNU Affero General Public License v3. One admin adds the people who
use the box and sets how much each of them may store. There is no sign-up.

**JDrive for Hosting** is the paid edition, for companies that sell accounts: resellers, plans, your own
brand, API keys for a billing system, transfer metering, signing in as a customer to help them, an
overview of the whole box, and a licence. It is the same core with those added.

## What it does not do yet

No desktop sync app, no mobile apps, no two-factor sign-in, and no live document editing. It works in a
browser. If you need those today, Nextcloud, ownCloud and Seafile have them.

## What a person sees

Four places, and that is the entire mental model.

- **My Files** — private, everything lands here, nobody but them
- **Public** — anyone with the address can open it
- **Shared** — a link they gave somebody, with a role and an expiry
- **Trash** — deleted, until they empty it

Which place a file is in is decided by which directory the bytes are in, never by a column. A stored
place can disagree with the disk, and when it does, the disagreement is silent and it is somebody's
private file on the open internet.

Nothing in Public executes. The server streams bytes and there is no interpreter anywhere near them.

## Run it

```bash
cd server
npm install
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
npm run dev
```

The first account is created over a loopback listener, because on a new box there is nobody to ask:

```bash
curl -X POST http://127.0.0.1:9991/bootstrap/owner \
  -H 'Content-Type: application/json' \
  -d '{"name":"You","email":"you@example.com","password":"a-long-enough-password"}'
```

After that the door is shut. There is no public sign-up: the admin adds everybody else from the
console at `/console`.

For a real server — systemd, nginx, HTTPS, backups — follow `docs/INSTALL.md`.

## Mail

Every account except that first one has to confirm its address before it works, and a forgotten
password is recovered the same way, so the box needs somewhere to send. Whoever runs the box supplies
it. We do not run mail for anybody: a self-hosted box should not need an account with us to work.

```
SMTP_HOST=smtp.example.net
SMTP_PORT=587
SMTP_USER=jdrive
SMTP_PASS=...
MAIL_FROM="Files <files@example.net>"
APP_BASE_URL=https://files.example.net
```

With `SMTP_HOST` unset, messages are written to `data/mail-spool/` instead of sent, the box says so
at boot, and `GET /api/mail/status` answers for it to the operator and to nobody else. That is for a
machine being installed. A box in use in that state is one whose people cannot get in.

## The desktop

`web/` is the thing a person sees: wallpaper, a dock, real windows, folders with breadcrumbs, and a
picture of every file rather than a row in a table.

Thumbnails are made in the browser and handed to the box, which stores them and never decodes an
image itself — an image decoder is the part of a file product most likely to be broken by a file
somebody uploaded, and this one has no reason to run one. They live in the database rather than in
the uploads tree, so they are covered by the backup, they cost the customer nothing against their
storage limit, and the orphan sweeper never sees them.

```bash
cd web && npm install && npm run build
```

The box serves the build itself, so there is one origin and no second server in production. Working on
the shell, `npm run dev` in `web/` puts vite on 5173 and proxies the API, published files and share
links back to the box on 9990.

A box with no build still works and is still the whole product over HTTP, which is why an install with
no desktop is a missing feature rather than a broken box.

## Tests

```bash
cd server && npm test
```

It finds every `*.test.js` under `server/` and says how many suites ran.

## Licence and name

The code is AGPL-3.0: run it, change it and share it, and if you offer a changed version to people over
a network, offer them your source too. The JotNotes and JDrive names are not part of that licence. A
fork is welcome, under a name of its own.
