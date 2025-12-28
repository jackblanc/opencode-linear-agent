# Linear OpenCode Agent - Implementation Plan

## Project Overview

Build a self-hosted Cloudflare Workers agent that integrates Linear's Agent API with OpenCode to automatically work on Linear issues by cloning GitHub repositories and executing coding tasks in isolated sandbox containers.

**Key Characteristics**:
- Self-hosted (users deploy their own instance)
- Open source
- One deployment per Linear workspace
- Secure by default
- Easy to configure and debug

---

## Architecture

```
Linear Issue (delegated to agent or @mentioned)
    ↓ webhook (AgentSessionEvent)
Cloudflare Worker (webhook receiver, verifies signature)
    ↓ creates/retrieves
Durable Object (one per agentSessionId)
    ↓ clones repo
Sandbox Container (isolated environment with git checkout)
    ↓ starts OpenCode
OpenCode (AI coding assistant in cloned repo)
    ↓ performs tasks, emits progress
Linear Agent Activities (thoughts, actions, responses)
    ↓ displayed in Linear UI
User (sees real-time progress in Linear)
```

---

## Phase 1: OAuth & Webhook Infrastructure

**Goal**: Authenticate with Linear and receive webhooks securely

### Tasks

#### 1.1 Linear OAuth Application Setup
- Document setup process in README
- App configuration:
  - Name: "OpenCode Agent" (user customizable)
  - OAuth URL with `actor=app` parameter
  - Scopes: `write`, `app:mentionable`, `app:assignable`
  - Webhook category: **Agent session events**
  - Webhook URL: `https://<worker-url>/webhook/linear`

#### 1.2 OAuth Flow Implementation (`src/oauth.ts`)
- `GET /oauth/authorize` - Redirect to Linear OAuth
  - Build authorization URL with required scopes
  - Include state parameter for CSRF protection
  
- `GET /oauth/callback` - Handle OAuth callback
  - Verify state parameter
  - Exchange authorization code for access token
  - Store token in Cloudflare KV with workspace ID as key
  - Query Linear for app viewer ID:
    ```graphql
    query Me {
      viewer {
        id
        name
      }
    }
    ```
  - Redirect to success page with setup instructions

- Token storage in KV:
  ```typescript
  // Key: workspace_id
  // Value: { accessToken, appId, installedAt, workspaceName }
  ```

#### 1.3 Webhook Endpoint (`src/webhook.ts`)
- `POST /webhook/linear` - Receive Linear webhooks
  
- Webhook signature verification:
  - Verify HMAC signature using webhook secret
  - Reject invalid signatures (security requirement)
  - Log verification failures for debugging
  
- Parse webhook payload:
  - Extract `action` (`created` or `prompted`)
  - Extract `agentSessionId`
  - Extract workspace identifier
  - Type-safe parsing with error handling
  
- Route to Durable Object:
  - Use `agentSessionId` as DO ID
  - Create new DO for `created` events
  - Retrieve existing DO for `prompted` events

#### 1.4 Environment Configuration
Update `wrangler.jsonc`:
```jsonc
{
  "name": "linear-opencode-agent",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-01",
  "durable_objects": {
    "bindings": [
      {
        "name": "AGENT_SESSIONS",
        "class_name": "AgentSession",
        "script_name": "linear-opencode-agent"
      }
    ]
  },
  "kv_namespaces": [
    {
      "binding": "LINEAR_TOKENS",
      "id": "<create-kv-namespace>"
    }
  ]
}
```

Environment variables (`.dev.vars` and secrets):
```bash
ANTHROPIC_API_KEY=sk-ant-...
LINEAR_WEBHOOK_SECRET=<from-linear-app-settings>
LINEAR_CLIENT_ID=<from-linear-app-settings>
LINEAR_CLIENT_SECRET=<from-linear-app-settings>
GITHUB_TOKEN=ghp_... # optional, for private repos
OAUTH_CALLBACK_URL=https://your-worker.workers.dev/oauth/callback
```

### Deliverables

**Files**:
- `src/index.ts` - Main worker entry point with routing
- `src/oauth.ts` - OAuth flow handlers
- `src/webhook.ts` - Webhook verification and parsing
- `src/types/linear.ts` - Linear API type definitions
- `src/types/webhook.ts` - Webhook payload types
- Updated `wrangler.jsonc` - DO and KV bindings
- Updated `.dev.vars.example` - Environment variable template

**Infrastructure**:
- KV namespace created for token storage
- Secrets configured in production

**Documentation**:
- README section: "Setting up your Linear OAuth App"
- README section: "Deploying to Cloudflare"
- README section: "Configuring Environment Variables"

### Testing

- OAuth flow completes successfully
- Access token stored in KV
- Webhook signature verification works
- Invalid signatures rejected
- Webhook payload parsed correctly
- Durable Object created for new sessions

### Time Estimate
**3-4 hours**

---

## Phase 2: Session Management & Repository Detection

**Goal**: Create persistent sessions and determine which repo to work with

### Tasks

#### 2.1 Durable Object Implementation (`src/session.ts`)

