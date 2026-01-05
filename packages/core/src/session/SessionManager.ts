import type { OpencodeClient } from "@opencode-ai/sdk";
import type { SessionRepository } from "./SessionRepository";
import type { SessionState } from "./SessionState";

/**
 * Prefix used in OpenCode session titles to identify Linear sessions
 */
const LINEAR_SESSION_PREFIX = "linear:";

/**
 * Manages the lifecycle of OpenCode sessions linked to Linear sessions
 */
export class SessionManager {
  constructor(
    private readonly opencodeClient: OpencodeClient,
    private readonly repository: SessionRepository,
  ) {}

  /**
   * Get or create an OpenCode session for a Linear session
   *
   * @returns Object containing the session ID and whether state already existed
   */
  async getOrCreateSession(
    linearSessionId: string,
    issueId: string,
    branchName: string,
    workdir: string,
  ): Promise<{
    opencodeSessionId: string;
    existingState: SessionState | null;
  }> {
    console.info(
      `[session] Looking up existing session state for ${linearSessionId}`,
    );
    const existingState = await this.repository.get(linearSessionId);

    if (existingState?.opencodeSessionId) {
      console.info(
        `[session] Found existing state, attempting to resume OpenCode session ${existingState.opencodeSessionId}`,
      );

      try {
        const session = await this.opencodeClient.session.get({
          path: { id: existingState.opencodeSessionId },
        });

        if (session.data) {
          console.info(
            `[session] Successfully resumed session ${session.data.id}`,
          );
          return { opencodeSessionId: session.data.id, existingState };
        }
        console.warn(
          `[session] Session ${existingState.opencodeSessionId} not found, creating new one`,
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.warn(
          `[session] Failed to resume session: ${errorMessage}, creating new one`,
        );
      }
    }

    console.info(
      `[session] Creating new OpenCode session for Linear session ${linearSessionId}`,
    );
    const session = await this.opencodeClient.session.create({
      body: {
        title: `${LINEAR_SESSION_PREFIX}${linearSessionId}`,
      },
    });

    if (!session.data) {
      console.error(
        "[session] OpenCode API returned no data when creating session",
      );
      throw new Error("Failed to create OpenCode session");
    }

    console.info(`[session] Created OpenCode session ${session.data.id}`);

    const newState: SessionState = {
      opencodeSessionId: session.data.id,
      linearSessionId,
      issueId,
      branchName,
      workdir,
      lastActivityTime: Date.now(),
    };

    await this.repository.save(newState);
    console.info(`[session] Saved session state to repository`);

    return { opencodeSessionId: session.data.id, existingState: null };
  }

  /**
   * Update last activity time for a session
   */
  async touch(linearSessionId: string): Promise<void> {
    const state = await this.repository.get(linearSessionId);
    if (state) {
      state.lastActivityTime = Date.now();
      await this.repository.save(state);
    }
  }

  /**
   * Clean up session state
   */
  async cleanup(linearSessionId: string): Promise<void> {
    await this.repository.delete(linearSessionId);
  }
}
