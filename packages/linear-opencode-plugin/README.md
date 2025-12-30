# @linear-opencode/plugin

OpenCode plugin for Linear agent integration. Streams OpenCode activities, tool calls, and plans to Linear's agent UI in real-time.

## Installation

```bash
npm install @linear-opencode/plugin
# or
bun add @linear-opencode/plugin
```

## Usage

### With OpenCode Configuration

Add to your OpenCode configuration file:

```typescript
import { createLinearPlugin } from "@linear-opencode/plugin";

export default {
  plugins: [
    createLinearPlugin({
      // Optional: provide token directly (defaults to LINEAR_ACCESS_TOKEN env var)
      accessToken: process.env.LINEAR_ACCESS_TOKEN,
    }),
  ],
};
```

### Environment Variables

Set the Linear OAuth access token:

```bash
export LINEAR_ACCESS_TOKEN=lin_api_...
```

### Plugin Options

```typescript
interface LinearPluginOptions {
  // Linear OAuth access token (falls back to LINEAR_ACCESS_TOKEN env var)
  accessToken?: string;

  // Prefix for session titles to identify Linear sessions (default: "linear:")
  sessionPrefix?: string;

  // Max length of tool output before truncation (default: 500)
  maxResultLength?: number;

  // Enable debug logging (default: false)
  debug?: boolean;
}
```

## Features

### Activity Streaming

The plugin automatically streams OpenCode events to Linear:

- **Text responses** → `response` activities
- **Reasoning** → ephemeral `thought` activities
- **Tool calls** → `action` activities with results
- **Errors** → `error` activities

### Plan Synchronization

OpenCode todos are synced to Linear plans:

- `pending` → `pending`
- `in_progress` → `inProgress`
- `completed` → `completed`
- `cancelled` → `canceled`

## Session Mapping

The plugin identifies Linear sessions by the OpenCode session title format:

```
linear:{linearSessionId}
```

When creating an OpenCode session for a Linear agent request, set the title to include the Linear session ID:

```typescript
await client.session.create({
  body: {
    title: `linear:${linearSessionId}`,
  },
});
```

## License

MIT
