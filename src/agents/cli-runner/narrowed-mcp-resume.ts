import type { CliSessionBinding } from "../../config/sessions/types.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../sessions/input-provenance.js";
import type { CliSessionReuseResult } from "../cli-session.js";

export type CliRetainedBindingToolHashes = {
  promptToolNamesHash?: string;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
};

/**
 * A message-only completion relay (subagent announce, settle, approval follow-up) serves only
 * the loopback MCP server under a per-turn grant, so its MCP hash never matches the requester's
 * session. Resetting there started a fresh native session without the conversation, and the
 * relay answered blind. The relay's topology is a strict subset of the session's and it never
 * owns the session binding, so it resumes the session's own transcript with narrower tools.
 * It does not gain any tool: the grant, `--tools` and the PreToolUse policy keep its cap.
 */
export function resolveNarrowedMcpCompletionResume(params: {
  candidate: CliSessionReuseResult;
  binding: CliSessionBinding | undefined;
  isClaudeCli: boolean;
  /** The runtime cap replaced the merged MCP topology with the agent loopback server. */
  exclusiveLoopbackTools: boolean;
  inputProvenance: unknown;
}): { reuse: CliSessionReuseResult; retainedBindingToolHashes?: CliRetainedBindingToolHashes } {
  const { candidate, binding } = params;
  const sessionId = binding?.sessionId?.trim();
  if (
    candidate.mode !== "invalidate" ||
    candidate.invalidatedReason !== "mcp" ||
    !sessionId ||
    binding?.forceReuse === true ||
    !params.isClaudeCli ||
    !params.exclusiveLoopbackTools ||
    !shouldPreserveUserFacingSessionStateForInputProvenance(params.inputProvenance)
  ) {
    return { reuse: candidate };
  }
  return {
    reuse: { mode: "reuse-with-drift", sessionId, drift: { reasons: ["mcp-narrowed"] } },
    // Whatever settlement persists must still describe the session's full topology;
    // otherwise the next ordinary turn would see this relay's subset and reset.
    retainedBindingToolHashes: {
      ...(binding?.promptToolNamesHash ? { promptToolNamesHash: binding.promptToolNamesHash } : {}),
      ...(binding?.mcpConfigHash ? { mcpConfigHash: binding.mcpConfigHash } : {}),
      ...(binding?.mcpResumeHash ? { mcpResumeHash: binding.mcpResumeHash } : {}),
    },
  };
}
