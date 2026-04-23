import type { AgentStateNamespace } from "../../src/state/root";

import {
  authRecordSchema,
  issueWorkspaceSchema,
  oauthStateRecordSchema,
  pendingPermissionSchema,
  pendingQuestionSchema,
  pendingRepoSelectionSchema,
  sessionByOpencodeRecordSchema,
  sessionStateSchema,
} from "../../src/state/schema";
import { MemoryKeyValueStore } from "./MemoryKeyValueStore";

export function createInMemoryAgentState(): AgentStateNamespace {
  return {
    auth: new MemoryKeyValueStore(authRecordSchema),
    oauthState: new MemoryKeyValueStore(oauthStateRecordSchema),
    issueWorkspace: new MemoryKeyValueStore(issueWorkspaceSchema),
    session: new MemoryKeyValueStore(sessionStateSchema),
    sessionByOpencode: new MemoryKeyValueStore(sessionByOpencodeRecordSchema),
    question: new MemoryKeyValueStore(pendingQuestionSchema),
    permission: new MemoryKeyValueStore(pendingPermissionSchema),
    repoSelection: new MemoryKeyValueStore(pendingRepoSelectionSchema),
  };
}
