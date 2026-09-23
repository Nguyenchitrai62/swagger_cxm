import assert from "node:assert/strict";
import test from "node:test";

import { loadSettings } from "../src/settings.js";

test("settings default to port 9000 and accept MCP_KEY", () => {
  const settings = loadSettings({
    HOST: "127.0.0.1",
    MCP_KEY: "fixed-key",
  });
  assert.equal(settings.port, 9000);
  assert.equal(settings.mcpInstanceName, "hicas-cxm");
  assert.equal(settings.mcpApiKey, "fixed-key");
  assert.equal(settings.cxmOAuthClientId, "CxmApi_App");
  assert.equal(settings.cxmOAuthScope, "offline_access CxmApi");
  assert.equal(settings.cxmOAuthClientSecret, undefined);
  assert.equal(settings.tingopCheckInBaseUrl.origin, "https://sit.checkin.tingconnect.com");
  assert.equal(settings.cxmInteractiveLogin, false);
});

test("settings accept an OAuth client secret for upstreams such as TingOp", () => {
  const settings = loadSettings({
    HOST: "127.0.0.1",
    CXM_BASE_URL: "https://tingop.example.test",
    CXM_OAUTH_CLIENT_ID: "TingOp",
    CXM_OAUTH_SCOPE: "offline_access API",
    CXM_OAUTH_CLIENT_SECRET: "public-client-secret",
    TINGOP_CHECKIN_BASE_URL: "https://checkin.example.test",
  });
  assert.equal(settings.cxmOAuthClientId, "TingOp");
  assert.equal(settings.cxmOAuthScope, "offline_access API");
  assert.equal(settings.cxmOAuthClientSecret, "public-client-secret");
  assert.equal(settings.tingopCheckInBaseUrl.origin, "https://checkin.example.test");
});

test("settings accept a distinct MCP instance name", () => {
  const settings = loadSettings({
    HOST: "127.0.0.1",
    MCP_INSTANCE_NAME: "hicas-cxm-sit",
  });
  assert.equal(settings.mcpInstanceName, "hicas-cxm-sit");
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
