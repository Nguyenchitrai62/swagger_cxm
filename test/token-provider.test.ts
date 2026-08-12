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

test("UAT and SIT providers persist and refresh tokens without cross-environment overwrite", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cxm-mcp-dual-token-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const uatTokenFile = join(directory, "uat", "refresh-token");
  const sitTokenFile = join(directory, "sit", "refresh-token");
  const uatSettings = loadSettings({
    HOST: "127.0.0.1",
    MCP_INSTANCE_NAME: "hicas-cxm-uat",
    CXM_BASE_URL: "https://uat.example.test",
    CXM_REFRESH_TOKEN_FILE: uatTokenFile,
  });
  const sitSettings = loadSettings({
    HOST: "127.0.0.1",
    MCP_INSTANCE_NAME: "hicas-cxm-sit",
    CXM_BASE_URL: "https://sit.example.test",
    CXM_REFRESH_TOKEN_FILE: sitTokenFile,
  });

  const requests: Array<{ upstream: string; grantType: string | null; refreshToken: string | null }> = [];
  const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const upstream = new URL(String(input)).hostname;
    const body = init?.body as URLSearchParams;
    requests.push({
      upstream,
      grantType: body.get("grant_type"),
      refreshToken: body.get("refresh_token"),
    });
    const environment = upstream.startsWith("uat") ? "uat" : "sit";
    const grantType = body.get("grant_type");
    return Response.json({
      access_token: `${environment}-${grantType}-access`,
      refresh_token: `${environment}-${grantType}-refresh`,
    });
  };

  const uatProvider = createTokenProvider(uatSettings, mockFetch);
  const sitProvider = createTokenProvider(sitSettings, mockFetch);
  await uatProvider.login?.({ username: "uat-user", password: "secret", remember: true });
  await sitProvider.login?.({ username: "sit-user", password: "secret", remember: true });

  assert.equal(await readFile(uatTokenFile, "utf8"), "uat-password-refresh\n");
  assert.equal(await readFile(sitTokenFile, "utf8"), "sit-password-refresh\n");

  const restoredUat = createTokenProvider(uatSettings, mockFetch);
  const restoredSit = createTokenProvider(sitSettings, mockFetch);
  assert.equal(await restoredUat.getToken(), "uat-refresh_token-access");
  assert.equal(await restoredSit.getToken(), "sit-refresh_token-access");
  assert.deepEqual(requests.slice(-2), [
    {
      upstream: "uat.example.test",
      grantType: "refresh_token",
      refreshToken: "uat-password-refresh",
    },
    {
      upstream: "sit.example.test",
      grantType: "refresh_token",
      refreshToken: "sit-password-refresh",
    },
  ]);
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
