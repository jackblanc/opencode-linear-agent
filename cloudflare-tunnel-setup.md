# Cloudflare Tunnel Setup Guide

This guide walks through setting up a Cloudflare Tunnel to expose the Linear webhook server publicly with IP allowlisting via Cloudflare Access.

## Prerequisites

- Cloudflare account with a domain managed by Cloudflare
- `cloudflared` CLI installed locally ([download here](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/))
- Docker and Docker Compose installed

## Step 1: Authenticate with Cloudflare

Run the following command to authenticate `cloudflared` with your Cloudflare account:

```bash
cloudflared tunnel login
```

This will open a browser window where you can authorize cloudflared to access your Cloudflare account.

## Step 2: Create a Tunnel

Create a new tunnel with a descriptive name:

```bash
cloudflared tunnel create linear-webhook
```

This will:

- Create a new tunnel in your Cloudflare account
- Generate a credentials file at `~/.cloudflared/<TUNNEL_ID>.json`
- Display the tunnel ID and credentials file path

**Save the tunnel ID** - you'll need it in the next step.

## Step 3: Get Your Tunnel Token

You can use either a token-based or file-based approach. For Docker Compose, we recommend the **token-based approach**:

### Option A: Token-Based (Recommended for Docker)

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Networks** > **Tunnels**
3. Find your `linear-webhook` tunnel
4. Click **Configure**
5. In the **Public Hostname** tab, click **Add a public hostname**:
   - **Subdomain**: `linear-webhook` (or your preferred subdomain)
   - **Domain**: Select your domain
   - **Service**: `http://linear-webhook:3000`
6. Save the configuration
7. Go back to the tunnel overview and copy the **tunnel token** from the install command

The token will look like: `eyJhIjoiY...` (a long base64-encoded string)

Add this to your `.env` file:

```bash
TUNNEL_TOKEN=eyJhIjoiY...
```

### Option B: File-Based (Alternative)

If you prefer using a credentials file instead:

1. Copy the credentials file to your project:

   ```bash
   cp ~/.cloudflared/<TUNNEL_ID>.json ./cloudflared-credentials.json
   ```

2. Create a `cloudflared-config.yml` file:

   ```yaml
   tunnel: <TUNNEL_ID>
   credentials-file: /etc/cloudflared/credentials.json

   ingress:
     - hostname: linear-webhook.yourdomain.com
       service: http://linear-webhook:3000
     - service: http_status:404 # Fallback rule (required)
   ```

3. Update `docker-compose.yml` to use the config file instead of token:
   ```yaml
   cloudflared:
     image: cloudflare/cloudflared:latest
     restart: unless-stopped
     command: tunnel --no-autoupdate --config /etc/cloudflared/config.yml run
     volumes:
       - ./cloudflared-config.yml:/etc/cloudflared/config.yml:ro
       - ./cloudflared-credentials.json:/etc/cloudflared/credentials.json:ro
     networks:
       - linear-agent
   ```

## Step 4: Configure Cloudflare Access for IP Allowlisting

Now that your tunnel is set up, add IP restrictions via Cloudflare Access:

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access** > **Applications**
3. Click **Add an application** > **Self-hosted**
4. Configure the application:
   - **Application name**: `Linear Webhook`
   - **Session duration**: 24 hours (or your preference)
   - **Application domain**: Select the domain and subdomain you configured (e.g., `linear-webhook.yourdomain.com`)

5. Add an **Allow** policy:
   - **Policy name**: `Linear Webhook IPs`
   - **Action**: Allow
   - **Configure rules**:
     - **Selector**: IP ranges
     - **Value**: Add Linear's webhook IP addresses (see below)

6. Save the policy

### Linear Webhook IP Addresses

Add these IP addresses to your Cloudflare Access policy:

```
35.231.147.226
35.243.134.228
34.140.253.14
34.38.87.206
34.134.222.122
35.222.25.142
```

**Note**: Linear may occasionally update this list. Check [Linear's webhook documentation](https://linear.app/developers/webhooks) periodically for updates.

### Additional Security (Optional)

You can add additional policies to strengthen security:

- **Service Tokens**: Generate a service token for additional authentication
- **Geolocation restrictions**: Restrict to specific countries
- **Device posture**: Require specific device configurations (if using Cloudflare WARP)

## Step 5: Update Linear Webhook Configuration

Update your Linear webhook URL to point to your Cloudflare Tunnel domain:

```
https://linear-webhook.yourdomain.com/webhook/linear
```

Configure this in your Linear workspace:

1. Go to **Settings** > **Integrations** > **Webhooks**
2. Create or update your webhook with the new URL
3. The webhook secret should match the `LINEAR_WEBHOOK_SECRET` in your `config.docker.json`

## Step 6: Start the Services

With your `TUNNEL_TOKEN` configured in `.env`, start the Docker Compose stack:

```bash
docker compose up -d
```

## Verification

Check that the tunnel is running and connected:

```bash
# View cloudflared logs
docker compose logs -f cloudflared

# You should see:
# "Connection <UUID> registered"
# "Registered tunnel connection"
```

Test the webhook endpoint:

```bash
curl https://linear-webhook.yourdomain.com/health
```

You should receive a response (or be blocked by Cloudflare Access if testing from an IP not in the allowlist).

## Troubleshooting

### Tunnel not connecting

- Verify `TUNNEL_TOKEN` is correct in `.env`
- Check cloudflared logs: `docker compose logs cloudflared`
- Ensure the tunnel is active in Cloudflare Dashboard

### Cloudflare Access blocking all traffic

- Verify IP addresses are correctly configured in the Access policy
- Check that the policy action is set to "Allow"
- Ensure the application domain matches your tunnel hostname

### Webhooks not received

- Verify Linear webhook URL is correct
- Check webhook signature verification in `config.docker.json`
- Review `linear-webhook` container logs: `docker compose logs linear-webhook`

## Security Layers

With this setup, you now have multiple security layers:

1. **IP Allowlisting** - Only Linear's IPs can reach the webhook endpoint
2. **Webhook Signature Verification** - HMAC-SHA256 signature validation
3. **Organization ID Allowlist** - Only your Linear workspace can trigger actions
4. **Cloudflare DDoS Protection** - Built-in protection against attacks

## Migrating from Tailscale Funnel

If you're migrating from the previous Tailscale Funnel setup:

1. Remove Tailscale-specific environment variables from `.env`:
   - `TS_AUTHKEY`
   - `TAILSCALE_HOSTNAME`

2. Add Cloudflare tunnel token:

   ```bash
   TUNNEL_TOKEN=eyJhIjoiY...
   ```

3. The `tailscale-serve.json` file is no longer needed and can be removed

4. Update Linear webhook URL from Tailscale domain to Cloudflare domain

5. Restart services: `docker compose down && docker compose up -d`