Session state structure:
```typescript
interface SessionState {
  agentSessionId: string;
  linearIssueId: string;
  linearIssueIdentifier: string; // e.g., "ENG-123"
  linearIssueTitle: string;
  linearIssueDescription: string;
  repoUrl: string | null;
  repoCloned: boolean;
  opencodeSessionId: string | null;
  status: 'initializing' | 'cloning' | 'running' | 'completed' | 'error';
  createdAt: number;
  lastActivityAt: number;
}
```

Implement `AgentSession` class:
- `fetch(request)` - Handle messages from worker
- `handleCreated(webhook)` - Process new session
- `handlePrompted(webhook)` - Process follow-up message
- State persistence using `this.ctx.storage`
- Alarm for session timeout (30 min inactivity)

Session lifecycle:
```typescript
async handleCreated(webhook: AgentSessionEvent) {
  // 1. Initialize state
  await this.initializeState(webhook);
  
  // 2. Send immediate acknowledgment (within 10 seconds)
  await this.sendActivity({
    type: "thought",
    body: `Starting work on ${webhook.issue.identifier}: ${webhook.issue.title}`
  });
  
  // 3. Detect repository
  const repoUrl = await this.detectRepository(webhook);
  
  // 4. If no repo found, ask user
  if (!repoUrl) {
    await this.sendActivity({
      type: "elicitation",
      body: "Which GitHub repository should I work with? Please provide a URL like https://github.com/owner/repo"
    });
    return;
  }
  
  // 5. Clone and start OpenCode
  await this.cloneAndStart(repoUrl);
}

async handlePrompted(webhook: AgentSessionEvent) {
  const userMessage = webhook.agentActivity.body;
  
  // If waiting for repo URL, try to extract it
  if (!this.state.repoUrl) {
    const repoUrl = extractRepoFromText(userMessage);
    if (repoUrl) {
      await this.cloneAndStart(repoUrl);
      return;
    }
  }
  
  // Otherwise, forward to OpenCode
  await this.forwardToOpenCode(userMessage);
}
```

#### 2.2 Repository Detection (`src/repo-detection.ts`)

Implement multi-source detection:

```typescript
async function detectRepository(webhook: AgentSessionEvent): Promise<string | null> {
  // Priority 1: Check issue attachments (existing GitHub PRs)
  const attachments = webhook.issue.attachments || [];
  for (const attachment of attachments) {
    if (attachment.sourceType === 'github') {
      const repoUrl = extractRepoFromGitHubUrl(attachment.url);
      if (repoUrl) return repoUrl;
    }
  }
  
  // Priority 2: Check guidance field (workspace/team config)
  if (webhook.guidance) {
    const repoUrl = extractRepoFromText(webhook.guidance);
    if (repoUrl) return repoUrl;
  }
  
  // Priority 3: Check issue description
  if (webhook.issue.description) {
    const repoUrl = extractRepoFromText(webhook.issue.description);
    if (repoUrl) return repoUrl;
  }
  
  // Priority 4: Check triggering comment
  if (webhook.comment?.body) {
    const repoUrl = extractRepoFromText(webhook.comment.body);
    if (repoUrl) return repoUrl;
  }
  
  // Priority 5: Return null, will trigger elicitation
  return null;
}
```

URL extraction patterns:
```typescript
function extractRepoFromText(text: string): string | null {
  // Match: https://github.com/owner/repo
  // Match: github.com/owner/repo
  // Match: https://github.com/owner/repo/pull/123
  // Match: https://github.com/owner/repo/issues/456
  // Extract owner/repo and return canonical URL
  
  const patterns = [
    /github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const [, owner, repo] = match;
      // Clean up repo name (remove .git, /pull/123, etc.)
      const cleanRepo = repo.replace(/\.git$/, '').replace(/\/(pull|issues|tree|blob)\/.*$/, '');
      return `https://github.com/${owner}/${cleanRepo}`;
    }
  }
  
  return null;
}
```

#### 2.3 Linear API Client (`src/linear-client.ts`)

Wrapper for Linear API calls:
```typescript
class LinearClient {
  constructor(private accessToken: string);
  
  async createActivity(
    agentSessionId: string,
    content: ActivityContent,
    options?: { ephemeral?: boolean }
  ): Promise<AgentActivity>;
  
  async updateSession(
    agentSessionId: string,
    input: AgentSessionUpdateInput
  ): Promise<void>;
  
