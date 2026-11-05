import { describe, expect, it } from "vitest";
import type { CliSessionBinding } from "../../config/sessions/types.js";
import { buildCliSessionDriftNote, stripCliSessionDriftNote } from "../cli-session.js";
import { resolvePersistedCliBindingToolHashes } from "./cli-run-settlement.js";
import { resolveNarrowedMcpCompletionResume } from "./narrowed-mcp-resume.js";
import type { PreparedCliRunContext } from "./types.js";

const binding: CliSessionBinding = {
  sessionId: "native-main",
  promptToolNamesHash: "full-tools",
  mcpConfigHash: "full-mcp",
  mcpResumeHash: "full-resume",
};
const announce = {
  kind: "inter_session",
  sourceSessionKey: "agent:main:subagent:child",
  sourceTool: "subagent_announce",
};
const base = {
  candidate: { mode: "invalidate" as const, invalidatedReason: "mcp" as const },
  binding,
  isClaudeCli: true,
  exclusiveLoopbackTools: true,
  inputProvenance: announce,
};

describe("resolveNarrowedMcpCompletionResume", () => {
  it("resumes the requester session for a narrowed completion relay and keeps its hashes", () => {
    expect(resolveNarrowedMcpCompletionResume(base)).toEqual({
      reuse: {
        mode: "reuse-with-drift",
        sessionId: "native-main",
        drift: { reasons: ["mcp-narrowed"] },
      },
      retainedBindingToolHashes: {
        promptToolNamesHash: "full-tools",
        mcpConfigHash: "full-mcp",
        mcpResumeHash: "full-resume",
      },
    });
  });

  it.each([
    ["an ordinary user turn", { inputProvenance: { kind: "external_user" } }],
    ["no provenance", { inputProvenance: undefined }],
    [
      "a peer session message",
      { inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" } },
    ],
    ["a full MCP topology", { exclusiveLoopbackTools: false }],
    ["another CLI backend", { isClaudeCli: false }],
    ["an auth change", { candidate: { mode: "invalidate", invalidatedReason: "auth-epoch" } }],
    ["a cwd change", { candidate: { mode: "invalidate", invalidatedReason: "cwd" } }],
    ["no stored session", { binding: undefined }],
    ["a borrowed native session", { binding: { ...binding, forceReuse: true } }],
  ] as const)("leaves the reset alone for %s", (_name, override) => {
    const params = { ...base, ...override } as Parameters<
      typeof resolveNarrowedMcpCompletionResume
    >[0];
    expect(resolveNarrowedMcpCompletionResume(params)).toEqual({ reuse: params.candidate });
  });
});

describe("mcp-narrowed drift note", () => {
  it("is stripped from native transcript text like the other drift notes", () => {
    const note = buildCliSessionDriftNote(["mcp-narrowed"]);
    expect(note).toContain("changed=mcp-narrowed");
    expect(stripCliSessionDriftNote(`${note}\n\nchild result`)).toBe("child result");
  });
});

describe("resolvePersistedCliBindingToolHashes", () => {
  const narrowed = {
    promptToolNamesHash: "message-only",
    preparedBackend: { mcpConfigHash: "loopback", mcpResumeHash: "loopback-resume" },
    retainedBindingToolHashes: {
      promptToolNamesHash: "full-tools",
      mcpConfigHash: "full-mcp",
      mcpResumeHash: "full-resume",
    },
    reusableCliSession: {
      mode: "reuse-with-drift",
      sessionId: "native-main",
      drift: { reasons: ["mcp-narrowed"] },
    },
  } as unknown as PreparedCliRunContext;

  it("persists the session's own hashes after a narrowed relay resumed it", () => {
    expect(resolvePersistedCliBindingToolHashes(narrowed, "native-main")).toEqual(
      narrowed.retainedBindingToolHashes,
    );
  });

  it("persists the run's hashes when the relay ended in a different native session", () => {
    expect(resolvePersistedCliBindingToolHashes(narrowed, "native-new")).toEqual({
      promptToolNamesHash: "message-only",
      mcpConfigHash: "loopback",
      mcpResumeHash: "loopback-resume",
    });
    expect(
      resolvePersistedCliBindingToolHashes(
        { ...narrowed, retainedBindingToolHashes: undefined },
        "native-main",
      ),
    ).toEqual({
      promptToolNamesHash: "message-only",
      mcpConfigHash: "loopback",
      mcpResumeHash: "loopback-resume",
    });
  });
});
