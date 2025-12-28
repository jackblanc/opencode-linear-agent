# Linear OpenCode Agent

An AI coding agent for Linear task management, powered by OpenCode and running on Cloudflare Workers with Sandbox containers.

## Features

- **OpenCode Web UI**: Full browser-based AI coding experience
- **Programmatic API**: Create and manage coding sessions via REST API
- **Cloudflare Sandbox Integration**: Secure, isolated code execution environment
- **Linear Integration Ready**: Built to manage Linear tasks automatically

## How It Works

This worker integrates OpenCode (AI coding agent) with Cloudflare's Sandbox SDK, providing:

1. **Web UI Access** (`/`) - Full OpenCode interface for interactive coding
2. **Session API** (`/api/session`) - Programmatic session creation
3. **Example Endpoints** (`/run`, `/file`) - Sandbox demonstration

## Architecture

- **Cloudflare Worker**: Handles HTTP requests and proxies to OpenCode
- **Sandbox Container**: Runs OpenCode server with pre-installed CLI
- **Anthropic Claude**: Powers the AI coding capabilities
- **Linear API**: (Coming soon) Task management integration

## Setup

### Prerequisites

- [Bun](https://bun.sh) or Node.js installed
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI
- Anthropic API key

### Installation

1. Install dependencies:

```bash
bun install
```

2. Create a `.dev.vars` file:

```bash
cp .dev.vars.example .dev.vars
```

3. Add your Anthropic API key to `.dev.vars`:

```env
ANTHROPIC_API_KEY=your_actual_api_key_here
```

### Local Development

```bash
bun run dev
```

The first run will build the Docker container (2-3 minutes). Subsequent runs are faster.

Once running, access:

- OpenCode UI: http://localhost:8787/
- Session API: http://localhost:8787/api/session

## API Endpoints

### OpenCode Web UI

```bash
GET http://localhost:8787/
```

Access the full OpenCode web interface for AI-powered coding.

### Create Session (Programmatic)

```bash
GET http://localhost:8787/api/session
```

Returns:

```json
{
  "sessionId": "...",
  "title": "Linear Agent Task"
}
```

### Example: Execute Command

```bash
GET http://localhost:8787/run
```

### Example: File Operations

```bash
GET http://localhost:8787/file
```

## Deployment

### Set Production Secrets

```bash
wrangler secret put ANTHROPIC_API_KEY
```

### Deploy

```bash
bun run deploy
```

After first deployment, wait 2-3 minutes for container provisioning.

## Project Structure

```
├── src/
│   └── index.ts           # Main worker with OpenCode integration
├── Dockerfile             # OpenCode-enabled Sandbox container
├── wrangler.jsonc         # Cloudflare Workers configuration
├── .dev.vars.example      # Environment variable template
└── package.json           # Dependencies including @opencode-ai/sdk
```

## How OpenCode Integration Works

The integration uses the Cloudflare Sandbox SDK's OpenCode support:

1. **Container**: Custom Docker image with OpenCode CLI pre-installed
2. **Server**: `createOpencodeServer()` manages the OpenCode process
3. **Proxy**: `proxyToOpencode()` routes web requests to the OpenCode UI
4. **SDK**: `createOpencode()` provides programmatic access

See [Cloudflare Sandbox OpenCode docs](https://github.com/cloudflare/sandbox-sdk/pull/282) for more details.

## Updating

To update dependencies and Docker images, see [UPDATING.md](./UPDATING.md) for detailed instructions.

Quick update:
```bash
# Update all dependencies
bun update

# Don't forget to update Dockerfile version to match!
# Example: FROM docker.io/cloudflare/sandbox:0.6.8-opencode
```

## Next Steps

- [ ] Implement Linear API integration
- [ ] Add webhook handlers for Linear events
- [ ] Create automated task workflows
- [ ] Add authentication and authorization

## References

- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [OpenCode Documentation](https://opencode.ai/docs)
- [Linear API](https://developers.linear.app/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
