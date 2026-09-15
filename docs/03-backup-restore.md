# Backing up a JotNotes JDrive Box and Restoring One

## Backup Procedure

To back up your JotNotes JDrive box, follow these steps:

1. **Stop the service** to ensure that SQLite is not being written to during the backup process:
   ```bash
   sudo systemctl stop jdrive
   ```

2. **Create a tarball of the `/var/lib/jdrive` directory** and save it with a timestamped filename:
   ```bash
   sudo tar -C /var/lib -czf jdrive-$(date +%F).tar.gz jdrive
   ```

3. **Backup the environment file** to ensure that you can restore the service correctly later:
   ```bash
   sudo cp /etc/jdrive/jdrive.env jdrive-env-$(date +%F).bak
   ```

4. **Restart the JotNotes JDrive service** after completing the backup:
   ```bash
   sudo systemctl start jdrive
   ```

### Restore Procedure

To restore a backup, follow these steps:

1. **Navigate to the directory containing the JotNotes JDrive server code:**
   ```bash
   cd /opt/jdrive/server
   ```

2. **Run the `restore.js` tool with the appropriate flags**:
   ```bash
   sudo -u jdrive node --env-file=/etc/jdrive/jdrive.env tools/restore.js --list
   sudo -u jdrive node --env-file=/etc/jdrive/jdrive.env tools/restore.js --verify <backup id>
   sudo -u jdrive node --env-file=/etc/jdrive/jdrive.env tools/restore.js --from <backup id>
   ```

3. **Ensure that the environment file is specified** to tell the tool where to find the data:
   ```bash
   /etc/jdrive/jdrive.env
   ```

4. **If a backup fails verification, it will be refused**, and you must use `--force` to proceed with restoration.

## Offsite Backup

To create an offsite copy of your JotNotes JDrive backups, set the following environment variables in `/etc/jdrive/jdrive.env`:

| Setting | Description |
|---|---|
| `OFFSITE_S3_ENDPOINT` | The provider's endpoint for S3-compatible storage. |
| `OFFSITE_S3_BUCKET` | The bucket where backups will be stored. |
| `OFFSITE_S3_REGION` | Defaults to `us-east-1`. |
| `OFFSITE_S3_KEY` and `OFFSITE_S3_SECRET` | Credentials for accessing the S3 bucket. |
| `OFFSITE_S3_PREFIX` | Optional folder inside the bucket where backups will be stored. |

## What This Does Not Cover

This article covers backing up and restoring a JotNotes JDrive box, but it does not cover other aspects such as:

- Detailed configuration of the service.
- Setting up TLS termination with an external proxy.
- Running the service in a container environment.
- Advanced troubleshooting steps for when the service fails to start.