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
  - Query Linear for app viewer ID (using GraphQL `viewer` query)
  - Redirect to success page with setup instructions
  - Token storage in KV using workspace ID as key

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

- Add Durable Object binding for `AGENT_SESSIONS`
- Add KV namespace binding for `LINEAR_TOKENS`

Required environment variables:

- `ANTHROPIC_API_KEY` - For OpenCode
- `LINEAR_WEBHOOK_SECRET` - From Linear app settings
- `LINEAR_CLIENT_ID` - From Linear app settings
- `LINEAR_CLIENT_SECRET` - From Linear app settings
- `OAUTH_CALLBACK_URL` - Worker callback URL
- `GITHUB_TOKEN` - Optional, for private repos

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

- `agentSessionId` - Unique session ID from Linear
- `linearIssueId` - Linear issue ID
- `linearIssueIdentifier` - Issue identifier (e.g., "ENG-123")
- `linearIssueTitle` - Issue title
- `linearIssueDescription` - Issue description
- `repoUrl` - GitHub repository URL (null until detected)
- `repoCloned` - Whether repo has been cloned
- `opencodeSessionId` - OpenCode session ID (null until created)
- `status` - Session status: initializing, cloning, running, completed, error
- `createdAt` - Session creation timestamp
- `lastActivityAt` - Last activity timestamp

Implement `AgentSession` class:

- `fetch(request)` - Handle messages from worker
- `handleCreated(webhook)` - Process new session
- `handlePrompted(webhook)` - Process follow-up message
- State persistence using `this.ctx.storage`
- Alarm for session timeout (30 min inactivity)

Session lifecycle:

1. Initialize state from webhook
2. Send immediate acknowledgment (within 10 seconds)
3. Detect repository from multiple sources
4. If no repo found, send elicitation asking for repo URL
5. If repo found, clone and start OpenCode

Follow-up handling:

- If waiting for repo URL, extract it from user message
- Otherwise, forward message to OpenCode session

#### 2.2 Repository Detection (`src/repo-detection.ts`)

Implement multi-source detection with priority order:

1. **Issue attachments** - Check for existing GitHub PR attachments
2. **Guidance field** - Check workspace/team configuration
3. **Issue description** - Extract repo URL from description
4. **Triggering comment** - Extract from comment that triggered agent
5. **Return null** - Will trigger elicitation to ask user

URL extraction patterns:

- Match: `https://github.com/owner/repo`
- Match: `github.com/owner/repo`
- Match: `https://github.com/owner/repo/pull/123`
- Match: `https://github.com/owner/repo/issues/456`
- Extract owner/repo and return canonical URL
- Clean up repo name (remove `.git`, `/pull/123`, etc.)

#### 2.3 Linear API Client (`src/linear-client.ts`)

Wrapper for Linear API calls:

Key methods:

- `createActivity()` - Create agent activities (thoughts, actions, responses)
  - Supports ephemeral option for temporary status messages
  - Error handling for Linear API errors
- `updateSession()` - Update agent session state
- `getIssue()` - Fetch issue details

Implementation:

- GraphQL API calls using `fetch()`
- Authorization header with OAuth access token
- Structured error handling
- Type-safe responses

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

- Get sandbox instance using session ID
- Ensure project directory exists

Repository cloning:

- Add GitHub token to URL for private repos
- Use `sandbox.gitCheckout()` with shallow clone (depth: 1) for speed
- Target directory: `/home/user/project`

Error handling for common failures:

- **404/Not found** - Repository doesn't exist or URL is wrong
- **403/Permission denied** - Private repo requires GITHUB_TOKEN
- **Timeout** - Repository too large, suggest smaller repo
- **Generic errors** - Return error message with context

#### 3.2 OpenCode Integration (`src/opencode.ts`)

Start OpenCode server:

- Use `createOpencode()` from Sandbox SDK
- Configure working directory: `/home/user/project`
- Configure Anthropic provider with API key
- Return client for session management

Create OpenCode session:

- Create session with title: `{issue.identifier}: {issue.title}`
- Return session ID for future message sending
- Error handling if session creation fails

Build initial prompt:

- Include Linear issue identifier and title
- Include issue description
- Include latest comment (if triggered by mention)
- Include previous comments for context
- Include team guidance (if configured)
- Add instructions to analyze and propose solution

Send message and handle response:

- Create message in OpenCode session
- Wait for response
- Return response content
- Error handling for failed responses

#### 3.3 Activity Emission Flow

Implement the full clone → OpenCode → response flow:

1. **Update state** - Set repo URL and status to "cloning"
2. **Send cloning activity** - Action type with repo URL parameter
3. **Get sandbox** - Initialize sandbox for this session
4. **Clone repository** - With retry logic and error handling
5. **Handle clone errors** - Set error state and send error activity
6. **Send clone success** - Action type with success result
7. **Start OpenCode** - Update status to "running", send thought activity
8. **Create OpenCode session** - With Linear issue context as title
9. **Send initial prompt** - Built from webhook context
10. **Send final response** - Response activity with OpenCode output
11. **Update state** - Set status to "completed"

Each step includes state persistence and activity emission for Linear UI updates.

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

1. **Validate session** - Check if OpenCode session exists
2. **Send thinking indicator** - Ephemeral thought activity
3. **Get OpenCode client** - Reconnect to existing sandbox/session
4. **Send user message** - Forward to OpenCode session
5. **Send response** - Create response activity in Linear
6. **Update timestamp** - Reset last activity time for timeout tracking