  async getIssue(issueId: string): Promise<Issue>;
}
```

Activity creation with error handling:
```typescript
async createActivity(sessionId: string, content: ActivityContent) {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': this.accessToken,
    },
    body: JSON.stringify({
      query: `
        mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) {
            success
            agentActivity { id }
          }
        }
      `,
      variables: {
        input: {
          agentSessionId: sessionId,
          content: content,
        },
      },
    }),
  });
  
  const result = await response.json();
  
  if (result.errors) {
    throw new LinearAPIError(result.errors);
  }
  
  return result.data.agentActivityCreate.agentActivity;
}
```

### Deliverables

**Files**:
- `src/session.ts` - Durable Object implementation
- `src/repo-detection.ts` - Repository detection logic
- `src/linear-client.ts` - Linear API wrapper
- `src/types/session.ts` - Session state types
- `src/types/activities.ts` - Activity type definitions
- `src/utils/url.ts` - URL parsing utilities

**Features**:
- Sessions persist across requests
- Repository detection from multiple sources
- Elicitation when repo not found
- Clean error handling

### Testing

- Session state persists correctly
- Repo URLs extracted from various formats
- Elicitation sent when no repo found
- User response parsed for repo URL
- Activities created successfully in Linear

### Time Estimate
**4-5 hours**

---

## Phase 3: Sandbox, Git Clone & OpenCode

**Goal**: Clone repository and start OpenCode with Linear context

### Tasks

#### 3.1 Sandbox Management (`src/sandbox.ts`)

Sandbox initialization:
```typescript
async function initializeSandbox(
  env: Env,
  sessionId: string
): Promise<Sandbox> {
  const sandbox = getSandbox(env.Sandbox, sessionId);
  
  // Ensure project directory exists
  await sandbox.exec('mkdir -p /home/user/project');
  
  return sandbox;
}
```

Repository cloning:
```typescript
async function cloneRepository(
  sandbox: Sandbox,
  repoUrl: string,
  githubToken?: string
): Promise<void> {
  // Add GitHub token for private repos
  const cloneUrl = githubToken 
    ? repoUrl.replace('https://', `https://${githubToken}@`)
    : repoUrl;
  
  await sandbox.gitCheckout(cloneUrl, {
    targetDir: '/home/user/project',
    depth: 1, // shallow clone for speed
  });
}
```

Error handling for common failures:
```typescript
async function cloneWithRetry(
  sandbox: Sandbox,
  repoUrl: string,
  githubToken?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await cloneRepository(sandbox, repoUrl, githubToken);
    return { success: true };
  } catch (error) {
    // Handle specific error cases
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    if (errorMsg.includes('not found') || errorMsg.includes('404')) {
      return { 
        success: false, 
        error: 'Repository not found. Please check the URL and ensure the repository exists.' 
      };
    }
    
    if (errorMsg.includes('permission denied') || errorMsg.includes('403')) {
      return { 
        success: false, 
        error: 'Permission denied. This repository is private. Please add a GITHUB_TOKEN to your environment variables.' 
      };
    }
    
    if (errorMsg.includes('timeout')) {
      return { 
        success: false, 
        error: 'Clone timeout. The repository may be too large. Try a smaller repository first.' 
      };
    }
    
    // Generic error
    return { 
      success: false, 
      error: `Failed to clone repository: ${errorMsg}` 
    };
  }
}
```

#### 3.2 OpenCode Integration (`src/opencode.ts`)

Start OpenCode server:
```typescript
async function startOpenCode(
  sandbox: Sandbox,
  anthropicApiKey: string
): Promise<OpencodeClient> {
  const { client } = await createOpencode<OpencodeClient>(sandbox, {
    directory: '/home/user/project',
    config: {
      provider: {
        anthropic: {
          options: {
            apiKey: anthropicApiKey,
          },
        },
      },
    },
  });
  
  return client;
}
```

Create OpenCode session with Linear context:
```typescript
async function createOpencodeSession(
  client: OpencodeClient,
  issueContext: IssueContext
): Promise<string> {
  const session = await client.session.create({
    body: { 
      title: `${issueContext.identifier}: ${issueContext.title}`,
    },
  });
  
  if (!session.data) {
    throw new Error('Failed to create OpenCode session');
  }
  
  return session.data.id;
}
```

Build initial prompt:
```typescript
function buildInitialPrompt(webhook: AgentSessionEvent): string {
  const { issue, comment, previousComments, guidance } = webhook;
  
  const parts = [
    `You are working on Linear issue ${issue.identifier}: ${issue.title}`,
    '',
    'Description:',
    issue.description || '(No description provided)',
  ];
  
  if (comment?.body) {
    parts.push('', 'Latest comment:', comment.body);
  }
  
  if (previousComments && previousComments.length > 0) {
    parts.push('', 'Previous discussion:');
    for (const c of previousComments) {
      parts.push(`- ${c.user.name}: ${c.body}`);
    }
  }
  
  if (guidance) {
    parts.push('', 'Team guidance:', guidance);
  }
  
  parts.push(
    '',
    'Please analyze the codebase and propose a solution.',
    'Be thorough but concise in your analysis.'
  );
  
  return parts.join('\n');
}
```

Send message and handle response:
```typescript
async function sendMessage(
  client: OpencodeClient,
  sessionId: string,
  message: string
): Promise<string> {
  const response = await client.session.message.create(sessionId, {
    body: {
      role: 'user',
      content: message,
    },
  });
  
  if (!response.data) {
    throw new Error('No response from OpenCode');
  }
  
  return response.data.content;
}
```

#### 3.3 Activity Emission Flow

Implement the full clone → OpenCode → response flow:

```typescript
async cloneAndStart(repoUrl: string) {
  // 1. Update state
  this.state.repoUrl = repoUrl;
  this.state.status = 'cloning';
  await this.saveState();
  
  // 2. Send cloning activity
  await this.sendActivity({
    type: 'action',
    action: 'Cloning repository',
    parameter: repoUrl,
  });
  
  // 3. Get sandbox
  const sandbox = await initializeSandbox(this.env, this.sessionId);
  
  // 4. Clone repository
  const cloneResult = await cloneWithRetry(sandbox, repoUrl, this.env.GITHUB_TOKEN);
  
  if (!cloneResult.success) {
    this.state.status = 'error';
    await this.saveState();
    
    await this.sendActivity({
      type: 'error',
      body: cloneResult.error!,
    });
    return;
  }
  
  // 5. Send clone success
  await this.sendActivity({
    type: 'action',
    action: 'Cloned repository',
    parameter: repoUrl,
    result: '✓ Repository ready',
  });
  
  // 6. Start OpenCode
  this.state.status = 'running';
  await this.saveState();
  
  await this.sendActivity({
    type: 'thought',
    body: 'Starting OpenCode and analyzing the codebase...',
  });
  
  const opencodeClient = await startOpenCode(sandbox, this.env.ANTHROPIC_API_KEY);
  
  // 7. Create OpenCode session
  const opencodeSessionId = await createOpencodeSession(opencodeClient, {
    identifier: this.state.linearIssueIdentifier,
    title: this.state.linearIssueTitle,
  });
  
  this.state.opencodeSessionId = opencodeSessionId;
  await this.saveState();
  
  // 8. Send initial prompt
  const prompt = buildInitialPrompt(this.initialWebhook);
  const response = await sendMessage(opencodeClient, opencodeSessionId, prompt);
  
  // 9. Send final response
  await this.sendActivity({
    type: 'response',
    body: response,
  });
  
  this.state.status = 'completed';
  await this.saveState();
}
```

### Deliverables

**Files**:
- `src/sandbox.ts` - Sandbox initialization and git operations
- `src/opencode.ts` - OpenCode client management
- `src/context.ts` - Prompt building from Linear data
- `src/errors.ts` - Error types and handlers

**Features**:
- Successful repository cloning
- OpenCode starts in cloned repo
- Context-rich prompts sent to OpenCode
- Activities emitted at each step
- Clear error messages for failures

### Testing

- Public repos clone successfully
- Private repos clone with GITHUB_TOKEN
- Clone errors handled gracefully
- OpenCode starts correctly
- Initial prompt contains all Linear context
- Response returned to Linear

### Time Estimate
**4-5 hours**

---

## Phase 4: Follow-up Messages & Session Continuity

**Goal**: Handle user follow-up prompts and maintain conversation state

### Tasks

#### 4.1 Message Forwarding

Handle `prompted` webhooks:
```typescript
async forwardToOpenCode(userMessage: string) {
  if (!this.state.opencodeSessionId) {
    await this.sendActivity({
      type: 'error',
      body: 'Session not initialized. Please start a new session.',
    });
    return;
  }
  
  // Send thinking indicator
  await this.sendActivity({
    type: 'thought',
    body: 'Processing your message...',
  }, { ephemeral: true });
  
  // Get OpenCode client
  const sandbox = getSandbox(this.env.Sandbox, this.sessionId);
  const opencodeClient = await startOpenCode(sandbox, this.env.ANTHROPIC_API_KEY);
  
  // Send user message to existing session
  const response = await sendMessage(
    opencodeClient,
    this.state.opencodeSessionId,
    userMessage
  );
  
  // Send response back to Linear
  await this.sendActivity({
    type: 'response',
    body: response,
  });
  
  // Update last activity timestamp
  this.state.lastActivityAt = Date.now();
  await this.saveState();
}
```

#### 4.2 Session Timeout Handling

Implement alarm for inactivity timeout:
```typescript
class AgentSession extends DurableObject {
  async alarm() {
    const now = Date.now();
    const inactiveMs = now - this.state.lastActivityAt;
    const timeoutMs = 30 * 60 * 1000; // 30 minutes
    
    if (inactiveMs > timeoutMs) {
      await this.sendActivity({
        type: 'response',
        body: 'Session timed out due to inactivity. Please start a new session if you need further assistance.',
      });
      
      this.state.status = 'completed';
      await this.saveState();
    } else {
      // Re-arm alarm for remaining time
      const remainingMs = timeoutMs - inactiveMs;
      await this.ctx.storage.setAlarm(now + remainingMs);
    }
  }
  
