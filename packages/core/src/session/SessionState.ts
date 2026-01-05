/**
 * Session state persisted in storage
 */
export interface SessionState {
  opencodeSessionId: string;
  linearSessionId: string;
  issueId: string;
  branchName: string;
  workdir: string;
  lastActivityTime: number;
}
