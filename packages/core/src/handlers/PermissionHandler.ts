import { Result } from "better-result";
import type { OpencodeService } from "../opencode/OpencodeService";
import type { Logger } from "../logger";

/**
 * Handles permission.asked events - auto-approves all permissions.
 *
 * For an agentic coding tool working on delegated issues,
 * auto-approving permissions is appropriate since the user
 * has already granted trust by delegating the work.
 */
export class PermissionHandler {
  constructor(
    private readonly opencode: OpencodeService,
    private readonly opencodeSessionId: string,
    private readonly log: Logger,
    private readonly workdir: string | null = null,
  ) {}

  /**
   * Handle permission.asked event - auto-approve
   */
  async handlePermissionAsked(properties: {
    id: string;
    sessionID: string;
    permission: string;
    [key: string]: unknown;
  }): Promise<void> {
    const { id, sessionID, permission } = properties;

    // Only process for our session
    if (sessionID !== this.opencodeSessionId) {
      return;
    }

    this.log.info("Auto-approving permission", { requestId: id, permission });

    const result = await this.opencode.replyPermission(
      id,
      "always",
      this.workdir ?? undefined,
    );

    if (Result.isError(result)) {
      this.log.error("Failed to reply to permission", {
        requestId: id,
        error: result.error.message,
        errorType: result.error._tag,
      });
    }
  }
}
