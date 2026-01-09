# Cloudflare Tunnel Setup Guide

This guide walks through setting up a Cloudflare Tunnel to expose the Linear webhook server publicly with IP allowlisting via Cloudflare Access.

## Prerequisites

- Cloudflare account with a domain managed by Cloudflare
- `cloudflared` CLI installed locally ([download here](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/))
- Docker and Docker Compose installed

## Quick Setup

### Step 1: Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

This opens a browser window to authorize cloudflared.

### Step 2: Create a Tunnel

```bash
cloudflared tunnel create linear-webhook
```

This will:

- Create a tunnel in your Cloudflare account
- Generate credentials at `~/.cloudflared/<TUNNEL_ID>.json`
- Display the tunnel ID (save this!)

### Step 3: Create Configuration File

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: 0d2577f8-b7f6-4839-a22a-990529fe9dac  # Your tunnel ID
credentials-file: /Users/jackblanc/.cloudflared/0d2577f8-b7f6-4839-a22a-990529fe9dac.json

ingress:
  - hostname: linear-webhook.yourdomain.com
    service: http://linear-webhook:3000
  - service: http_status:404
```

Replace:

- Tunnel ID with yours from step 2
- Username in the credentials path
- `yourdomain.com` with your actual domain

### Step 4: Configure Public Hostname in Dashboard

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Networks** > **Tunnels**
3. Click on your `linear-webhook` tunnel
4. Click **Configure** tab
5. In **Public Hostname** tab, click **Add a public hostname**:
   - **Subdomain**: `linear-webhook`
   - **Domain**: `yourdomain.com` (select from dropdown)
   - **Service Type**: HTTP
   - **URL**: `linear-webhook:3000`
6. Click **Save hostname**

### Step 5: Start Docker Compose

The `docker-compose.yml` is already configured to use your config file:

```bash
docker compose up -d
```

### Step 6: Verify Tunnel Connection

```bash
# Check cloudflared logs
docker compose logs -f cloudflared

# You should see:
# "Connection registered"
# "Registered tunnel connection"
```

## Configure Cloudflare Access for IP Allowlisting

Add IP-level access control to restrict webhook access to Linear's IPs only:

### Step 1: Create Access Application

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access** > **Applications**
3. Click **Add an application** > **Self-hosted**
4. Configure:
   - **Application name**: `Linear Webhook`
   - **Session duration**: 24 hours
   - **Application domain**: `linear-webhook.yourdomain.com`

### Step 2: Add Allow Policy

1. Click **Add a policy**
2. Configure:
   - **Policy name**: `Linear Webhook IPs`
   - **Action**: Allow
3. Under **Configure rules**:
   - Click **Add rule**
   - Select **IP ranges**
   - Add Linear's webhook IP addresses (one per line):

```
35.231.147.226
35.243.134.228
34.140.253.14
34.38.87.206
34.134.222.122
35.222.25.142
```

4. Click **Save policy**
5. Click **Save application**

Source: [Linear webhook documentation](https://linear.app/developers/webhooks)

## Update Linear Webhook Configuration

Configure your Linear webhook to use the tunnel URL:

1. Go to your Linear workspace **Settings** > **Integrations** > **Webhooks**
2. Create or update webhook with URL: `https://linear-webhook.yourdomain.com/webhook/linear`
3. The webhook secret should match `LINEAR_WEBHOOK_SECRET` in your `config.docker.json`

## Verification

### Test Tunnel Connection

```bash
# Check if tunnel is running
docker compose ps cloudflared

# View tunnel logs
docker compose logs -f cloudflared

# Test webhook endpoint (may be blocked by Access if not from Linear IPs)
curl https://linear-webhook.yourdomain.com/health
```

### Test from Linear

Trigger a test webhook from Linear to verify:

1. Webhook reaches your server
2. Cloudflare Access allows Linear's IPs
3. OpenCode sessions start correctly

## Troubleshooting

### Tunnel not connecting

**Check credentials path:**

```bash
# Verify files exist
ls -la ~/.cloudflared/config.yml
ls -la ~/.cloudflared/*.json
```

**Check config syntax:**

```bash
# Validate YAML syntax
cat ~/.cloudflared/config.yml
```

**View logs:**

```bash
docker compose logs cloudflared
```

### Cloudflare Access blocking all traffic

- Verify IP addresses are correctly configured in the Access policy
- Check that policy action is set to "Allow"
- Ensure application domain matches your tunnel hostname exactly

### Webhooks not received

- Verify Linear webhook URL is correct
- Check webhook signature in `config.docker.json`
- Review `linear-webhook` container logs:
  ```bash
  docker compose logs linear-webhook
  ```

## Security Layers

With this setup, you have multiple security layers:

1. **IP Allowlisting** - Only Linear's IPs can reach the webhook endpoint (Cloudflare Access)
2. **Webhook Signature Verification** - HMAC-SHA256 signature validation (Linear SDK)
3. **Organization ID Allowlist** - Only your Linear workspace can trigger actions
4. **Cloudflare DDoS Protection** - Built-in protection against attacks
5. **Session Isolation** - Each OpenCode session runs in isolated git worktree

## Files and Configuration

| File                                    | Description                      |
| --------------------------------------- | -------------------------------- |
| `~/.cloudflared/config.yml`             | Tunnel configuration             |
| `~/.cloudflared/<TUNNEL_ID>.json`       | Tunnel credentials (keep secret) |
| `docker-compose.yml`                    | Mounts config and credentials    |
| `config.docker.json`                    | Linear OAuth and webhook secrets |
| `.env`                                  | Environment variables (optional) |

## Alternative: Using Nix Environment

If you set up the Nix environment integration (`~/environment`), you can run the tunnel natively on macOS without Docker:

```bash
# Source environment
source ~/environment/.env.cloudflared

# Rebuild home-manager (enables launchd service)
cd ~/environment
home-manager switch
```

The tunnel will auto-start on login. See `~/environment/docs/cloudflare-tunnel.md` for details.
