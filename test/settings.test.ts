import assert from "node:assert/strict";
import test from "node:test";

import { loadSettings } from "../src/settings.js";

test("settings default to port 9000 and accept MCP_KEY", () => {
  const settings = loadSettings({
    HOST: "127.0.0.1",
    MCP_KEY: "fixed-key",
  });
  assert.equal(settings.port, 9000);
  assert.equal(settings.mcpApiKey, "fixed-key");
  assert.equal(settings.cxmOAuthClientId, "CxmApi_App");
  assert.equal(settings.cxmOAuthScope, "offline_access CxmApi");
  assert.equal(settings.cxmInteractiveLogin, false);
});

test("interactive login mode can require a fresh browser login after restart", () => {
  const settings = loadSettings({
    HOST: "127.0.0.1",
    CXM_ACCESS_TOKEN: "inherited-token",
    CXM_INTERACTIVE_LOGIN: "true",
  });
  assert.equal(settings.cxmInteractiveLogin, true);
});

test("settings reject conflicting new and legacy MCP key variables", () => {
  assert.throws(
    () =>
      loadSettings({
        HOST: "127.0.0.1",
        MCP_KEY: "new-key",
        MCP_API_KEY: "old-key",
      }),
    /do not match/,
  );
});
