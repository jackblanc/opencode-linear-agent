import type { QuestionInfo } from "@opencode-ai/sdk/v2";

import { z } from "zod";

export const authRecordSchema = z.object({
  organizationId: z.string(),
  accessToken: z.string(),
  accessTokenExpiresAt: z.number(),
  refreshToken: z.string(),
  appId: z.string(),
  installedAt: z.string(),
  workspaceName: z.string().optional(),
});

export type AuthRecord = z.infer<typeof authRecordSchema>;

export const oauthStateRecordSchema = z.object({
  state: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
});

export type OAuthStateRecord = z.infer<typeof oauthStateRecordSchema>;

// Linear Issue ID (UUID) -> OpenCode Project ID + Workspace ID
export const issueProjectWorkspaceSchema = z.object({
  workspaceID: z.string(), // UUID
});
export type IssueProjectWorkspace = z.infer<typeof issueProjectWorkspaceSchema>;

// Linear's Agent Session ID -> OpenCode's Session ID
export const sessionStateSchema = z.object({
  opencodeSessionId: z.string(),
  organizationId: z.string(),
});

export type SessionState = z.infer<typeof sessionStateSchema>;

// OpenCode's Session ID -> Linear's Agent Session ID
export const sessionByOpencodeRecordSchema = z.object({
  linearSessionId: z.string(),
});

export type SessionByOpencodeRecord = z.infer<typeof sessionByOpencodeRecordSchema>;

// Annotation is necessary to align with OpenCode's SDK type
const questionInfoSchema: z.ZodType<QuestionInfo> = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
    }),
  ),
  multiple: z.boolean().optional(),
});

export const pendingQuestionSchema = z.object({
  requestId: z.string(),
  opencodeSessionId: z.string(),
  linearSessionId: z.string(),
  workdir: z.string(),
  issueId: z.string(),
  questions: z.array(questionInfoSchema),
  answers: z.array(z.array(z.string()).nullable()),
  createdAt: z.number(),
});

export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;

export const pendingPermissionSchema = z.object({
  requestId: z.string(),
  opencodeSessionId: z.string(),
  linearSessionId: z.string(),
  workdir: z.string(),
  issueId: z.string(),
  permission: z.string(),
  patterns: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});

export type PendingPermission = z.infer<typeof pendingPermissionSchema>;

const repoSelectionOptionSchema = z.object({
  label: z.string(),
  projectId: z.string(),
  worktree: z.string(),
  repoLabel: z.string(),
  aliases: z.array(z.string()),
});
export const pendingRepoSelectionSchema = z.object({
  linearSessionId: z.string(),
  issueId: z.string(),
  options: z.array(repoSelectionOptionSchema),
  promptContext: z.string().optional(),
  createdAt: z.number(),
});

export type RepoSelectionOption = z.infer<typeof repoSelectionOptionSchema>;
export type PendingRepoSelection = z.infer<typeof pendingRepoSelectionSchema>;
