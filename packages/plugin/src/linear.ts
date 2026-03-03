import {
  LinearServiceImpl,
  type LinearService,
} from "@opencode-linear-agent/core";

export function createLinearService(accessToken: string): LinearService {
  return new LinearServiceImpl(accessToken);
}
