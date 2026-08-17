import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createCxmMcpRuntime } from "../src/app.js";
import type { AppSettings } from "../src/settings.js";
import type { TokenProvider } from "../src/token-provider.js";
import { loadToolConfig } from "../src/tool-config.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Test server did not receive a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("one MCP endpoint lists all 536 tools and forwards GET and POST calls", async (t) => {
  const config = loadToolConfig();
  const writeConfig = loadToolConfig("config/write-tools.json");
  const requests: Array<{
    url: string;
    method: string;
    authorization: string | null;
    contentType: string | null;
    body: string;
  }> = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      body: await request.text(),
    });
    return new Response(
      JSON.stringify({ totalCount: 1, items: [{ id: "project-1", code: "P001" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const settings: AppSettings = {
    host: "127.0.0.1",
    port: 8000,
    mcpInstanceName: "hicas-cxm-test",
    mcpApiKey: "test-mcp-key",
    cxmBaseUrl: new URL("https://cxm.example.test"),
    cxmOAuthClientId: "CxmApi_App",
    cxmOAuthScope: "offline_access CxmApi",
    cxmInteractiveLogin: false,
    requestTimeoutMs: 5_000,
    maxRequestBytes: 1024 * 1024,
    maxUploadBytes: 10 * 1024 * 1024,
    maxResponseBytes: 128 * 1024,
  };
  const tokenProvider: TokenProvider = {
    configured: true,
    async getToken() {
      return "test-cxm-token";
    },
  };
  const runtime = createCxmMcpRuntime(settings, config, writeConfig, tokenProvider, mockFetch);
  const httpServer = createServer(runtime.app);
  const port = await listen(httpServer);
  t.after(async () => {
    await runtime.handler.close();
    await close(httpServer);
  });

  const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(unauthorized.status, 401);

  const info = await fetch(`http://127.0.0.1:${port}/`);
  assert.deepEqual(await info.json(), {
    name: "hicas-cxm-test",
    upstream: "https://cxm.example.test",
    version: "1.0.0",
    transport: "MCP Streamable HTTP",
    endpoint: "/mcp",
    login: "/auth/login?MCP_KEY=<YOUR_KEY>",
    health: "/healthz",
    readTools: 187,
    writeTools: 349,
    totalTools: 536,
    authentication: ["MCP_KEY query parameter", "Authorization Bearer header"],
  });

  const browserOpen = await fetch(
    `http://127.0.0.1:${port}/mcp?MCP_KEY=test-mcp-key`,
    { headers: { accept: "text/html" }, redirect: "manual" },
  );
  assert.equal(browserOpen.status, 303);
  assert.equal(
    browserOpen.headers.get("location"),
    "/auth/login?MCP_KEY=test-mcp-key",
  );
  const loginPage = await fetch(
    `http://127.0.0.1:${port}/auth/login?MCP_KEY=test-mcp-key`,
  );
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const loginHtml = await loginPage.text();
  assert.match(loginHtml, /Đã đăng nhập CXM/);
  assert.match(loginHtml, /hicas-cxm-test/);
  assert.match(loginHtml, /cxm\.example\.test/);
  assert.doesNotMatch(loginHtml, /mcp-write/);

  const removedWriteEndpoint = await fetch(
    `http://127.0.0.1:${port}/mcp-write?MCP_KEY=test-mcp-key`,
  );
  assert.equal(removedWriteEndpoint.status, 404);

  const client = new Client({ name: "cxm-mcp-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp?MCP_KEY=test-mcp-key`),
  );
  await client.connect(transport);
  t.after(async () => client.close());
  assert.equal(client.getServerVersion()?.name, "hicas-cxm-test");

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 536);
  const toolsListBytes = Buffer.byteLength(JSON.stringify(listed));
  assert.ok(
    toolsListBytes < 2 * 1024 * 1024,
    `tools/list response is ${toolsListBytes} bytes and exceeds Agent_bot's 2 MiB proxy limit`,
  );
  const syncTool = listed.tools.find(
    (tool) => tool.name === "cxm_workflow_workflow_definition_sync",
  );
  assert.ok(syncTool);
  assert.deepEqual(syncTool.inputSchema.required, ["confirmRiskyCall"]);

  const result = await client.callTool({
    name: "cxm_project_list",
    arguments: { keyword: "P001", maxResultCount: 5 },
  });
  assert.equal(result.isError, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.authorization, "Bearer test-cxm-token");
  const forwardedUrl = new URL(requests[0]?.url ?? "");
  assert.equal(forwardedUrl.pathname, "/api/app/project");
  assert.equal(forwardedUrl.searchParams.get("Keyword"), "P001");
  assert.equal(forwardedUrl.searchParams.get("MaxResultCount"), "5");
  assert.equal(forwardedUrl.searchParams.get("SkipCount"), "0");
  assert.deepEqual(result.structuredContent, {
    data: { totalCount: 1, items: [{ id: "project-1", code: "P001" }] },
    meta: {
      endpoint: "/api/app/project",
      status: 200,
      contentType: "application/json",
    },
  });

  const destructiveTool = listed.tools.find((tool) => {
    const configured = writeConfig.tools.find((candidate) => candidate.name === tool.name);
    return configured?.safety === "destructive";
  });
  assert.ok(destructiveTool);
  assert.ok(destructiveTool.inputSchema.required?.includes("confirmWrite"));
  assert.ok(destructiveTool.inputSchema.required?.includes("confirmDestructive"));
  const createProject = writeConfig.tools.find((tool) => tool.path === "/api/app/project");
  assert.ok(createProject);
  const writeResult = await client.callTool({
    name: createProject.name,
    arguments: { body: { name: "MCP test project" }, confirmWrite: true },
  });
  assert.equal(writeResult.isError, undefined);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.method, "POST");
  assert.match(requests[1]?.contentType ?? "", /^application\/json/);
  assert.deepEqual(JSON.parse(requests[1]?.body ?? "{}"), { name: "MCP test project" });
});
