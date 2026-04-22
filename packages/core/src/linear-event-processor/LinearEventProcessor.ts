import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type { Project } from "@opencode-ai/sdk/v2";

import { Result } from "better-result";
import { basename } from "node:path";
import { z } from "zod";

import type { LinearService } from "../linear-service/LinearService";
import type { OpencodeService } from "../opencode-service/OpencodeService";
import type { AgentStateNamespace } from "../state/root";
import type {
  PendingPermission,
  PendingQuestion,
  PendingRepoSelection,
  RepoSelectionOption,
  SessionState,
} from "../state/schema";
import type { SessionRepository } from "../state/SessionRepository";
import type { AgentMode } from "../utils/determineAgentMode";
import type { Logger } from "../utils/logger";

import { KvNotFoundError } from "../kv/errors";
import { LinearForbiddenError } from "../linear-service/errors";
import { findRepoLabel, parseRepoLabel } from "../linear-service/label-parser";
import { buildCreatedPrompt } from "../session/PromptBuilder";
import { SessionManager } from "../session/SessionManager";
import { determineAgentMode } from "../utils/determineAgentMode";
import { base64Encode } from "../utils/encode";
import { Log } from "../utils/logger";

/**
 * Main entry point for processing Linear webhook events.
 *
 * This class is platform-agnostic and receives all dependencies via constructor injection.
 * Uses OpenCode's native worktree and project APIs.
 *
 * Delegates to specialized managers:
 * - SessionManager: OpenCode session lifecycle
 * - PromptBuilder: Context injection and prompt construction
 */
export class LinearEventProcessor {
  constructor(
    private readonly agentState: AgentStateNamespace,
    private readonly opencode: OpencodeService,
    private readonly linear: LinearService,
  ) {}

  /**
   * Process an incoming Linear AgentSessionEvent
   *
   * Overall process:
   * - Resolve the OpenCode project to use for this issue
   *
   * For "created" events, we must:
   * - Resolve OpenCode project to use
   * - Resolve existing worktree for the issue, create if not exists
   * - Start new session in project + worktree combo
   *
   * For "prompted" events, we must:
   * - Resolve existing OpenCode session
   * - Dispatch prompt and return
   *
   * @param event - The webhook payload from Linear
   */
  async process(event: AgentSessionEventWebhookPayload) {
    const linearAgentSessionId = event.agentSession.id;
    const linearIssueId = event.agentSession.issueId ?? event.agentSession.issue?.id;
    const logger = Log.create({ service: "processor" })
      .tag("linearAgentSessionId", linearAgentSessionId)
      .tag("linearIssueId", linearIssueId ?? "missing_issue_id");

    if (!linearIssueId) {
      throw new Error("AgentSessionEvent is missing linearIssueId");
    }

    const eventProcessorResult = await Result.gen(
      async function* (this: LinearEventProcessor) {
        const issueProjectWorkspace = yield* Result.await(
          this.resolveProjectWorkspace(linearIssueId, linearAgentSessionId, event),
        );

        const agentModeForIssueStatus = yield* (await this.linear.getIssueState(linearIssueId)).map(
          (state) => determineAgentMode(state.type),
        );

        if (event.action === "created") {
          const opencodeSession = yield* Result.await(
            this.opencode.createSessionInWorkspace(issueProjectWorkspace.workspaceId),
          );
          yield* Result.await(
            this.opencode.prompt(
              opencodeSession.id,
              [{ type: "text", text: event.promptContext ?? "" }],
              agentModeForIssueStatus,
            ),
          );
          yield* Result.await(
            this.agentState.session.put(linearAgentSessionId, {
              opencodeSessionId: opencodeSession.id,
              organizationId: event.organizationId,
            }),
          );
        }

        if (event.action === "prompted") {
          const existingSession = yield* Result.await(
            this.agentState.session.get(linearAgentSessionId),
          );
          return this.opencode.prompt(
            existingSession.opencodeSessionId,
            [{ type: "text", text: event.promptContext ?? "" }],
            agentModeForIssueStatus,
          );
        }
        return Result.ok();
      }.bind(this),
    );

    if (eventProcessorResult.isErr()) {
      logger.error("Failed to process event: " + JSON.stringify(eventProcessorResult.error));
      if (
        !eventProcessorResult.error.message.includes(
          "Failed to resolve repo, posted selection elicitation",
        )
      )
        await this.linear.postError(linearAgentSessionId, eventProcessorResult.error);
    }
  }

