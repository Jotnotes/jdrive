# JotNotes JDrive: what changed in each version

Newest first. Every release is signed; check a download before installing with
`node verify-release.js jdrive-x.y.z.tgz`, and upgrade an installed box with
`sudo /opt/jdrive/server/tools/upgrade.sh jdrive-x.y.z.tgz`, which refuses a download that is not signed
by JotNotes. A licence never blocks an upgrade, including security fixes.

## 0.1.0 — 2026-09-14

The first release.

### Both editions

- **Files in the browser, nothing to install.** A desktop with a Files window: My Files, Shared, Public and
  Trash, folders, tags, search, versions, previews and thumbnails, and file names in any
  language.
- **Sharing.** Links for somebody without an account, with an expiry and an optional password; public
  addresses for files published to the open internet; every link can be stopped.
- **Accounts.** Sign-in, email confirmation, password reset, a list of your own sessions with sign-out
  everywhere, and an administrator who adds people and sets each person's storage.
- **Nothing is lost by accident.** Ending an account seals its files into an archive and reads the archive
  back before anything is removed; archives can be checked, restored or deleted. Backups on a schedule,
  restore, and copies shipped to S3-compatible storage off the box.
- **An audit trail** of who did what, on every account.
- **Install and upgrade** on Ubuntu 22.04, 24.04 and 26.04 and Debian 12 and 13, tested on each for every
  release. Signed downloads, and a once-a-day notice in the console when a newer version or a security fix
  is out. The check sends only the product version.

### JDrive for Hosting

- **Your own brand** on every screen, email and the sign-in page: name, logo, app icon, colours, wallpaper
  and support contact.
- **Plans** with storage, transfer and feature switches, enforced by the box, with per-account limits and a
  reason recorded for each.
- **Resellers** who sell under you, with their own customers and plans, one level down.
- **Your billing system runs it:** billing keys that create, suspend, upgrade and end accounts, with safe
  retries; a module for **Blesta**; notifications to your systems when accounts change, signed and retried.
- **Customers open their files from your client area** with a one-time link, and JDrive can be shown inside
  your own site.
- **Transfer metering** with warnings and limits.
- **Support access:** staff can see a customer's screens to help them, never their files, and it is on the
  customer's record.
- **An overview** of accounts, storage, transfer and your licence band.
- **Licences** checked on the box with no network call. A lapsed licence pauses new accounts and uploads;
  every existing file keeps opening, downloading and sharing.
- **Checked in** Chromium, Chrome, Brave, Firefox, WebKit and Safari.
