/**
 * Session state persisted in storage
 */
export interface SessionState {
  opencodeSessionId: string;
  linearSessionId: string;
  organizationId: string;
  issueId: string;
  repoDirectory?: string;
  branchName: string;
  workdir: string;
  lastActivityTime: number;
}