  private async resetTimeout() {
    // Set alarm for 30 minutes from now
    const timeoutMs = 30 * 60 * 1000;
    await this.ctx.storage.setAlarm(Date.now() + timeoutMs);
  }
}
```

#### 4.3 State Recovery

Handle DO hibernation/wake-up:
```typescript
async fetch(request: Request): Promise<Response> {
  // Load state from storage
  const state = await this.ctx.storage.get<SessionState>('state');
  
  if (!state) {
    // New session
    this.state = this.createInitialState();
  } else {
    // Existing session
    this.state = state;
  }
  
  // Handle request
  const body = await request.json();
  
  if (body.action === 'created') {
    await this.handleCreated(body.webhook);
  } else if (body.action === 'prompted') {
    await this.handlePrompted(body.webhook);
  }
  
  return new Response('OK');
}
```

### Deliverables

**Files**:
- Updated `src/session.ts` - Follow-up handling and timeouts
- `src/state.ts` - State management utilities

**Features**:
- Follow-up messages forwarded to OpenCode
- Conversation continuity maintained
- Session timeouts after inactivity
- State persists across DO hibernation

### Testing

- User can send follow-up messages
- OpenCode receives and responds to follow-ups
- Session times out after 30 min inactivity
- State recovered after DO wake-up

### Time Estimate
**2-3 hours**

---

## Phase 5: Error Handling & User-Friendly Messages

**Goal**: Graceful failures with helpful error messages for self-hosted users

### Tasks

#### 5.1 Error Type Definitions (`src/errors.ts`)

```typescript
export class LinearAPIError extends Error {
  constructor(
    message: string,
    public code?: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'LinearAPIError';
  }
}

