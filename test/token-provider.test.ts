import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSettings } from "../src/settings.js";
import { createTokenProvider } from "../src/token-provider.js";

test("token provider exchanges a refresh token and caches the access token", async () => {
  const settings = loadSettings({
    HOST: "127.0.0.1",
    CXM_BASE_URL: "https://cxm.example.test",
    CXM_REFRESH_TOKEN: "refresh-one",
  });
  let calls = 0;
  const provider = createTokenProvider(settings, async (input, init) => {
    calls += 1;
    assert.equal(String(input), "https://cxm.example.test/connect/token");
    assert.equal(init?.method, "POST");
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "refresh-one");
    assert.equal(body.get("client_id"), "CxmApi_App");
    return Response.json({ access_token: "access-two", refresh_token: "refresh-two" });
  });

  assert.equal(provider.configured, true);
  assert.equal(await provider.getToken(), "access-two");
  assert.equal(await provider.getToken(), "access-two");
  assert.equal(calls, 1);
});

test("invalidating an access token triggers refresh", async () => {
  const settings = loadSettings({
    HOST: "127.0.0.1",
    CXM_ACCESS_TOKEN: "stale-access",
    CXM_REFRESH_TOKEN: "refresh-one",
  });
  const provider = createTokenProvider(settings, async () =>
    Response.json({ access_token: "fresh-access" }),
  );

  assert.equal(await provider.getToken(), "stale-access");
  provider.invalidateToken?.("stale-access");
  assert.equal(await provider.getToken(), "fresh-access");
});

test("interactive login exchanges credentials without retaining the password", async () => {
  const settings = loadSettings({
    HOST: "127.0.0.1",
    CXM_BASE_URL: "https://cxm.example.test",
  });
  let submittedBody: URLSearchParams | undefined;
  const provider = createTokenProvider(settings, async (_input, init) => {
    submittedBody = init?.body as URLSearchParams;
    return Response.json({ access_token: "login-access", refresh_token: "login-refresh" });
  });

  await provider.login?.({ username: "tester", password: "secret-value", remember: true });
  assert.equal(submittedBody?.get("grant_type"), "password");
  assert.equal(submittedBody?.get("username"), "tester");
  assert.equal(submittedBody?.get("password"), "secret-value");
  assert.equal(submittedBody?.get("scope"), "offline_access CxmApi");
  assert.deepEqual(provider.getStatus?.(), { configured: true, authenticated: true });
  assert.equal(await provider.getToken(), "login-access");

  provider.logout?.();
  assert.deepEqual(provider.getStatus?.(), { configured: false, authenticated: false });
  assert.equal(await provider.getToken(), undefined);
});

test("interactive login persists only the refresh token and restores it after restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cxm-mcp-token-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const refreshTokenFile = join(directory, "nested", "refresh-token");
  const settings = loadSettings({
    HOST: "127.0.0.1",
    CXM_BASE_URL: "https://cxm.example.test",
    CXM_REFRESH_TOKEN_FILE: refreshTokenFile,
  });

  const loginProvider = createTokenProvider(settings, async (_input, init) => {
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("grant_type"), "password");
    return Response.json({ access_token: "login-access", refresh_token: "persisted-refresh" });
  });
  await loginProvider.login?.({ username: "tester", password: "secret-value", remember: true });

  assert.equal(await readFile(refreshTokenFile, "utf8"), "persisted-refresh\n");
  assert.doesNotMatch(await readFile(refreshTokenFile, "utf8"), /secret-value|tester/);

  const restoredProvider = createTokenProvider(settings, async (_input, init) => {
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "persisted-refresh");
    return Response.json({ access_token: "restored-access", refresh_token: "rotated-refresh" });
  });

  assert.equal(await restoredProvider.getToken(), "restored-access");
  assert.equal(await readFile(refreshTokenFile, "utf8"), "rotated-refresh\n");
});

test("a missing refresh-token file behaves like a signed-out provider", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cxm-mcp-token-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = loadSettings({
    HOST: "127.0.0.1",
    CXM_BASE_URL: "https://cxm.example.test",
    CXM_REFRESH_TOKEN_FILE: join(directory, "not-created-yet"),
  });
  const provider = createTokenProvider(settings, async () => {
    throw new Error("token endpoint should not be called");
  });

  assert.equal(await provider.getToken(), undefined);
});

test("concurrent callers share one refresh request", async () => {
  const settings = loadSettings({
    HOST: "127.0.0.1",
    CXM_BASE_URL: "https://cxm.example.test",
    CXM_REFRESH_TOKEN: "shared-refresh",
  });
  let calls = 0;
  const provider = createTokenProvider(settings, async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({ access_token: "shared-access" });
  });

  const tokens = await Promise.all(Array.from({ length: 10 }, () => provider.getToken()));
  assert.deepEqual(tokens, Array.from({ length: 10 }, () => "shared-access"));
  assert.equal(calls, 1);
});
