# Upgrading JotNotes JDrive

For support agents who have shell access and need to upgrade a box running 
JotNotes JDrive.

## Overview of the Upgrade Process

The upgrade process for JotNotes JDrive is straightforward but requires 
careful handling. The script ensures that customer data remains untouched 
while updating the software components.

### What This Does Not Cover
- **Running in Containers:** While detailed instructions are provided, if 
you need to run the service inside a container, refer to the `Dockerfile` 
and specific setup steps.
- **Custom Configurations or Advanced Scenarios:** If your setup includes 
custom configurations or advanced scenarios not covered here, consult the 
documentation or seek further assistance.

### Upgrading JotNotes JDrive

1. **Backup First:**
   - Before proceeding with any upgrade, ensure you have a backup of 
`/var/lib/jdrive` and `/etc/jdrive/jdrive.env`.
     ```bash
     sudo systemctl stop jdrive
     sudo tar -C /var/lib -czf jdrive-$(date +%F).tar.gz jdrive
     sudo cp /etc/jdrive/jdrive.env jdrive-env-$(date +%F).bak
     sudo systemctl start jdrive
     ```

2. **Run the Upgrade Script:**
   - Execute the upgrade script to update JotNotes JDrive.
     ```bash
     sudo ./server/tools/install.sh --upgrade
     ```

3. **Check Service Status:**
   - Verify that the service has started correctly after upgrading.
     ```bash
     systemctl status jdrive
     journalctl -u jdrive -n 50 --no-pager
     ```

### Troubleshooting Common Issues

- **JWT_SECRET Not Set:** 
  - Ensure `/etc/jdrive/jdrive.env` is properly configured and readable by 
the `jdrive` user.
    ```bash
    sudo nano /etc/jdrive/jdrive.env   # set PUBLIC_BASE_URL
    sudo systemctl restart jdrive
    ```

- **Port Already in Use:**
  - Check if port 9990 is already being used by another service and adjust 
the configuration accordingly.

- **Permission Denied Under `/var/lib/jdrive`:**
  - Correct ownership issues.
    ```bash
    sudo chown -R jdrive:jdrive /var/lib/jdrive
    ```

- **Interface Loads but Nothing Works:**
  - Ensure your reverse proxy is properly configured to pass 
`X-Forwarded-For` and that `PUBLIC_BASE_URL` points to the correct 
address.

### What This Does Not Cover

- **Custom Installations or Advanced Configurations:** For custom setups, 
refer to additional documentation.
- **Containerized Environments:** If you are running JotNotes JDrive in a 
container, use the provided Dockerfile instructions and adjustments.

