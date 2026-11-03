import { describe, expect, it } from "vitest";
import {
  applyChannelConfigEdits,
  buildChannelConfigPatch,
  emptiesStoredSecret,
  writesOverReference,
} from "./channel-config-draft.ts";

const schema = {
  type: "object",
  properties: {
    channels: {
      type: "object",
      properties: {
        telegram: {
          type: "object",
          properties: {
            botToken: { type: "string" },
            timeoutSeconds: { type: "number" },
            allowFrom: { type: "array", items: { type: "string" } },
            proxy: { type: "object", properties: { url: { type: "string" } } },
          },
        },
      },
    },
  },
};

const path = (...rest: Array<string | number>) => ["channels", "telegram", ...rest];

describe("channel config draft", () => {
  it("shows edits over the saved values without changing them", () => {
    const base = { botToken: "__OPENCLAW_REDACTED__", allowFrom: ["a"] };
    const value = applyChannelConfigEdits(base, "telegram", [
      { path: path("botToken"), value: "123:partial" },
      { path: path("allowFrom", 1), value: "b" },
    ]);
    expect(value).toEqual({ botToken: "123:partial", allowFrom: ["a", "b"] });
    expect(base).toEqual({ botToken: "__OPENCLAW_REDACTED__", allowFrom: ["a"] });
  });

  it("sends only what changed, leaving untouched secrets off the wire", () => {
    const built = buildChannelConfigPatch({
      base: { botToken: "__OPENCLAW_REDACTED__", dmPolicy: "pairing" },
      channelId: "telegram",
      edits: [{ path: path("dmPolicy"), value: "open" }],
      schema,
    });
    expect(built).toEqual({
      patch: { channels: { telegram: { dmPolicy: "open" } } },
      replacePaths: [],
    });
  });

  it("coerces form strings by schema, as a full save would", () => {
    const built = buildChannelConfigPatch({
      base: {},
      channelId: "telegram",
      edits: [{ path: path("timeoutSeconds"), value: "30" }],
      schema,
    });
    expect(built?.patch).toEqual({ channels: { telegram: { timeoutSeconds: 30 } } });
  });

  it("deletes a cleared field and confirms replaced arrays", () => {
    const built = buildChannelConfigPatch({
      base: { botToken: "__OPENCLAW_REDACTED__", allowFrom: ["a", "b"], proxy: { url: "x" } },
      channelId: "telegram",
      edits: [
        { path: path("botToken"), value: undefined },
        { path: path("allowFrom"), value: ["a"] },
      ],
      schema,
    });
    expect(built).toEqual({
      patch: { channels: { telegram: { botToken: null, allowFrom: ["a"] } } },
      replacePaths: ["channels.telegram.allowFrom"],
    });
  });

  it("has nothing to send when the edits land back on the saved value", () => {
    expect(
      buildChannelConfigPatch({
        base: { dmPolicy: "pairing" },
        channelId: "telegram",
        edits: [
          { path: path("dmPolicy"), value: "open" },
          { path: path("dmPolicy"), value: "pairing" },
        ],
        schema,
      }),
    ).toBeNull();
  });
});

describe("emptiesStoredSecret", () => {
  const base = { botToken: "__OPENCLAW_REDACTED__", proxy: "http://x" };
  const tokenPath = ["channels", "telegram", "botToken"];

  it("keeps a stored secret when its field is emptied", () => {
    expect(emptiesStoredSecret(base, "telegram", tokenPath, "")).toBe(true);
    expect(emptiesStoredSecret(base, "telegram", tokenPath, undefined)).toBe(true);
  });

  it("leaves typed values and other fields as edits", () => {
    expect(emptiesStoredSecret(base, "telegram", tokenPath, "new")).toBe(false);
    expect(emptiesStoredSecret(base, "telegram", ["channels", "telegram", "proxy"], "")).toBe(
      false,
    );
    expect(emptiesStoredSecret(null, "telegram", tokenPath, "")).toBe(false);
  });
});

describe("writesOverReference", () => {
  const REDACTED = "__OPENCLAW_REDACTED__";
  const token = ["channels", "telegram", "botToken"];
  const secretRefId = ["channels", "telegram", "webhookSecret", "id"];
  const config = {
    channels: {
      telegram: {
        botToken: REDACTED,
        proxy: "http://x",
        webhookSecret: { source: "env", provider: "default", id: REDACTED },
      },
    },
  };
  const snapshot = (parsedToken: unknown, raw: string | null = "{}") => ({
    valid: true,
    raw,
    config,
    sourceConfig: config,
    parsed: {
      channels: { telegram: { ...config.channels.telegram, botToken: parsedToken } },
    },
  });

  it("lets an edit replace plain text in the file", () => {
    expect(writesOverReference(snapshot(REDACTED), token)).toBe(false);
    expect(writesOverReference(snapshot(REDACTED), ["channels", "telegram", "proxy"])).toBe(false);
  });

  it("never lets an edit replace a reference", () => {
    expect(writesOverReference(snapshot("${TELEGRAM_TOKEN}"), token)).toBe(true);
    // A template is redacted like plaintext; the Gateway then withholds the file's text.
    expect(writesOverReference(snapshot(REDACTED, null), token)).toBe(true);
    expect(writesOverReference(snapshot({ $include: "./token.json5" }), token)).toBe(true);
    expect(writesOverReference(snapshot(REDACTED), secretRefId)).toBe(true);
    expect(writesOverReference(null, token)).toBe(false);
  });
});
