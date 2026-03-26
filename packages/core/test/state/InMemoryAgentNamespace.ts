import { MemoryKeyValueStore } from "./MemoryKeyValueStore";
import type { AgentStateNamespace } from "../../src/state/root";
import {
  authRecordSchema,
  oauthStateRecordSchema,
  pendingPermissionSchema,
  pendingQuestionSchema,
  pendingRepoSelectionSchema,
  sessionByOpencodeRecordSchema,
  sessionStateSchema,
} from "../../src/state/schema";

export function createInMemoryAgentState(): AgentStateNamespace {
  return {
    auth: new MemoryKeyValueStore(authRecordSchema),
    oauthState: new MemoryKeyValueStore(oauthStateRecordSchema),
    session: new MemoryKeyValueStore(sessionStateSchema),
    sessionByOpencode: new MemoryKeyValueStore(sessionByOpencodeRecordSchema),
    question: new MemoryKeyValueStore(pendingQuestionSchema),
    permission: new MemoryKeyValueStore(pendingPermissionSchema),
    repoSelection: new MemoryKeyValueStore(pendingRepoSelectionSchema),
  };
}
