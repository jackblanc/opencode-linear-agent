import type { EventQuestionAsked } from "@opencode-ai/sdk/v2";

import { Result } from "better-result";
import { describe, expect, test } from "vitest";

import { OpencodeEventProcessor } from "../../src/opencode-event-processor/OpencodeEventProcessor";
import { TestLinearService } from "../linear-service/TestLinearService";
import { createInMemoryAgentState } from "../state/InMemoryAgentNamespace";

describe("OpencodeEventProcessor.processEvent", () => {
  test("handles question.asked without returning a promise from Result.gen", async () => {
    const agentState = createInMemoryAgentState();
    const elicitations: Array<{ body: string; metadata: unknown }> = [];
    class RecordingLinearService extends TestLinearService {
      override async postElicitation(
        sessionId: string,
        body: string,
        signal: Parameters<TestLinearService["postElicitation"]>[2],
        metadata?: Parameters<TestLinearService["postElicitation"]>[3],
      ) {
        elicitations.push({ body, metadata });
        return super.postElicitation(sessionId, body, signal, metadata);
      }
    }

    const linear = new RecordingLinearService();
    const processor = new OpencodeEventProcessor(agentState, () => linear);

    expect(
      await agentState.auth.put("org-1", {
        organizationId: "org-1",
        accessToken: "linear-token",
        accessTokenExpiresAt: Date.now() + 60_000,
        refreshToken: "refresh-token",
        appId: "app-1",
        installedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        workspaceName: "Test Workspace",
      }),
    ).toEqual(Result.ok(undefined));
    expect(
      await agentState.sessionByOpencode.put("opencode-1", {
        linearSessionId: "linear-session-1",
      }),
    ).toEqual(Result.ok(undefined));
    expect(
      await agentState.session.put("linear-session-1", {
        opencodeSessionId: "opencode-1",
        linearSessionId: "linear-session-1",
        organizationId: "org-1",
        issueId: "issue-1",
        projectId: "project-1",
        branchName: "feature/code-1",
        workdir: "/tmp/workdir",
        lastActivityTime: Date.now(),
      }),
    ).toEqual(Result.ok(undefined));

    const event: EventQuestionAsked = {
      type: "question.asked",
      properties: {
        id: "question-1",
        sessionID: "opencode-1",
        questions: [
          {
            question: "What next?",
            header: "Choice",
            options: [{ label: "ship", description: "Ship now" }],
          },
        ],
      },
    };

    const result = await processor.processEvent(event);

    expect(Result.isOk(result)).toBe(true);
    expect(elicitations).toEqual([
      {
        body: "What next?",
        metadata: {
          options: [{ label: "Ship now", value: "ship" }],
        },
      },
    ]);

    const pending = await agentState.question.get("linear-session-1");
    expect(Result.isOk(pending)).toBe(true);
    if (Result.isOk(pending)) {
      expect(pending.value.requestId).toBe("question-1");
      expect(pending.value.opencodeSessionId).toBe("opencode-1");
      expect(pending.value.answers).toEqual([null]);
    }
  });
});