#### 4.2 Session Timeout Handling

Implement alarm for inactivity timeout:

- **Timeout duration**: 30 minutes of inactivity
- **Alarm implementation**:
  - Check if inactivity exceeds timeout
  - If yes: send timeout message, mark session completed
  - If no: re-arm alarm for remaining time
- **Reset timeout**: Called on each activity to extend session life

#### 4.3 State Recovery

Handle DO hibernation/wake-up:

- Load state from Durable Object storage on each request
- If no state exists, create new session
- If state exists, restore session state
- Handle webhook action: `created` or `prompted`
- Return success response

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

Define custom error types:

- **LinearAPIError** - Linear API errors with code and details
- **RepositoryCloneError** - Clone errors with repo URL and reason (not_found, permission_denied, timeout, unknown)
- **OpenCodeError** - OpenCode errors with details

#### 5.2 Retry Logic (`src/retry.ts`)

Implement exponential backoff retry:

**Generic retry function**:

- Configurable max retries, initial delay, max delay
- Optional `shouldRetry` predicate for selective retries
- Exponential backoff between attempts
- Throws last error if all retries exhausted

**Linear API retry helper**:

- Max retries: 3
- Initial delay: 1 second
- Max delay: 10 seconds
- Retry on: rate limits and server errors (5xx)

#### 5.3 User-Friendly Error Messages

Map technical errors to helpful messages:

**RepositoryCloneError**:

- **not_found**: Provide checklist (repo exists, URL correct, public/has token)
- **permission_denied**: Instructions to create GitHub PAT and add to worker
- **timeout**: Suggest using smaller repo or increasing timeout
- **unknown**: Generic clone failure message

**OpenCodeError**:

- Suggest starting new session
- Suggest checking ANTHROPIC_API_KEY validity
- Suggest reviewing worker logs

**LinearAPIError**:

- **RATE_LIMITED**: Ask user to wait
- **Other**: Display error message

**Generic errors**:

- Display error message with instruction to check logs

#### 5.4 Structured Logging

Create Logger class with:

**Log context** (attached to all logs):

- `sessionId` - Agent session ID
- `issueId` - Linear issue ID (optional)
- `repoUrl` - Repository URL (optional)
- `action` - Current action (optional)

**Log methods**:

- `info()` - Informational messages
- `error()` - Errors with full stack traces
- `warn()` - Warnings

**Output format**:

- JSON structured logs
- Include level, message, context, data, timestamp
- Serialize Error objects with name, message, stack

**Usage pattern**:

- Create logger with context at start of each major operation
- Log at key points: operation start, success, failure
- Include relevant data in log calls

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

Create `.dev.vars.example` with:

**Required variables**:

- `ANTHROPIC_API_KEY` - From console.anthropic.com
- `LINEAR_CLIENT_ID` - From Linear OAuth app settings
- `LINEAR_CLIENT_SECRET` - From Linear OAuth app settings
- `LINEAR_WEBHOOK_SECRET` - From Linear OAuth app settings
- `OAUTH_CALLBACK_URL` - Worker callback URL (local: localhost:8787, prod: workers.dev)

**Optional variables**:

- `GITHUB_TOKEN` - GitHub PAT for private repos (scope: repo)

#### 6.3 Deployment Checklist

Create `DEPLOYMENT.md` with sections:

**Pre-Deployment**:

- Obtain API keys and credentials
- Create Cloudflare resources (KV namespace)
- Update configuration files

**Local Testing**:

- Install dependencies
- Start dev server
- Test OAuth flow locally
- Test webhook verification
- Complete test session

**Production Deployment**:

- Deploy to Cloudflare
- Configure production secrets
- Update Linear app URLs
- Test with real Linear issue
- Verify activities in Linear UI
- Check logs

**Post-Deployment**:

- Document worker URL
- Test all workflows
- Monitor initial sessions

#### 6.4 Code Documentation

Add JSDoc comments to key functions:

- Document purpose and behavior
- Document parameters and return types
- Include examples for complex functions
- Explain priority order for multi-source logic
- Document error conditions

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

**Dependencies**:

- `@cloudflare/sandbox` - Sandbox SDK for isolated code execution
- `@linear/sdk` - Linear API client (optional, may use fetch directly)
- `@opencode-ai/sdk` - OpenCode TypeScript SDK

**Dev Dependencies**:

- `@cloudflare/workers-types` - TypeScript types for Workers
- `typescript` - TypeScript compiler
- `wrangler` - Cloudflare deployment CLI

**Scripts** (already exist in package.json):

- Development: `dev`, `start`
- Deployment: `deploy`
- Type checking: `typecheck`, `cf-typegen`
- Linting: `lint:check`, `lint:fix`
- Formatting: `format:check`, `format:fix`
- Combined: `check`, `fix`

---

## Timeline & Effort Estimates

| Phase                        | Focus                         | Estimated Time  |
| ---------------------------- | ----------------------------- | --------------- |
| 1. OAuth & Webhooks          | Authentication infrastructure | 3-4 hours       |
| 2. Sessions & Repo Detection | Core session management       | 4-5 hours       |
| 3. Sandbox & OpenCode        | Clone and run OpenCode        | 4-5 hours       |
| 4. Follow-ups                | Message continuity            | 2-3 hours       |
| 5. Error Handling            | Graceful failures             | 3-4 hours       |
| 6. Documentation             | Setup guides                  | 3-4 hours       |
| **Total**                    |                               | **19-25 hours** |

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