  private async resolveProjectWorkspace(
    linearIssueId: string,
    linearAgentSessionId: string,
    event: AgentSessionEventWebhookPayload,
  ) {
    if (event.action === "created") {
      return this.resolveProjectWorkspaceAgentSessionCreated(linearIssueId, linearAgentSessionId);
    } else if (event.action === "prompted") {
      return this.resolveProjectWorkspaceAgentSessionPrompted(
        linearIssueId,
        linearAgentSessionId,
        event,
      );
    }
    return Result.err(new Error(`Unsupported action: ${event.action}`));
  }

  private async resolveProjectWorkspaceAgentSessionPrompted(
    linearIssueId: string,
    linearAgentSessionId: string,
    event: AgentSessionEventWebhookPayload,
  ) {
    const existingProjectWorkspaceMapping =
      await this.agentState.issueProjectWorkspace.get(linearIssueId);
    if (existingProjectWorkspaceMapping.isOk()) {
      return existingProjectWorkspaceMapping;
    }

    return Result.gen(async function* (this: LinearEventProcessor) {
      const opencodeProjects = yield* Result.await(this.opencode.listProjects());

      // parse user selection from prompted body
      const selection = z.string().optional().parse(event.agentActivity?.content?.body);
      const projectForSelection = opencodeProjects.projects.find(
        (project) => project.name === selection || basename(project.worktree) === selection,
      );

      if (projectForSelection) {
        const linearIssue = yield* Result.await(this.linear.getIssue(linearIssueId));
        const issueOpencodeWorkspace = yield* Result.await(
          this.opencode.createWorkspaceInProject(
            projectForSelection.worktree,
            linearIssue.branchName,
            linearIssueId,
          ),
        );
        yield* Result.await(
          this.agentState.issueProjectWorkspace.put(linearIssueId, {
            projectId: issueOpencodeWorkspace.projectID,
            workspaceId: issueOpencodeWorkspace.id,
          }),
        );
        return Result.ok({
          projectId: issueOpencodeWorkspace.projectID,
          workspaceId: issueOpencodeWorkspace.id,
        });
      } else {
        return this.postProjectSelectionElicitation(
          linearAgentSessionId,
          linearIssueId,
          opencodeProjects.projects,
        );
      }
    });
  }

  private async resolveProjectWorkspaceAgentSessionCreated(
    linearIssueId: string,
    linearAgentSessionId: string,
  ) {
    const existingProjectWorkspaceMapping =
      await this.agentState.issueProjectWorkspace.get(linearIssueId);
    if (existingProjectWorkspaceMapping.isOk()) {
      return existingProjectWorkspaceMapping;
    }

    return Result.gen(async function* (this: LinearEventProcessor) {
      const issueLabels = yield* Result.await(this.linear.getIssueLabels(linearIssueId));
      const opencodeProjects = yield* Result.await(this.opencode.listProjects());
      const matchingProject = opencodeProjects.projects.find((project) =>
        issueLabels.some(
          (label) =>
            label.name === `repo:${project.name}` ||
            label.name === `repo:${basename(project.worktree)}`,
        ),
      );

      if (matchingProject) {
        const linearIssue = yield* Result.await(this.linear.getIssue(linearIssueId));
        const issueOpencodeWorkspace = yield* Result.await(
          this.opencode.createWorkspaceInProject(
            matchingProject.worktree,
            linearIssue.branchName,
            linearIssueId,
          ),
        );
        yield* Result.await(
          this.agentState.issueProjectWorkspace.put(linearIssueId, {
            projectId: issueOpencodeWorkspace.projectID,
            workspaceId: issueOpencodeWorkspace.id,
          }),
        );
        return Result.ok({
          projectId: issueOpencodeWorkspace.projectID,
          workspaceId: issueOpencodeWorkspace.id,
        });
      } else {
        return this.postProjectSelectionElicitation(
          linearAgentSessionId,
          linearIssueId,
          opencodeProjects.projects,
        );
      }
    });
  }

  private async postProjectSelectionElicitation(
    linearAgentSessionId: string,
    linearIssueId: string,
    opencodeProjects: Project[],
  ) {
    await this.linear.postElicitation(
      linearAgentSessionId,
      `Select a project for issue ${linearIssueId}`,
      "select",
      {
        options: opencodeProjects.map((project) => ({
          label: basename(project.worktree),
          value: basename(project.worktree),
        })),
      },
    );
    // TODO: Make this an explicit TaggedError
    // TODO: Make error from postElicitation propagate
    return Result.err(new Error("Failed to resolve repo, posted selection elicitation"));
  }
}
