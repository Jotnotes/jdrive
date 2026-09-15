# Setting Up Outgoing Mail for JotNotes JDrive

## Overview

JotNotes JDrive, a file-storage product, requires outgoing mail to be configured. This article covers how to set up the necessary settings in `/etc/jdrive/jdrive.env` and restart the service.

### Configuration Settings

To configure outgoing mail, you need to set several environment variables in `/etc/jdrive/jdrive.env`. Here are the required settings:

| Setting | What it is |
|---|---|
| `SMTP_HOST` | Your mail server. Leave this unset for messages to go into a spool. |
| `SMTP_PORT` | Defaults to `587`. Can be changed if needed. |
| `SMTP_SECURE` | `true` or `false`. Unset means `true` on port `465` and `false` otherwise. |
| `SMTP_USER` and `SMTP_PASS` | Credentials required by the mail server, if applicable. |
| `MAIL_FROM` | The address from which messages are sent. Defaults to `files@localhost`, which most servers refuse. |

### Steps

1. **Edit the Environment File:**
   ```bash
   sudo nano /etc/jdrive/jdrive.env
   ```
   Set the required settings in this file.

2. **Restart the JDrive Service:**
   ```bash
   sudo systemctl restart jdrive
   ```

3. **Verify Configuration:**
   After setting these values, the start-up warning should disappear from the logs.

### What This Does Not Cover

- This article does not cover how to set up a mail server or configure SMTP settings in detail.
- It also does not address scenarios where multiple JDrive instances need to share the same mail configuration.