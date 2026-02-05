import type { PendingPermission } from "../session/SessionRepository";
import type { Action, HandlerResultWithPermission } from "../actions/types";

/**
 * Context needed for permission handler processing
 */
export interface PermissionHandlerContext {
  linearSessionId: string;
  opencodeSessionId: string;
  workdir: string | null;
  issueId: string;
}

/**
 * Input for permission handler - decoupled from SDK types.
 *
 * Both the plugin (v1 Permission) and server (v2 PermissionRequest) construct
 * this shape from their respective SDK types. The handler doesn't need the
 * `always` field from v2's PermissionRequest.
 */
export interface PermissionHandlerInput {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
}

/**
 * Process a permission.asked event - pure function
 *
 * Posts an elicitation to Linear with approval options, then returns
 * the pending permission data for the orchestrator to store.
 *
 * PermissionHandler returns a PendingPermission that needs to be stored
 * by the orchestrator.
 *
 * Takes event properties and returns actions + pending permission.
 * No side effects, no I/O.
 */
export function processPermissionAsked(
  properties: PermissionHandlerInput,
  ctx: PermissionHandlerContext,
): HandlerResultWithPermission {
  const { id, sessionID, permission, patterns, metadata } = properties;

  // Only process for our session
  if (sessionID !== ctx.opencodeSessionId) {
    return { actions: [] };
  }

  // Format permission request for display
  const patternsList =
    patterns.length > 0
      ? `\n\n**Patterns:**\n${patterns.map((p) => `- \`${p}\``).join("\n")}`
      : "";

  const body = `**Permission Request: ${permission}**${patternsList}\n\nPlease approve or reject this tool call.`;

  // Options for the user to select
  const options = [
    { value: "Approve" },
    { value: "Approve Always" },
    { value: "Reject" },
  ];

  const actions: Action[] = [
    {
      type: "postElicitation",
      sessionId: ctx.linearSessionId,
      body,
      signal: "select",
      metadata: { options },
    },
  ];

  // Build pending permission for storage
  const pendingPermission: PendingPermission = {
    requestId: id,
    opencodeSessionId: sessionID,
    linearSessionId: ctx.linearSessionId,
    workdir: ctx.workdir ?? "",
    issueId: ctx.issueId,
    permission,
    patterns,
    metadata,
    createdAt: Date.now(),
  };

  return { actions, pendingPermission };
}
