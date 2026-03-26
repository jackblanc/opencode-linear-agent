import type { QuestionInfo } from "@opencode-ai/sdk/v2";
import { z } from "zod";

import type {
  PendingPermission,
  PendingQuestion,
  PendingRepoSelection,
  RepoSelectionOption,
} from "../session/SessionRepository";
import type { SessionState } from "../session/SessionState";

export interface SessionByOpencodeRecord {
  linearSessionId: string;
}

export interface OAuthStateRecord {
  state: string;
  createdAt: number;
  expiresAt: number;
}

const questionOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
});

const questionInfoSchema: z.ZodType<QuestionInfo> = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(questionOptionSchema),
  multiple: z.boolean().optional(),
});

const repoSelectionOptionSchema: z.ZodType<RepoSelectionOption> = z.object({
  label: z.string(),
  labelValue: z.string(),
  aliases: z.array(z.string()),
});

export const sessionStateSchema: z.ZodType<SessionState> = z.object({
  opencodeSessionId: z.string(),
  linearSessionId: z.string(),
  organizationId: z.string(),
  issueId: z.string(),
  repoDirectory: z.string().optional(),
  branchName: z.string(),
  workdir: z.string(),
  lastActivityTime: z.number(),
});

export const sessionByOpencodeRecordSchema: z.ZodType<SessionByOpencodeRecord> =
  z.object({
    linearSessionId: z.string(),
  });

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

export const oauthStateRecordSchema: z.ZodType<OAuthStateRecord> = z.object({
  state: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
});

export const pendingQuestionSchema: z.ZodType<PendingQuestion> = z.object({
  requestId: z.string(),
  opencodeSessionId: z.string(),
  linearSessionId: z.string(),
  workdir: z.string(),
  issueId: z.string(),
  questions: z.array(questionInfoSchema),
  answers: z.array(z.array(z.string()).nullable()),
  createdAt: z.number(),
});

export const pendingPermissionSchema: z.ZodType<PendingPermission> = z.object({
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

export const pendingRepoSelectionSchema: z.ZodType<PendingRepoSelection> =
  z.object({
    linearSessionId: z.string(),
    issueId: z.string(),
    options: z.array(repoSelectionOptionSchema),
    promptContext: z.string().optional(),
    createdAt: z.number(),
  });
