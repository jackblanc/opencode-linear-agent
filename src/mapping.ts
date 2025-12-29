import type { Part } from "@opencode-ai/sdk";
import type { LinearActivityContent, MappingResult } from "./types";
import {
  getToolActionName,
  extractToolParameter,
  formatToolResult,
} from "./types";

/**
 * Map an OpenCode Part to a Linear AgentActivity
 */
export function mapPartToActivity(part: Part): MappingResult | null {
  switch (part.type) {
    case "text":
      // Final text output from the AI - this is the response
      return {
        content: {
          type: "response",
          body: part.text,
        },
        ephemeral: false,
      };

    case "reasoning":
      // Internal reasoning - show as ephemeral thought
      return {
        content: {
          type: "thought",
          body: part.text,
        },
        ephemeral: true,
      };

    case "tool": {
      const { tool, state } = part;

      switch (state.status) {
        case "pending":
          // Tool is queued - ephemeral thought
          return {
            content: {
              type: "thought",
              body: `Preparing to use ${tool}...`,
            },
            ephemeral: true,
          };

        case "running": {
          // Tool is running - ephemeral action without result
          const action = getToolActionName(tool, state);
          const parameter = extractToolParameter(tool, state.input);
          return {
            content: {
              type: "action",
              action,
              parameter,
            },
            ephemeral: true,
          };
        }

        case "completed": {
          // Tool completed - action with result
          const action = getToolActionName(tool, state);
          const parameter = extractToolParameter(tool, state.input);
          const result = formatToolResult(state.output);
          return {
            content: {
              type: "action",
              action,
              parameter,
              result,
            },
            ephemeral: false,
          };
        }

        case "error": {
          // Tool failed - error activity
          return {
            content: {
              type: "error",
              body: `Failed to ${tool}: ${state.error}`,
            },
            ephemeral: false,
          };
        }

        default:
          return null;
      }
    }

    case "step-start":
      // Agent starting a step - ephemeral thought
      return {
        content: {
          type: "thought",
          body: "Starting work...",
        },
        ephemeral: true,
      };

    case "step-finish":
      // Step finished - don't create activity (implicit)
      return null;

    case "subtask":
      // Subtask delegation - thought
      return {
        content: {
          type: "thought",
          body: `Delegating subtask: ${part.description}`,
        },
        ephemeral: false,
      };

    case "agent":
      // Agent switch - thought
      return {
        content: {
          type: "thought",
          body: `Switching to ${part.name} agent`,
        },
        ephemeral: false,
      };

    case "retry":
      // Retry after error - ephemeral thought
      return {
        content: {
          type: "thought",
          body: `Retrying after error (attempt ${part.attempt})...`,
        },
        ephemeral: true,
      };

    case "file":
    case "snapshot":
    case "patch":
    case "compaction":
      // These don't map to Linear activities directly
      return null;

    default:
      return null;
  }
}

/**
 * Map OpenCode error to Linear error activity
 */
export function mapErrorToActivity(error: Error): LinearActivityContent {
  return {
    type: "error",
    body: `OpenCode error: ${error.message}`,
  };
}
