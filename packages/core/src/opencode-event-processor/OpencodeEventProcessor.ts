import type {
  Event,
  EventMessagePartUpdated,
  EventMessageUpdated,
  EventPermissionAsked,
  EventQuestionAsked,
  EventSessionError,
  EventSessionIdle,
  EventTodoUpdated,
  ReasoningPart,
  TextPart,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import type { LinearService } from "../linear-service/LinearService";
import type { AgentStateNamespace } from "../state/root";
import { Result } from "better-result";
import type { SessionState } from "../session/SessionState";
import { mapTodoStatus } from "./formatting/todo";
import {
  extractToolParameter,
  getToolActionName,
  getToolThought,
  replacePathsInOutput,
  truncateOutput,
} from "./formatting/tool";

export class OpencodeEventProcessor {
  private readonly messageRoleMap: Map<string, "assistant" | "user">;

  constructor(
    private readonly log: (message: string) => void,
    private readonly agentState: AgentStateNamespace,
    private readonly linearClientProvider: (token: string) => LinearService,
  ) {
    this.messageRoleMap = new Map();
  }

  async processEvent(event: Event): Promise<Result<void, Error>> {
    return Result.gen(
      async function* (this: OpencodeEventProcessor) {
        const opencodeSessionId =
          yield* this.resolveOpencodeSessionIdFromEvent(event);
        const linearSessionIdRecord = yield* Result.await(
          this.agentState.sessionByOpencode.get(opencodeSessionId),
        );
        const linearSessionState = yield* Result.await(
          this.agentState.session.get(linearSessionIdRecord.linearSessionId),
        );
        const linearAuthRecord = yield* Result.await(
          this.agentState.auth.get(linearSessionState.organizationId),
        );
        const linearClient = this.linearClientProvider(
          linearAuthRecord.accessToken,
        );

        switch (event.type) {
          case "message.updated":
            return this.processEventMessageUpdated(event);
          case "message.part.updated":
            return this.processEventMessagePartUpdated(
              event,
              linearSessionState,
              linearClient,
            );
          case "session.error":
            return this.processEventSessionError(
              event,
              linearSessionState,
              linearClient,
            );
          case "question.asked":
            return this.processEventQuestionAsked(
              event,
              linearSessionState,
              linearClient,
            );
          case "permission.asked":
            return this.processEventPermissionAsked(
              event,
              linearSessionState,
              linearClient,
            );
          case "todo.updated":
            return this.processEventTodoUpdated(
              event,
              linearSessionState,
              linearClient,
            );
          case "session.idle":
            return this.processEventSessionIdle(
              event,
              linearSessionState,
              linearClient,
            );
          default:
            return Result.ok();
        }
      }.bind(this),
    );
  }

  private async processEventMessageUpdated(
    event: EventMessageUpdated,
  ): Promise<Result<void, Error>> {
    // Store the role for the message ID, used to conditionally skip sending TextPart of user messages to Linear
    this.messageRoleMap.set(
      event.properties.info.id,
      event.properties.info.role,
    );
    return Result.ok();
  }

  private async processEventMessagePartUpdated(
    event: EventMessagePartUpdated,
    sessionState: SessionState,
    linearClient: LinearService,
  ): Promise<Result<void, Error>> {
    switch (event.properties.part.type) {
      case "tool":
        return this.processToolPart(
          event.properties.part,
          sessionState,
          linearClient,
        );
      case "reasoning":
        return this.processReasoningPart(
          event.properties.part,
          sessionState,
          linearClient,
        );
      case "text":
        return this.processTextPart(
          event.properties.part,
          sessionState,
          linearClient,
        );
      default:
        return Result.ok();
    }
  }

  private async processToolPart(
    part: ToolPart,
    sessionState: SessionState,
    linearClient: LinearService,
  ): Promise<Result<void, Error>> {
    if (part.state.status === "running") {
      return linearClient.postActivity(
        sessionState.linearSessionId,
        {
          type: "action",
          action: getToolActionName(part.tool, false),
          body: getToolThought(part.tool, part.state.input),
          parameter: extractToolParameter(
            part.tool,
            part.state.input,
            sessionState.workdir,
          ),
        },
        true,
      );
    }
    if (part.state.status === "completed") {
      return linearClient.postActivity(
        sessionState.linearSessionId,
        {
          type: "action",
          action: getToolActionName(part.tool, true),
          parameter: extractToolParameter(
            part.tool,
            part.state.input,
            sessionState.workdir,
          ),
          result: truncateOutput(
            replacePathsInOutput(part.state.output, sessionState.workdir),
          ),
        },
        false,
      );
    }
    if (part.state.status === "error") {
      return linearClient.postActivity(sessionState.linearSessionId, {
        type: "action",
        action: getToolActionName(part.tool, true),
        parameter: extractToolParameter(
          part.tool,
          part.state.input,
          sessionState.workdir,
        ),
        result: `Error: ${truncateOutput(replacePathsInOutput(part.state.error, sessionState.workdir))}`,
      });
    }

    return Result.ok();
  }

  private async processReasoningPart(
    part: ReasoningPart,
    sessionState: SessionState,
    linearClient: LinearService,
  ): Promise<Result<void, Error>> {
    return linearClient.postActivity(
      sessionState.linearSessionId,
      { type: "thought", body: part.text.trim() },
      true,
    );
  }

  private async processTextPart(
    part: TextPart,
    sessionState: SessionState,
    linearClient: LinearService,
  ): Promise<Result<void, Error>> {
    // Skip if the stored role for the messageID is "user", so we don't post it back to Linear
    const messageRole = this.messageRoleMap.get(part.messageID);
    if (messageRole === "user") return Result.ok();

    return linearClient.postActivity(
      sessionState.linearSessionId,
      { type: "response", body: part.text.trim() },
      false,
    );
  }

  private async processEventSessionError(
    event: EventSessionError,
    sessionState: SessionState,
    linearClient: LinearService,
  ): Promise<Result<void, Error>> {
    const body = `**Error: ${event.properties.error?.name ?? "UndefinedError"}**
\`\`\`json\n${JSON.stringify(event.properties.error?.data ?? {})}\n\`\`\``.trim();

    return linearClient.postActivity(
      sessionState.linearSessionId,
      {
        type: "error",
        body,
      },
      false,
    );
  }

  private async processEventQuestionAsked(
    event: EventQuestionAsked,
    sessionState: SessionState,
    linearClient: LinearService,
  ): Promise<Result<void, Error>> {
    const saved = await this.agentState.question.put(
      sessionState.linearSessionId,
      {
        requestId: event.properties.id,
        opencodeSessionId: sessionState.opencodeSessionId,
        linearSessionId: sessionState.linearSessionId,
        workdir: sessionState.workdir ?? "",
        issueId: sessionState.issueId,
        questions: event.properties.questions,
        answers: event.properties.questions.map(() => null),
        createdAt: Date.now(),
      },
    );
    if (Result.isError(saved)) {
      return Result.err(new Error(saved.error.message));
    }

    for (const questionInfo of event.properties.questions) {
      const posted = await linearClient.postElicitation(
        sessionState.linearSessionId,
        questionInfo.question,
        "select",
        {
          options: questionInfo.options.map((opencodeQuestionOption) => ({
            label: opencodeQuestionOption.description,
            value: opencodeQuestionOption.label,
          })),
        },
      );
      if (Result.isError(posted)) {
        return posted;
      }
    }

    return Result.ok();
  }

  private async processEventPermissionAsked(
    event: EventPermissionAsked,
    sessionState: SessionState,
    linearClient: LinearService,
  ): Promise<Result<void, Error>> {
    const { id, sessionID, permission, patterns, metadata } = event.properties;

    const patternsList =
      patterns.length > 0
        ? `\n\n**Patterns:**\n${patterns.map((p) => `- \`${p}\``).join("\n")}`
        : "";
    const body = `**Permission Request: ${permission}**${patternsList}\n\nPlease approve or reject this tool call.`;

    await this.agentState.permission.put(sessionState.linearSessionId, {
      requestId: id,
      opencodeSessionId: sessionID,
      linearSessionId: sessionState.linearSessionId,
      workdir: sessionState.workdir ?? "",
      issueId: sessionState.issueId,
      permission,
      patterns,
      metadata,
      createdAt: Date.now(),
    });

    return linearClient.postElicitation(
      sessionState.linearSessionId,
      body,
      "select",
      {
        options: [
          { value: "Approve" },
          { value: "Approve Always" },
          { value: "Reject" },
        ],
      },
    );
  }

  private async processEventTodoUpdated(
    event: EventTodoUpdated,
    sessionState: SessionState,
    linearClient: LinearService,
  ): Promise<Result<void, Error>> {
    return linearClient.updatePlan(
      sessionState.linearSessionId,
      event.properties.todos.map((opencodeTodo) => ({
        content: opencodeTodo.content,
        status: mapTodoStatus(opencodeTodo.status),
      })),
    );
  }

  private processEventSessionIdle(
    _event: EventSessionIdle,
    _sessionState: SessionState,
    _linearClient: LinearService,
  ): Result<void, Error> {
    // Intentionally do nothing here.
    return Result.ok();
  }

  private resolveOpencodeSessionIdFromEvent(
    event: Event,
  ): Result<string, Error> {
    if (event.type === "message.part.updated") {
      return Result.ok(event.properties.part.sessionID);
    } else if (event.type === "message.updated") {
      return Result.ok(event.properties.info.sessionID);
    } else if (
      event.type === "session.idle" ||
      event.type === "question.asked" ||
      event.type === "permission.asked" ||
      event.type === "todo.updated"
    ) {
      return Result.ok(event.properties.sessionID);
    } else if (event.type === "session.error") {
      if (event.properties.sessionID) {
        return Result.ok(event.properties.sessionID);
      } else {
        return Result.err(
          new Error("Opencode session.error event is missing sessionID"),
        );
      }
    }

    return Result.err(
      // This case should really return a TaggedError, but this code will be refactored soon
      new Error(`Skipping processing for event: ${event.type}`),
    );
  }
}
