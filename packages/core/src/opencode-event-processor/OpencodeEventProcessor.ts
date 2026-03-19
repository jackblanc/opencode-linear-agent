import type {
  Event,
  EventMessagePartUpdated,
  EventPermissionAsked,
  EventQuestionAsked,
  EventSessionError,
  EventSessionIdle,
  EventTodoUpdated,
  ReasoningPart,
  TextPart,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import type { LinearService } from "../linear/LinearService";
import type { AgentStateNamespace } from "../state/root";
import { Result } from "better-result";
import type { SessionState } from "../session/SessionState";

export class OpencodeEventProcessor {
  constructor(
    private readonly log: (message: string) => void,
    private readonly agentState: AgentStateNamespace,
    private readonly linearClientProvider: (token: string) => LinearService,
  ) {}

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
        }

        return Result.ok(undefined);
      }.bind(this),
    );
  }

  private processEventMessagePartUpdated(
    event: EventMessagePartUpdated,
    _sessionState: SessionState,
    _linearClient: LinearService,
  ) {
    switch (event.properties.part.type) {
      case "tool":
        return this.processToolPart(event.properties.part);
      case "reasoning":
        return this.processReasoningPart(event.properties.part);
      case "text":
        return this.processTextPart(event.properties.part);
    }

    return Result.ok();
  }

  private processToolPart(_part: ToolPart) {
    return Result.ok();
  }

  private processReasoningPart(_part: ReasoningPart) {
    return Result.ok();
  }

  private processTextPart(_part: TextPart) {
    return Result.ok();
  }

  private processEventSessionError(
    _event: EventSessionError,
    _sessionState: SessionState,
    _linearClient: LinearService,
  ) {
    return Result.ok();
  }

  private processEventQuestionAsked(
    _event: EventQuestionAsked,
    _sessionState: SessionState,
    _linearClient: LinearService,
  ): Result<void, Error> {
    return Result.ok();
  }

  private processEventPermissionAsked(
    _event: EventPermissionAsked,
    _sessionState: SessionState,
    _linearClient: LinearService,
  ): Result<void, Error> {
    return Result.ok();
  }

  private processEventTodoUpdated(
    _event: EventTodoUpdated,
    _sessionState: SessionState,
    _linearClient: LinearService,
  ): Result<void, Error> {
    return Result.ok();
  }

  private processEventSessionIdle(
    _event: EventSessionIdle,
    _sessionState: SessionState,
    _linearClient: LinearService,
  ): Result<void, Error> {
    return Result.ok();
  }

  private resolveOpencodeSessionIdFromEvent(
    event: Event,
  ): Result<string, Error> {
    if (event.type === "message.part.updated") {
      return Result.ok(event.properties.part.sessionID);
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
      new Error(
        `Failed to resolve Opencode Session ID from event: ${event.type}`,
      ),
    );
  }
}
