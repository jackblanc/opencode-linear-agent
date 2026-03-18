import { z } from "zod";

import { createFileStateRoot } from "../kv/file/FileStateRoot";
import type { KvNamespaceStore } from "../kv/types";

const jsonValueSchema = z.unknown();

const STATE_NAMESPACES = {
  auth: "auth",
  oauthState: "oauth-state",
  session: "session",
  sessionByOpencode: "session-by-opencode",
  question: "question",
  permission: "permission",
  repoSelection: "repo-selection",
} as const;

interface AgentStateNamespaces {
  auth: KvNamespaceStore<unknown>;
  oauthState: KvNamespaceStore<unknown>;
  session: KvNamespaceStore<unknown>;
  sessionByOpencode: KvNamespaceStore<unknown>;
  question: KvNamespaceStore<unknown>;
  permission: KvNamespaceStore<unknown>;
  repoSelection: KvNamespaceStore<unknown>;
}

export function createFileAgentState(path: string): AgentStateNamespaces {
  const root = createFileStateRoot(path);

  return {
    auth: root.namespace(STATE_NAMESPACES.auth, jsonValueSchema),
    oauthState: root.namespace(STATE_NAMESPACES.oauthState, jsonValueSchema),
    session: root.namespace(STATE_NAMESPACES.session, jsonValueSchema),
    sessionByOpencode: root.namespace(
      STATE_NAMESPACES.sessionByOpencode,
      jsonValueSchema,
    ),
    question: root.namespace(STATE_NAMESPACES.question, jsonValueSchema),
    permission: root.namespace(STATE_NAMESPACES.permission, jsonValueSchema),
    repoSelection: root.namespace(
      STATE_NAMESPACES.repoSelection,
      jsonValueSchema,
    ),
  };
}
