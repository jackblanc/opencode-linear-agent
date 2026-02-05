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

/**
 * Handler state for event processing
 *
 * This state is maintained during event processing to track
 * what has been sent to avoid duplicates. It is separate from
 * SessionState because it's transient per-session-run.
 *
 * When a session is resumed, handler state starts fresh because:
 * - Tool/text part IDs are unique per message
 * - We don't need to track across session restarts
 */
export interface HandlerState {
  /** Tool IDs we've posted "running" state for */
  runningTools: Set<string>;
  /** Text part IDs we've already posted */
  sentTextParts: Set<string>;
  /** Whether we've posted a final response (for session completion) */
  postedFinalResponse: boolean;
  /** Whether we've posted an error activity (prevents duplicate error posts) */
  postedError: boolean;
  /** Latest response text across all messages - posted as response on session.idle */
  latestResponseText: string | undefined;
}

/**
 * Create initial handler state
 */
export function createInitialHandlerState(): HandlerState {
  return {
    runningTools: new Set(),
    sentTextParts: new Set(),
    postedFinalResponse: false,
    postedError: false,
    latestResponseText: undefined,
  };
}
