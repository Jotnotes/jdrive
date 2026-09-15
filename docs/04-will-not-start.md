# The box will not start: what to check, in order

Start with what the service says about itself. These two commands answer most cases:

```bash
systemctl status jdrive
journalctl -u jdrive -n 50 --no-pager
```

Then match the log to one of the causes below. They are listed in the order they tend to happen.

## `JWT_SECRET not set`

The configuration file `/etc/jdrive/jdrive.env` is missing, or the service cannot read it.

The file is owned `root:jdrive` with mode `0640`, and that is on purpose. If the ownership or mode has changed, the service account cannot read its own secret. Put them back rather than loosening them.

If the file is gone entirely, do not generate a new secret casually. The secret signs every session on the box, so a new one signs everybody out. Restore it from the backup taken alongside `/var/lib/jdrive`.

## Port 9990 already in use

Something else on the machine is listening on the box's port. Either stop the other program, or change `PORT` in `/etc/jdrive/jdrive.env` and point your proxy at the new port.

## Permission denied under `/var/lib/jdrive`

Ownership of the data directory has drifted, usually after files were copied in by hand as root. Put it back:

```bash
chown -R jdrive:jdrive /var/lib/jdrive
```

## The interface loads but nothing works

The box is running and the problem is in front of it. Two things to check:

- The proxy is not passing `X-Forwarded-For`.
- `PUBLIC_BASE_URL` in `/etc/jdrive/jdrive.env` still says loopback. Until it is set, published files and password-reset emails carry a loopback address.

After changing `PUBLIC_BASE_URL`, restart the service.

## What this does not cover

- Setting up your proxy from scratch. That is covered in the installation article.
- A box whose database was written by a newer version. It refuses to start on purpose rather than write to a database it does not understand.
- Mail and offsite backup. The box warns about both at every start, but neither stops it starting.
