import type { KeyValueStore } from "../kv/types";
import {
  authRecordSchema,
  oauthStateRecordSchema,
  pendingPermissionSchema,
  pendingQuestionSchema,
  pendingRepoSelectionSchema,
  sessionByOpencodeRecordSchema,
  sessionStateSchema,
  type OAuthStateRecord,
  type SessionByOpencodeRecord,
  type AuthRecord,
} from "./schema";
import type {
  PendingPermission,
  PendingQuestion,
  PendingRepoSelection,
} from "../session/SessionRepository";
import type { SessionState } from "../session/SessionState";
import { FileKeyValueStore } from "../kv/file/FileKeyValueStore";
import { getStateRootPath } from "../utils/paths";

export interface AgentStateNamespace {
  auth: KeyValueStore<AuthRecord>;
  oauthState: KeyValueStore<OAuthStateRecord>;
  session: KeyValueStore<SessionState>;
  sessionByOpencode: KeyValueStore<SessionByOpencodeRecord>;
  question: KeyValueStore<PendingQuestion>;
  permission: KeyValueStore<PendingPermission>;
  repoSelection: KeyValueStore<PendingRepoSelection>;
}

export function createFileAgentState(
  path: string = getStateRootPath(),
): AgentStateNamespace {
  return {
    auth: new FileKeyValueStore("auth", path, authRecordSchema),
    oauthState: new FileKeyValueStore(
      "oauth-state",
      path,
      oauthStateRecordSchema,
    ),
    session: new FileKeyValueStore("session", path, sessionStateSchema),
    sessionByOpencode: new FileKeyValueStore(
      "session-by-opencode",
      path,
      sessionByOpencodeRecordSchema,
    ),
    question: new FileKeyValueStore("question", path, pendingQuestionSchema),
    permission: new FileKeyValueStore(
      "permission",
      path,
      pendingPermissionSchema,
    ),
    repoSelection: new FileKeyValueStore(
      "repo-selection",
      path,
      pendingRepoSelectionSchema,
    ),
  };
}
