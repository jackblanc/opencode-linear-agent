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
    console.info({
      message: "Looking up existing session state",
      stage: "session",
      linearSessionId,
      issueId,
    });

    const existingState = await this.repository.get(linearSessionId);

    if (existingState?.opencodeSessionId) {
      console.info({
        message: "Found existing state, attempting to resume",
        stage: "session",
        linearSessionId,
        opencodeSessionId: existingState.opencodeSessionId,
      });

      try {
        const session = await this.opencodeClient.session.get({
          path: { id: existingState.opencodeSessionId },
          query: { directory: workdir },
        });

        if (session.data) {
          console.info({
            message: "Successfully resumed session",
            stage: "session",
            linearSessionId,
            opencodeSessionId: session.data.id,
          });
          return { opencodeSessionId: session.data.id, existingState };
        }
        console.warn({
          message: "Session not found, creating new one",
          stage: "session",
          linearSessionId,
          opencodeSessionId: existingState.opencodeSessionId,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.warn({
          message: "Failed to resume session, creating new one",
          stage: "session",
          error: errorMessage,
          linearSessionId,
          opencodeSessionId: existingState.opencodeSessionId,
        });
      }
    }

    console.info({
      message: "Creating new OpenCode session",
      stage: "session",
      linearSessionId,
      issueId,
    });

    const session = await this.opencodeClient.session.create({
      body: {
        title: `${LINEAR_SESSION_PREFIX}${linearSessionId}`,
      },
      query: { directory: workdir },
    });

    if (!session.data) {
      console.error({
        message: "OpenCode API returned no data when creating session",
        stage: "session",
        linearSessionId,
      });
      throw new Error("Failed to create OpenCode session");
    }

    console.info({
      message: "Created OpenCode session",
      stage: "session",
      linearSessionId,
      opencodeSessionId: session.data.id,
    });

    const newState: SessionState = {
      opencodeSessionId: session.data.id,
      linearSessionId,
      issueId,
      branchName,
      workdir,
      lastActivityTime: Date.now(),
    };

    await this.repository.save(newState);

    console.info({
      message: "Saved session state to repository",
      stage: "session",
      linearSessionId,
      opencodeSessionId: session.data.id,
      branchName,
      workdir,
    });

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
