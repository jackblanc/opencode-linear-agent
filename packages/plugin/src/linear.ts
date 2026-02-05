import {
  LinearServiceImpl,
  type LinearService,
} from "@linear-opencode-agent/core";

export function createLinearService(accessToken: string): LinearService {
  return new LinearServiceImpl(accessToken);
}
