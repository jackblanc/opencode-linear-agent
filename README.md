# Linear OpenCode Agent

An AI coding agent for Linear task management, powered by OpenCode and running on Cloudflare Workers with Sandbox containers.

## Features

- **Linear Agent Mode Integration**: Respond to agent delegations and @mentions in Linear
- **Real-time Streaming**: Stream OpenCode's work progress directly to Linear activities
- **Repository Cloning**: Automatically clone GitHub repos for context
- **Session Persistence**: Maintain conversation history across multiple interactions
- **Agent Plans**: Sync OpenCode's todo list to Linear's agent plans
- **Stop Signal Support**: Handle user requests to halt work gracefully
- **Cloudflare Sandbox Integration**: Secure, isolated code execution environment

## How It Works

When a user delegates an issue or mentions the agent in Linear:

1. **Webhook Received**: Linear sends `AgentSessionEvent` to `/webhook/linear`
2. **Immediate Acknowledgment**: Agent responds within 10 seconds (per Linear requirements)
3. **Repository Setup**: Clones the target repo into a sandboxed environment
4. **OpenCode Session**: Creates or resumes an OpenCode session for the Linear conversation
5. **Real-time Streaming**: OpenCode's work is streamed as Linear activities:
   - Thoughts (ephemeral) - Internal reasoning and planning
   - Actions - Tool invocations (file reads, edits, bash commands)
   - Responses - Final outputs and summaries
   - Errors - Failures and error messages
