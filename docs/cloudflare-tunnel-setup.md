# Cloudflare Tunnel Setup

Use this guide to expose your local webhook server (`http://localhost:3210`) as a public HTTPS endpoint for Linear webhooks.

## Prerequisites

- Cloudflare account with a managed domain
- `cloudflared` installed ([downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/))
- Linear webhook already created or ready to create

## 1) Authenticate

```bash
cloudflared tunnel login
```

This opens a browser and stores certs in `~/.cloudflared/`.

## 2) Create tunnel

```bash
cloudflared tunnel create linear-webhook
```

This creates credentials at `~/.cloudflared/<TUNNEL_ID>.json`.

## 3) Configure tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: linear-webhook.yourdomain.com
    service: http://localhost:3210
  - service: http_status:404
```

Replace `<TUNNEL_ID>` and hostname.

## 4) Route DNS

```bash
cloudflared tunnel route dns linear-webhook linear-webhook.yourdomain.com
```

## 5) Run tunnel

Run in foreground (quick test):

```bash
cloudflared tunnel run linear-webhook
```

Or install as background service:

```bash
cloudflared service install
```

`cloudflared service install` creates a launchd service on macOS or systemd service on Linux.

## 6) Update app config

Set these values in your project `.env`:

- `PUBLIC_HOSTNAME=linear-webhook.yourdomain.com`
- `LINEAR_WEBHOOK_SECRET=<your webhook secret>`

Update Linear webhook URL to:

`https://linear-webhook.yourdomain.com/webhook/linear`

## Verification

```bash
# Local health
curl http://localhost:3210/health

# Public health
curl https://linear-webhook.yourdomain.com/health
```

Then send a Linear webhook test event and verify request logs in your webhook server.

## Troubleshooting

### Tunnel does not connect

```bash
ls -la ~/.cloudflared/config.yml
ls -la ~/.cloudflared/*.json
cloudflared tunnel list
```

### DNS not resolving

- Confirm DNS route command ran successfully
- Confirm hostname matches `config.yml`

### Webhooks not received

- Verify Linear webhook URL is correct
- Verify `LINEAR_WEBHOOK_SECRET` matches Linear
- Check webhook server logs

## Security Notes

- Keep `~/.cloudflared/<TUNNEL_ID>.json` private
- Keep `.env` and webhook secrets private
- Webhook signatures are still verified by the server

## References

- Linear webhooks: https://linear.app/developers/webhooks
- Cloudflare Tunnel docs: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
