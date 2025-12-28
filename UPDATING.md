# Updating Guide

## How to Update Dependencies

### Update All Dependencies

```bash
# Using bun
bun update

# Or using npm
npm update
```

### Update Specific Packages

#### Update Cloudflare Sandbox SDK

```bash
# Check latest version
npm view @cloudflare/sandbox versions

# Update to latest
bun add @cloudflare/sandbox@latest -D

# Or update to specific version
bun add @cloudflare/sandbox@0.6.8 -D
```

**Important**: When updating `@cloudflare/sandbox`, also update your Dockerfile:

```dockerfile
# In Dockerfile, update the version tag
FROM docker.io/cloudflare/sandbox:0.6.8-opencode
```

The Dockerfile version should match your package.json version.

#### Update OpenCode SDK

```bash
# Check latest version
npm view @opencode-ai/sdk versions

# Update to latest
bun add @opencode-ai/sdk@latest -D
```

#### Update Wrangler

```bash
# Check latest version
npm view wrangler versions

# Update to latest
bun add wrangler@latest -D
```

### Update TypeScript Types

```bash
# After updating dependencies, regenerate Cloudflare Workers types
bun run cf-typegen
```

## Version Compatibility

### Sandbox SDK + Docker Image

The Docker image version should match your SDK version:

| SDK Version | Docker Image                        |
| ----------- | ----------------------------------- |
| 0.6.7       | `cloudflare/sandbox:0.6.7-opencode` |
| 0.6.8       | `cloudflare/sandbox:0.6.8-opencode` |
| 0.7.0       | `cloudflare/sandbox:0.7.0-opencode` |

### Checking Installed Versions

```bash
# Check all installed versions
bun pm ls

# Check specific package version
bun pm ls @cloudflare/sandbox
```

## After Updating

1. **Reinstall dependencies**:

   ```bash
   bun install
   ```

2. **Rebuild types**:

   ```bash
   bun run cf-typegen
   ```

3. **Test locally**:

   ```bash
   bun run dev
   ```

   Note: First run after Dockerfile changes will rebuild the container (2-3 minutes)

4. **Run type check**:

   ```bash
   bun run typecheck
   ```

5. **Deploy** (if tests pass):
   ```bash
   bun run deploy
   ```

## Troubleshooting

### "Cannot find module @cloudflare/sandbox/opencode"

This means your SDK version doesn't include OpenCode support. Update to 0.6.7 or later:

```bash
bun add @cloudflare/sandbox@^0.6.7 -D
```

### Docker image not found

If you get an error about the Docker image not being found:

1. Check available tags: https://hub.docker.com/r/cloudflare/sandbox/tags
2. Verify the `-opencode` variant exists for your version
3. If not available, use the base image temporarily:
   ```dockerfile
   FROM docker.io/cloudflare/sandbox:0.6.7
   ```
   (Note: This may require manual OpenCode CLI installation)

### Type errors after updating

1. Delete generated types:

   ```bash
   rm worker-configuration.d.ts
   ```

2. Regenerate types:

   ```bash
   bun run cf-typegen
   ```

3. Restart your editor/IDE

## Keeping Up-to-Date

### Watch for Updates

- Cloudflare Sandbox SDK: https://github.com/cloudflare/sandbox-sdk/releases
- OpenCode: https://github.com/opencode/opencode/releases (or check npm)
- Wrangler: https://github.com/cloudflare/workers-sdk/releases

### Automated Updates

Consider using tools like:

- [Dependabot](https://github.com/dependabot) (if using GitHub)
- [Renovate](https://www.mend.io/renovate/)
- Manual weekly/monthly checks

## Breaking Changes

When updating major or minor versions, always check:

1. **Changelog/Release Notes**: Review breaking changes
2. **Migration Guides**: Check for migration paths
3. **API Changes**: Test all endpoints after updating
4. **Docker Image**: Verify `-opencode` variant availability