export class RepositoryCloneError extends Error {
  constructor(
    message: string,
    public repoUrl: string,
    public reason: 'not_found' | 'permission_denied' | 'timeout' | 'unknown'
  ) {
    super(message);
    this.name = 'RepositoryCloneError';
  }
}

export class OpenCodeError extends Error {
  constructor(message: string, public details?: unknown) {
    super(message);
    this.name = 'OpenCodeError';
  }
}
```

#### 5.2 Retry Logic (`src/retry.ts`)

```typescript
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    shouldRetry?: (error: unknown) => boolean;
  }
): Promise<T> {
  let lastError: unknown;
  let delayMs = options.initialDelayMs;
  
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Check if we should retry
      if (options.shouldRetry && !options.shouldRetry(error)) {
        throw error;
      }
      
      // Last attempt, throw error
      if (attempt === options.maxRetries) {
        throw error;
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delayMs));
      
      // Exponential backoff
      delayMs = Math.min(delayMs * 2, options.maxDelayMs);
    }
  }
  
  throw lastError;
}

// Helper for Linear API calls
export async function retryLinearAPI<T>(fn: () => Promise<T>): Promise<T> {
  return retryWithBackoff(fn, {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    shouldRetry: (error) => {
      // Retry on rate limits and server errors
      if (error instanceof LinearAPIError) {
        return error.code === 'RATE_LIMITED' || error.code?.startsWith('5');
      }
      return false;
    },
  });
}
```

#### 5.3 User-Friendly Error Messages

Map technical errors to helpful messages:
```typescript
function formatErrorForUser(error: unknown): string {
  if (error instanceof RepositoryCloneError) {
    switch (error.reason) {
      case 'not_found':
        return `Repository not found: ${error.repoUrl}\n\nPlease check:\n- The repository exists\n- The URL is correct\n- The repository is public (or you've set GITHUB_TOKEN)`;
      
      case 'permission_denied':
        return `Permission denied for ${error.repoUrl}\n\nThis repository is private. To access it:\n1. Create a GitHub Personal Access Token with 'repo' scope\n2. Add it to your worker: wrangler secret put GITHUB_TOKEN\n3. Try again`;
      
      case 'timeout':
        return `Clone timeout for ${error.repoUrl}\n\nThe repository is too large. Try:\n- Using a smaller repository\n- Increasing the timeout in configuration`;
      
      default:
        return `Failed to clone ${error.repoUrl}: ${error.message}`;
    }
  }
  
  if (error instanceof OpenCodeError) {
    return `OpenCode error: ${error.message}\n\nThis may be a temporary issue. Please try:\n- Starting a new session\n- Checking your ANTHROPIC_API_KEY is valid\n- Reviewing the logs for more details`;
  }
  
  if (error instanceof LinearAPIError) {
    if (error.code === 'RATE_LIMITED') {
      return 'Rate limit reached. Please wait a moment and try again.';
    }
    return `Linear API error: ${error.message}`;
  }
  
  // Generic error
  return `An unexpected error occurred: ${error instanceof Error ? error.message : String(error)}\n\nPlease check the worker logs for more details.`;
}
```

#### 5.4 Structured Logging

```typescript
interface LogContext {
  sessionId: string;
  issueId?: string;
  repoUrl?: string;
  action?: string;
}

class Logger {
  constructor(private context: LogContext) {}
  
  info(message: string, data?: Record<string, unknown>) {
    console.log(JSON.stringify({
      level: 'info',
      message,
      ...this.context,
      ...data,
      timestamp: new Date().toISOString(),
    }));
  }
  
  error(message: string, error?: unknown, data?: Record<string, unknown>) {
    console.error(JSON.stringify({
      level: 'error',
      message,
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : error,
      ...this.context,
      ...data,
      timestamp: new Date().toISOString(),
    }));
  }
  