6. **Plan Updates**: OpenCode's todo list syncs to Linear's agent plan UI
7. **Conversation History**: Follow-up prompts continue the same OpenCode session

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           LINEAR                                        │
│  User delegates/mentions agent → AgentSessionEvent webhook              │
│  ← AgentActivity (thought/action/response/error/elicitation)            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE WORKER (webhook.ts)                       │
│                                                                         │
│  1. Receive AgentSessionEvent                                           │
│  2. Get/Create Sandbox (keyed by Linear agentSession.id)                │
│  3. Clone repo into sandbox (https://github.com/sst/opencode)           │
│  4. Create/Resume OpenCode session                                      │
│  5. Forward promptContext to OpenCode                                   │
│  6. Stream OpenCode Parts → Linear AgentActivity                        │
│  7. Sync todos to agent plan                                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE SANDBOX (Durable Object)                  │
│                                                                         │
│  - OpenCode server running inside container                             │
│  - Project cloned to /home/user/project                                 │
│  - Session persisted across interactions                                │
└─────────────────────────────────────────────────────────────────────────┘
```

**Components:**

- **Cloudflare Worker**: Handles webhooks and manages OpenCode integration
- **Sandbox Container**: Runs OpenCode server with pre-installed CLI
- **Anthropic Claude**: Powers the AI coding capabilities via OpenCode
- **Linear SDK**: Sends agent activities and updates plans
- **KV Storage**: Persists session state between interactions

## Setup

### Prerequisites

- [Bun](https://bun.sh) or Node.js installed
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI
- Anthropic API key
- Linear OAuth app credentials
- GitHub token (for cloning repos)

### Installation

1. Install dependencies:

```bash
bun install
```

2. Create a `.dev.vars` file:

```bash
cp .dev.vars.example .dev.vars
```

3. Configure your `.dev.vars` file with required secrets:

```env
# Anthropic API key for OpenCode
ANTHROPIC_API_KEY=sk-ant-...

# Linear OAuth Config
LINEAR_CLIENT_ID=lin_api_...
LINEAR_CLIENT_SECRET=lin_api_...

# Linear webhook secret (get from Linear app settings)
LINEAR_WEBHOOK_SECRET=...

# GitHub token for cloning repos
GITHUB_TOKEN=ghp_...
```

### Setting Up Linear OAuth App

1. Go to [Linear Settings → API](https://linear.app/settings/api)
2. Create a new OAuth application
3. Set the callback URL to `https://your-worker.workers.dev/oauth/callback`
4. Enable **Agent Session Events** in webhook categories
5. Copy the client ID, secret, and webhook secret to `.dev.vars`

### Local Development

```bash
bun run dev
```

The first run will build the Docker container (2-3 minutes). Subsequent runs are faster.

Once running, the worker will be available at `http://localhost:8787`

## Endpoints

### OAuth Flow

```bash
GET /oauth/authorize
# Initiates OAuth flow to connect Linear workspace

GET /oauth/callback
# Handles OAuth callback from Linear
```

### Webhooks

```bash
POST /webhook/linear
# Receives AgentSessionEvent webhooks from Linear
# Automatically handles agent delegations and mentions
```

### Health Check

```bash
GET /health
# Returns worker health status
```

## Usage

### 1. Connect Linear Workspace

1. Navigate to `https://your-worker.workers.dev/oauth/authorize`
2. Authorize the app with your Linear workspace
3. You'll be redirected back after authorization

### 2. Configure Linear Webhook

1. In Linear app settings, set webhook URL to:
   ```
   https://your-worker.workers.dev/webhook/linear
   ```
2. Ensure **Agent Session Events** category is enabled

### 3. Use the Agent

In Linear, you can now:

- **Delegate an issue** to the agent
- **@mention the agent** in issue comments
- **Send follow-up prompts** to continue the conversation
- **Request stop** to halt ongoing work

The agent will:

- Clone the repository (currently using `https://github.com/sst/opencode` as placeholder)
- Analyze the issue context
- Stream its work progress as Linear activities
- Update its plan as it works
- Respond to your messages in real-time

## Deployment

### Set Production Secrets

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put LINEAR_CLIENT_ID
wrangler secret put LINEAR_CLIENT_SECRET
wrangler secret put LINEAR_WEBHOOK_SECRET
wrangler secret put GITHUB_TOKEN
```

### Create KV Namespaces

```bash
# Create KV namespace for Linear tokens
wrangler kv:namespace create LINEAR_TOKENS

# Create KV namespace for OAuth states
wrangler kv:namespace create OAUTH_STATES
```

Update `wrangler.jsonc` with the namespace IDs.

### Deploy

```bash
bun run deploy
```

After first deployment, wait 2-3 minutes for container provisioning.

## Project Structure

```
├── src/
│   ├── index.ts           # Main worker entry point
│   ├── webhook.ts         # Linear webhook handler & OpenCode integration
│   ├── oauth.ts           # Linear OAuth flow handlers
│   ├── mapping.ts         # OpenCode Part → Linear Activity mapping
│   └── types.ts           # Type definitions and utilities
├── Dockerfile             # OpenCode-enabled Sandbox container
├── wrangler.jsonc         # Cloudflare Workers configuration
├── .dev.vars.example      # Environment variable template
├── AGENTS.md              # Agent guidelines for AI assistants
└── package.json           # Dependencies
```

## How It Works

### OpenCode → Linear Activity Mapping

| OpenCode Part Type     | Linear Activity Type   | Ephemeral | Description        |
| ---------------------- | ---------------------- | --------- | ------------------ |
| `TextPart`             | `response`             | No        | Final AI output    |
| `ReasoningPart`        | `thought`              | Yes       | Internal reasoning |
| `ToolPart` (running)   | `action` (no result)   | Yes       | Tool in progress   |
| `ToolPart` (completed) | `action` (with result) | No        | Tool finished      |
| `ToolPart` (error)     | `error`                | No        | Tool failed        |
| `StepStartPart`        | `thought`              | Yes       | Starting work      |
| `SubtaskPart`          | `thought`              | No        | Delegating subtask |

### Tool Name Mapping

| OpenCode Tool | Linear Action          | Parameter Example  |
| ------------- | ---------------------- | ------------------ |
| `Read`        | "Reading" / "Read"     | `src/index.ts`     |
| `Edit`        | "Editing" / "Edited"   | `src/webhook.ts`   |
| `Write`       | "Creating" / "Created" | `new-file.ts`      |
| `Bash`        | "Running" / "Ran"      | `npm install`      |
| `Glob`        | "Searching files"      | `**/*.ts`          |
| `Grep`        | "Searching code"       | `function.*export` |
| `Task`        | "Delegating task"      | Task description   |

### Session Lifecycle

1. **Create Action** (`AgentSessionEvent.action = "create"`):
   - Create Cloudflare Sandbox with Linear session ID
   - Clone repository into `/home/user/project`
   - Initialize OpenCode with Anthropic provider
   - Create new OpenCode session
   - Send initial prompt with full issue context
   - Stream responses as Linear activities

2. **Prompted Action** (`AgentSessionEvent.action = "prompted"`):
   - Resume existing OpenCode session
   - Check for stop signal
   - Send user's message to OpenCode
   - Stream responses as Linear activities
   - Update agent plan from OpenCode todos

## Updating

To update dependencies and Docker images, see [UPDATING.md](./UPDATING.md) for detailed instructions.

Quick update:

```bash
# Update all dependencies
bun update

# Don't forget to update Dockerfile version to match!
# Example: FROM docker.io/cloudflare/sandbox:0.6.8-opencode
```

## Current Limitations & Future Work

- **Repository**: Currently hardcoded to `https://github.com/sst/opencode`
  - [ ] Make repository dynamic based on Linear issue context
  - [ ] Support multiple repos per workspace
- **Authentication**: Basic OAuth flow implemented
  - [ ] Add user-specific scopes and permissions
  - [ ] Implement token refresh
- **Error Handling**: Basic error reporting
  - [ ] Improve error recovery and retry logic
  - [ ] Better timeout handling for long-running operations
- **Performance**: First interaction clones repo
  - [ ] Cache cloned repos between sessions
  - [ ] Implement incremental updates (git pull)
- **Features**:
  - [ ] Support file attachments from Linear issues
  - [ ] Implement agent signals (auth, select)
  - [ ] Add MCP server integration for Linear context
  - [ ] Support multi-turn planning mode

## References

- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [OpenCode Documentation](https://opencode.ai/docs)
- [Linear API](https://developers.linear.app/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
