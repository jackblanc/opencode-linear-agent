/**
 * Action types and execution functions for functional event processing
 *
 * This module provides the abstraction layer that decouples "what to do"
 * from "how to do it" per AGENTS.md design principles:
 *
 * - Events come FROM Linear/OpenCode (inputs)
 * - Actions go TO Linear/OpenCode (outputs)
 * - Pure processing functions return action objects
 * - Execute functions route actions to the appropriate service
 * - Transport layer (webhooks, SSE, plugins) is abstracted away
 */

export { executeActions } from "./execute";