  warn(message: string, data?: Record<string, unknown>) {
    console.warn(JSON.stringify({
      level: 'warn',
      message,
      ...this.context,
      ...data,
      timestamp: new Date().toISOString(),
    }));
  }
}
```

Use throughout the codebase:
```typescript
// In session.ts
async cloneAndStart(repoUrl: string) {
  const logger = new Logger({
    sessionId: this.sessionId,
    issueId: this.state.linearIssueId,
    repoUrl,
    action: 'clone_and_start',
  });
  
  try {
    logger.info('Starting clone operation');
    
    const result = await cloneWithRetry(sandbox, repoUrl, this.env.GITHUB_TOKEN);
    
    if (!result.success) {
      logger.error('Clone failed', result.error);
      await this.sendActivity({
        type: 'error',
        body: formatErrorForUser(new RepositoryCloneError(
          result.error!,
          repoUrl,
          'unknown'
        )),
      });
      return;
    }
    
    logger.info('Clone successful');
    // ... continue
  } catch (error) {
    logger.error('Unexpected error in clone_and_start', error);
    await this.sendActivity({
      type: 'error',
      body: formatErrorForUser(error),
    });
  }
}
```

### Deliverables

**Files**:
- `src/errors.ts` - Error types and formatters
- `src/retry.ts` - Retry utilities
- `src/logging.ts` - Structured logger

**Features**:
- All errors caught and handled gracefully
- User-friendly error messages in Linear
- Automatic retries for transient failures
- Detailed structured logs for debugging

### Testing

- Network errors handled
- Linear API errors handled
- Clone failures produce helpful messages
- OpenCode errors handled
- Logs contain enough context for debugging

### Time Estimate
**3-4 hours**

---

## Phase 6: Documentation & Deployment

**Goal**: Make it easy for users to self-host

### Tasks

#### 6.1 README Documentation

Create comprehensive README with:

**Overview section**:
- What this agent does
- How it works (architecture diagram)
- Key features

**Prerequisites**:
- Cloudflare account (free tier OK)
- Linear workspace (admin access)
- Anthropic API key
- GitHub account (for cloning repos)

**Setup Guide**:
1. Clone this repository
2. Install dependencies (`bun install`)
3. Create Linear OAuth Application
   - Step-by-step with screenshots
   - Required scopes
   - Webhook configuration
4. Create Cloudflare resources
   - Create KV namespace: `wrangler kv:namespace create LINEAR_TOKENS`
   - Update `wrangler.jsonc` with namespace ID
5. Configure secrets
   - `wrangler secret put ANTHROPIC_API_KEY`
   - `wrangler secret put LINEAR_WEBHOOK_SECRET`
   - `wrangler secret put LINEAR_CLIENT_ID`
   - `wrangler secret put LINEAR_CLIENT_SECRET`
   - `wrangler secret put GITHUB_TOKEN` (optional)
   - `wrangler secret put OAUTH_CALLBACK_URL`
6. Deploy
   - `bun run deploy`
7. Complete OAuth flow
   - Visit `https://your-worker.workers.dev/oauth/authorize`
   - Authorize the app
   - Verify success

**Usage Guide**:
- How to delegate an issue to the agent
- How to mention the agent
- How to specify which repository to use
- How to send follow-up messages
- What to expect (activities shown in Linear)

**Troubleshooting**:
- Common errors and solutions
- How to view logs (`wrangler tail`)
- How to check secrets (`wrangler secret list`)
- Repository not found errors
- Permission denied errors
- OpenCode errors

**Development**:
- Local development setup (`bun run dev`)
- Project structure
- How to contribute

**License**:
- MIT License (or your choice)

#### 6.2 Environment Variable Documentation

Create `.dev.vars.example`:
```bash
# Required: Anthropic API key for OpenCode
# Get one at: https://console.anthropic.com/
ANTHROPIC_API_KEY=sk-ant-...

# Required: Linear OAuth credentials
# Get these from: https://linear.app/settings/api/applications
LINEAR_CLIENT_ID=...
LINEAR_CLIENT_SECRET=...
LINEAR_WEBHOOK_SECRET=...

# Required: OAuth callback URL
# For local dev: http://localhost:8787/oauth/callback
# For production: https://your-worker.workers.dev/oauth/callback
OAUTH_CALLBACK_URL=http://localhost:8787/oauth/callback

# Optional: GitHub token for private repositories
# Create at: https://github.com/settings/tokens
# Required scopes: repo
GITHUB_TOKEN=ghp_...
```

#### 6.3 Deployment Checklist

Create `DEPLOYMENT.md`:
```markdown
# Deployment Checklist

## Pre-Deployment

- [ ] Anthropic API key obtained
- [ ] Linear OAuth app created
- [ ] Cloudflare account set up
- [ ] KV namespace created
- [ ] wrangler.jsonc updated with KV namespace ID
- [ ] All secrets configured locally for testing

## Local Testing

- [ ] `bun install` completed
- [ ] `bun run dev` starts successfully
- [ ] Can access local webhook endpoint
- [ ] OAuth flow works locally
- [ ] Webhook verification works
- [ ] Test session completes successfully

## Production Deployment

- [ ] `bun run deploy` succeeds
- [ ] Production secrets set via `wrangler secret put`
- [ ] OAuth callback URL updated in Linear app
- [ ] Webhook URL updated in Linear app
- [ ] Complete OAuth flow in production
- [ ] Test with real Linear issue
- [ ] Verify activities appear in Linear
- [ ] Check logs for errors (`wrangler tail`)

## Post-Deployment

- [ ] Document worker URL for team
- [ ] Test delegation workflow
- [ ] Test follow-up messages
- [ ] Test error scenarios
- [ ] Monitor logs for first few sessions
```

#### 6.4 Code Documentation

