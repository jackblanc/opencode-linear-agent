import type { KeyValueStore } from "../kv/types";
import type {
  OAuthStateRecord,
  AuthRecord,
  IssueWorkspace,
  SessionState,
  SessionByOpencodeRecord,
  PendingPermission,
  PendingQuestion,
  PendingRepoSelection,
} from "./schema";

import { FileKeyValueStore } from "../kv/file/FileKeyValueStore";
import { getStateRootDirectoryPath } from "../utils/paths";
import {
  authRecordSchema,
  issueWorkspaceSchema,
  oauthStateRecordSchema,
  pendingPermissionSchema,
  pendingQuestionSchema,
  pendingRepoSelectionSchema,
  sessionByOpencodeRecordSchema,
  sessionStateSchema,
} from "./schema";

export interface AgentStateNamespace {
  auth: KeyValueStore<AuthRecord>;
  oauthState: KeyValueStore<OAuthStateRecord>;
  issueWorkspace: KeyValueStore<IssueWorkspace>;
  session: KeyValueStore<SessionState>;
  sessionByOpencode: KeyValueStore<SessionByOpencodeRecord>;
  question: KeyValueStore<PendingQuestion>;
  permission: KeyValueStore<PendingPermission>;
  repoSelection: KeyValueStore<PendingRepoSelection>;
}

export function createFileAgentState(
  path: string = getStateRootDirectoryPath(),
): AgentStateNamespace {
  return {
    auth: new FileKeyValueStore("auth", path, authRecordSchema),
    oauthState: new FileKeyValueStore("oauth-state", path, oauthStateRecordSchema),
    issueWorkspace: new FileKeyValueStore("issue-workspace", path, issueWorkspaceSchema),
    session: new FileKeyValueStore("session", path, sessionStateSchema),
    sessionByOpencode: new FileKeyValueStore(
      "session-by-opencode",
      path,
      sessionByOpencodeRecordSchema,
    ),
    question: new FileKeyValueStore("question", path, pendingQuestionSchema),
    permission: new FileKeyValueStore("permission", path, pendingPermissionSchema),
    repoSelection: new FileKeyValueStore("repo-selection", path, pendingRepoSelectionSchema),
  };
}
