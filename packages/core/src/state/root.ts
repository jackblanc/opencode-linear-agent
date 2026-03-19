import { createFileStateRoot } from "../kv/file/FileStateRoot";
import type { KvNamespaceStore } from "../kv/types";
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
} from "./schema";
import type {
  PendingPermission,
  PendingQuestion,
  PendingRepoSelection,
} from "../session/SessionRepository";
import type { SessionState } from "../session/SessionState";
import type { AuthRecord } from "../storage/types";

const STATE_NAMESPACES = {
  auth: "auth",
  oauthState: "oauth-state",
  session: "session",
  sessionByOpencode: "session-by-opencode",
  question: "question",
  permission: "permission",
  repoSelection: "repo-selection",
} as const;

interface AgentStateNamespace {
  auth: KvNamespaceStore<AuthRecord>;
  oauthState: KvNamespaceStore<OAuthStateRecord>;
  session: KvNamespaceStore<SessionState>;
  sessionByOpencode: KvNamespaceStore<SessionByOpencodeRecord>;
  question: KvNamespaceStore<PendingQuestion>;
  permission: KvNamespaceStore<PendingPermission>;
  repoSelection: KvNamespaceStore<PendingRepoSelection>;
}

export function createFileAgentState(path: string): AgentStateNamespace {
  const root = createFileStateRoot(path);

  return {
    auth: root.namespace(STATE_NAMESPACES.auth, authRecordSchema),
    oauthState: root.namespace(
      STATE_NAMESPACES.oauthState,
      oauthStateRecordSchema,
    ),
    session: root.namespace(STATE_NAMESPACES.session, sessionStateSchema),
    sessionByOpencode: root.namespace(
      STATE_NAMESPACES.sessionByOpencode,
      sessionByOpencodeRecordSchema,
    ),
    question: root.namespace(STATE_NAMESPACES.question, pendingQuestionSchema),
    permission: root.namespace(
      STATE_NAMESPACES.permission,
      pendingPermissionSchema,
    ),
    repoSelection: root.namespace(
      STATE_NAMESPACES.repoSelection,
      pendingRepoSelectionSchema,
    ),
  };
}
