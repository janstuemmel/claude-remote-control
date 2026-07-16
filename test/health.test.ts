import { describe, expect, it } from "vitest";
import { compareVersions, isRemoteControlAuthReady, parseClaudeAuthStatus } from "../src/health.js";

describe("compareVersions", () => {
  it("compares semantic version components numerically", () => {
    expect(compareVersions("2.1.51", "2.1.51")).toBe(0);
    expect(compareVersions("2.2.0", "2.1.51")).toBe(1);
    expect(compareVersions("2.1.9", "2.1.51")).toBe(-1);
  });
});

describe("Claude authentication status", () => {
  it("extracts the structured auth information", () => {
    const auth = parseClaudeAuthStatus(JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      email: "developer@example.com",
      orgId: "org-123",
      orgName: "Example",
      subscriptionType: "team",
    }));

    expect(auth).toEqual({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      email: "developer@example.com",
      orgId: "org-123",
      orgName: "Example",
      subscriptionType: "team",
    });
    expect(isRemoteControlAuthReady(auth)).toBe(true);
  });

  it("rejects logged-out and non-Claude.ai authentication", () => {
    expect(isRemoteControlAuthReady({ loggedIn: false })).toBe(false);
    expect(isRemoteControlAuthReady({ loggedIn: true, authMethod: "apiKey" })).toBe(false);
  });
});