Add JSDoc comments to key functions:
```typescript
/**
 * Detects the GitHub repository URL from various sources in the webhook.
 * 
 * Priority order:
 * 1. Issue attachments (existing GitHub PRs)
 * 2. Guidance field (workspace/team configuration)
 * 3. Issue description
 * 4. Triggering comment
 * 
 * @param webhook - The Linear AgentSessionEvent webhook payload
 * @returns Repository URL if found, null otherwise
 */
async function detectRepository(webhook: AgentSessionEvent): Promise<string | null>
```

#### 6.5 Architecture Documentation

Create `ARCHITECTURE.md`:
- System architecture diagram
- Data flow diagrams
- State machine for session lifecycle
- Durable Object design decisions
- Security considerations
- Performance considerations

### Deliverables

**Documentation**:
- `README.md` - Complete setup and usage guide
- `.dev.vars.example` - Environment variable template
- `DEPLOYMENT.md` - Deployment checklist
- `ARCHITECTURE.md` - Technical architecture
- `LICENSE` - MIT License

**Inline Documentation**:
- JSDoc comments on public functions
- Code comments explaining complex logic
- Type definitions with documentation

### Testing

- Follow README from scratch on fresh account
- Verify all setup steps work
- Ensure secrets configuration is clear
- Test troubleshooting guide solves common issues

### Time Estimate
**3-4 hours**

---

## Complete File Structure

```
linear-opencode-agent/
├── src/
│   ├── index.ts                 # Main worker entry, routing
│   ├── oauth.ts                 # OAuth flow handlers
│   ├── webhook.ts               # Webhook verification and parsing
│   ├── session.ts               # Durable Object implementation
│   ├── repo-detection.ts        # Repository URL detection
│   ├── sandbox.ts               # Sandbox and git operations
│   ├── opencode.ts              # OpenCode client
│   ├── linear-client.ts         # Linear API wrapper
│   ├── context.ts               # Prompt building
│   ├── errors.ts                # Error types and formatters
│   ├── retry.ts                 # Retry utilities
│   ├── logging.ts               # Structured logger
│   ├── state.ts                 # State management
│   ├── types/
│   │   ├── linear.ts           # Linear API types
│   │   ├── webhook.ts          # Webhook payload types
│   │   ├── session.ts          # Session state types
│   │   └── activities.ts       # Activity types
│   └── utils/
│       └── url.ts              # URL parsing utilities
├── .dev.vars.example            # Environment variable template
├── .gitignore                   # Git ignore file
├── .prettierignore              # Prettier ignore (existing)
├── AGENTS.md                    # Agent guidelines (existing)
├── ARCHITECTURE.md              # Technical architecture
├── bun.lock                     # Bun lockfile (existing)
├── DEPLOYMENT.md                # Deployment checklist
├── Dockerfile                   # Sandbox container (existing)
├── IMPLEMENTATION_PLAN.md       # This file
├── LICENSE                      # MIT License
├── oxlintrc.json                # Linting config (existing)
├── package.json                 # Dependencies (existing)
├── README.md                    # Main documentation
├── tsconfig.json                # TypeScript config (existing)
├── wrangler.jsonc               # Cloudflare config (existing)
└── worker-configuration.d.ts    # Generated types (existing)
```

---

## Dependencies

Update `package.json`:
```json
{
  "name": "linear-opencode-agent",
  "version": "1.0.0",
  "description": "Self-hosted Linear agent powered by OpenCode",
  "dependencies": {
    "@cloudflare/sandbox": "^0.6.7",
    "@linear/sdk": "^latest",
    "@opencode-ai/sdk": "^latest"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^latest",
    "typescript": "^5.0.0",
    "wrangler": "^latest"
  },
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail",
    "typecheck": "tsc --noEmit",
    "lint:check": "oxlint",
    "lint:fix": "oxlint --fix",
    "format:check": "prettier --check .",
    "format:fix": "prettier --write .",
    "check": "bun run typecheck && bun run lint:check && bun run format:check",
    "fix": "bun run lint:fix && bun run format:fix"
  }
}
```

---

## Timeline & Effort Estimates

| Phase | Focus | Estimated Time |
|-------|-------|----------------|
| 1. OAuth & Webhooks | Authentication infrastructure | 3-4 hours |
| 2. Sessions & Repo Detection | Core session management | 4-5 hours |
| 3. Sandbox & OpenCode | Clone and run OpenCode | 4-5 hours |
| 4. Follow-ups | Message continuity | 2-3 hours |
| 5. Error Handling | Graceful failures | 3-4 hours |
| 6. Documentation | Setup guides | 3-4 hours |
| **Total** | | **19-25 hours** |

**Estimated calendar time**: 3-4 days of focused development

---

## Testing Strategy

### During Development
- Test each phase before moving to next
- Use `bun run dev` for local testing
- Use `wrangler tail` to monitor logs
- Test with real Linear workspace

### Before Launch
- Complete deployment checklist
- Test entire flow end-to-end
- Test error scenarios:
  - Invalid repo URL
  - Permission denied
  - OpenCode timeout
  - Network failures
- Verify all documentation steps work

### Post-Launch
- Monitor initial user sessions
- Collect feedback on error messages
- Iterate on documentation clarity

---

## Success Criteria

