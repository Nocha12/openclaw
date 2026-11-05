import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveCompletionToolPolicy } from "./attempt-execution.helpers.js";
import type { AgentCommandOpts } from "./types.js";

const REQUESTER_TOOLS = ["read", "exec", "sessions_spawn", "automations", "message"];

function resolve(
  overrides: {
    opts?: Partial<AgentCommandOpts>;
    sessionEntry?: Partial<SessionEntry>;
    trusted?: boolean;
    rawModelRun?: boolean;
    provider?: string;
    cli?: boolean;
    needsMessageDelivery?: boolean;
    requesterAllowsMessage?: boolean;
  } = {},
) {
  const sessionEntry = { sessionId: "requester", updatedAt: 1, ...overrides.sessionEntry };
  return resolveCompletionToolPolicy({
    run: {
      sessionEntry: sessionEntry as SessionEntry,
      opts: {
        message: "completion",
        sourceReplyDeliveryMode: "message_tool_only",
        toolsAllow: [...REQUESTER_TOOLS],
        ...overrides.opts,
      } as AgentCommandOpts,
    },
    trustedSubagentAnnounceHandoff: overrides.trusted ?? true,
    isSubagentAnnounceHandoff: true,
    isRawModelRun: overrides.rawModelRun ?? false,
    isCliExecutionProvider: overrides.cli ?? true,
    cliExecutionProvider: overrides.provider ?? "claude-cli",
    completionNeedsMessageDelivery: overrides.needsMessageDelivery ?? true,
    completionRequesterAllowsMessage: overrides.requesterAllowsMessage ?? true,
  });
}

describe("resolveCompletionToolPolicy", () => {
  it("keeps requester tools for a verified Claude CLI completion under message-only delivery", () => {
    expect(resolve()).toEqual({
      completionRetainsRequesterTools: true,
      runtimeToolsAllow: REQUESTER_TOOLS,
      disableTools: false,
    });
  });

  it("keeps requester tools for a verified Claude CLI completion under automatic delivery", () => {
    expect(
      resolve({
        opts: { sourceReplyDeliveryMode: "automatic" },
        needsMessageDelivery: false,
        requesterAllowsMessage: false,
      }),
    ).toMatchObject({ completionRetainsRequesterTools: true, runtimeToolsAllow: REQUESTER_TOOLS });
  });

  it("keeps the narrow message grant when only the source-bound grant admits message", () => {
    expect(resolve({ requesterAllowsMessage: false })).toEqual({
      completionRetainsRequesterTools: false,
      runtimeToolsAllow: ["message"],
      disableTools: false,
    });
  });

  it.each([
    ["a node-hosted requester", { sessionEntry: { execHost: "node" as const } }],
    ["a non-Claude CLI runtime", { provider: "google-gemini-cli" }],
    ["an unverified handoff", { trusted: false }],
    ["a raw model run", { rawModelRun: true }],
    [
      "a settle batch",
      {
        opts: {
          trustedInternalHandoff: {
            kind: "subagent-completion",
            sourceSessionKey: "agent:main:subagent:child",
            targetSessionKey: "agent:main:main",
            targetSessionId: "requester",
            provider: "claude-cli",
            model: "opus",
            settleBatch: {
              sourceSessionKeys: ["agent:main:subagent:child"],
              isCurrent: () => true,
            },
          },
        } satisfies Partial<AgentCommandOpts>,
      },
    ],
  ])("keeps the narrow message grant for %s", (_name, overrides) => {
    expect(resolve(overrides)).toMatchObject({
      completionRetainsRequesterTools: false,
      runtimeToolsAllow: ["message"],
    });
  });
});
