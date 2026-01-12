import type { Action } from "../actions/types";

/**
 * Context needed for permission handler processing
 */
export interface PermissionHandlerContext {
  opencodeSessionId: string;
  workdir: string | null;
}

/**
 * Properties from permission.asked event
 */
export interface PermissionAskedProperties {
  id: string;
  sessionID: string;
  permission: string;
  [key: string]: unknown;
}

/**
 * Process a permission.asked event - pure function
 *
 * Auto-approves all permissions since the user has already
 * granted trust by delegating the work.
 *
 * PermissionHandler doesn't need HandlerState - it's stateless.
 *
 * Takes event properties and returns actions.
 * No side effects, no I/O.
 */
export function processPermissionAsked(
  properties: PermissionAskedProperties,
  ctx: PermissionHandlerContext,
): Action[] {
  const { id, sessionID } = properties;

  // Only process for our session
  if (sessionID !== ctx.opencodeSessionId) {
    return [];
  }

  return [
    {
      type: "replyPermission",
      requestId: id,
      reply: "always",
      directory: ctx.workdir ?? undefined,
    },
  ];
}