### Phase 1 Complete
- ✓ OAuth flow works
- ✓ Access token stored in KV
- ✓ Webhooks received and verified
- ✓ Durable Object created for sessions

### Phase 2 Complete
- ✓ Session state persists
- ✓ Repo detected from multiple sources
- ✓ Elicitation works when repo not found
- ✓ Activities appear in Linear

### Phase 3 Complete
- ✓ Repo clones successfully
- ✓ OpenCode starts in cloned repo
- ✓ Initial prompt sent with Linear context
- ✓ Response returned to Linear

### Phase 4 Complete
- ✓ Follow-up messages work
- ✓ OpenCode conversation continues
- ✓ Session timeout works

### Phase 5 Complete
- ✓ All errors caught and handled
- ✓ Error messages are helpful
- ✓ Logs provide debugging context
- ✓ Retries work for transient failures

### Phase 6 Complete
- ✓ README complete and accurate
- ✓ New user can deploy following README
- ✓ Troubleshooting guide solves common issues
- ✓ All documentation up to date

### Launch Ready
- ✓ All success criteria met
- ✓ Deployment tested on fresh account
- ✓ Documentation reviewed
- ✓ Code formatted and linted
- ✓ LICENSE added
- ✓ Repository public on GitHub

---

## Known Limitations & Future Enhancements

### v1 Limitations
- Single workspace per deployment (acceptable for self-hosted)
- No activity streaming (shows thinking, then final response)
- No PR auto-creation (OpenCode can create manually)
- No advanced repo caching
- No session dashboard (Linear UI shows everything)
- No tests (manual testing only)

### Future Enhancements
See issues tracker after launch. Potential features:
- Activity streaming for long-running tasks
- Agent Plans for multi-step visualization  
- PR auto-creation and linking
- Session dashboard for debugging
- Advanced repo detection (learning from history)
- Multi-repo support per session
- Automated tests
- Performance optimizations
- Custom OpenCode tools for Linear operations

---

## Key Design Decisions

### Why Durable Objects?
- Session state must persist across requests
- Linear sends multiple webhooks per session
- DO provides isolation per session
- Built-in storage and alarms

### Why Personal API Key First?
- Actually, we need OAuth - this was wrong in earlier draft
- Agent must authenticate as app user, not human
- OAuth is required for Linear agents

### Why No Tests in v1?
- Faster to iterate without test infrastructure
- Manual testing sufficient for initial users
- Can add tests once API is stable
- Self-hosted users can contribute tests

### Why Shallow Clones?
- Faster clone times (seconds vs minutes)
- Less disk space
- Sufficient for most coding tasks
- Can use full clone if needed

### Why No Activity Streaming?
- Simpler implementation
- Meets Linear's 10-second requirement
- Users see progress (thought → action → response)
- Can add streaming later if needed

### Why Structured Logging?
- Essential for self-hosted debugging
- Users need context to fix issues themselves
- JSON logs easy to parse
- Cloudflare logs viewer supports filtering

---

## Security Considerations

### Webhook Verification
- HMAC signature verification prevents spoofed webhooks
- Protects against unauthorized code execution
- Critical for production deployment

### Secrets Management
- All secrets stored in Cloudflare secrets (encrypted)
- Never logged or exposed in responses
- GitHub token only used for git clone
- Linear token scoped to minimum permissions

### Sandbox Isolation
- Each session runs in isolated sandbox
- No access to other sessions or worker state
- Automatic cleanup on completion
- Resource limits prevent abuse

### Rate Limiting
- Linear API has built-in rate limits
- Retry logic respects rate limits
- No additional rate limiting needed for self-hosted

---

## Performance Targets

### Session Initialization
- Webhook → First activity: <5 seconds
- Required by Linear (10 second timeout)

### Repository Clone
- Small repos (<100MB): <30 seconds
- Medium repos (100MB-500MB): <2 minutes
- Large repos: May timeout, user should use smaller repos

### OpenCode Response
- Simple analysis: 30-60 seconds
- Code changes: 1-3 minutes
- Complex refactoring: 3-5 minutes

### Total Session Duration
- Typical: 2-5 minutes
- Complex: 5-10 minutes
- Timeout: 30 minutes inactivity

---

## References

### Linear Documentation
- [Agent API Overview](https://linear.app/developers/agents)
- [Agent Interaction Guidelines](https://linear.app/developers/aig)
- [Developing Agent Interaction](https://linear.app/developers/agent-interaction)
- [GraphQL API Reference](https://linear.app/developers/graphql)
- [OAuth Documentation](https://linear.app/developers/oauth-2-0-authentication)

### Cloudflare Documentation
- [Workers Documentation](https://developers.cloudflare.com/workers/)
- [Durable Objects Guide](https://developers.cloudflare.com/durable-objects/)
- [Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [Git Workflows in Sandbox](https://developers.cloudflare.com/sandbox/guides/git-workflows/)

### OpenCode Documentation
- [OpenCode Documentation](https://opencode.ai/docs)
- [Sandbox OpenCode Integration](https://developers.cloudflare.com/sandbox/opencode/)

### Other
- [Anthropic API Documentation](https://docs.anthropic.com/)
- [GitHub API Documentation](https://docs.github.com/rest)
