import assert from "node:assert/strict";
import test from "node:test";

import { buildRequestUrl, CxmApiClient } from "../src/cxm-client.js";
import { loadSettings } from "../src/settings.js";
import type { TokenProvider } from "../src/token-provider.js";
import { loadToolConfig } from "../src/tool-config.js";

test("buildRequestUrl maps safe tool inputs to CXM path and query names", () => {
  const config = loadToolConfig();
  const listTool = config.tools.find((tool) => tool.name === "cxm_purchase_order_list");
  assert.ok(listTool);

  const url = buildRequestUrl(new URL("https://cxm.example.test"), listTool, {
    projectId: "project-1",
    approved: false,
    keyword: "steel & cable",
    skipCount: 25,
    maxResultCount: 25,
  });

  assert.equal(url.pathname, "/api/app/purchase-order");
  assert.equal(url.searchParams.get("ProjectId"), "project-1");
  assert.equal(url.searchParams.get("Approved"), "false");
  assert.equal(url.searchParams.get("Keyword"), "steel & cable");
  assert.equal(url.searchParams.get("SkipCount"), "25");
  assert.equal(url.searchParams.get("MaxResultCount"), "25");
});

test("buildRequestUrl encodes path identifiers and flattens object filters", () => {
  const config = loadToolConfig();
  const getTool = config.tools.find((tool) => tool.name === "cxm_project_get");
  const listTool = config.tools.find((tool) => tool.name === "cxm_project_list");
  assert.ok(getTool);
  assert.ok(listTool);

  const detailUrl = buildRequestUrl(new URL("https://cxm.example.test"), getTool, {
    id: "id/with spaces",
  });
  assert.equal(detailUrl.pathname, "/api/app/project/id%2Fwith%20spaces");

  const filterParameter = listTool.parameters.find((parameter) => parameter.wireName === "Filters");
  assert.ok(filterParameter);
  const filteredUrl = buildRequestUrl(new URL("https://cxm.example.test"), listTool, {
    [filterParameter.name]: { statusCode: "ACTIVE", nested: { value: 3 } },
  });
  assert.equal(filteredUrl.searchParams.get("Filters.statusCode"), "ACTIVE");
  assert.equal(filteredUrl.searchParams.get("Filters.nested.value"), "3");
});

test("BIM tools are forwarded to the isolated BIM UAT upstream", async () => {
  const tool = loadToolConfig("config/bim/tools.json").tools.find(
    (candidate) => candidate.name === "bim_boq_item_boq_item_list",
  );
  assert.ok(tool);
  let target = "";
  const mockFetch = (async (input: string | URL | Request) => {
    target = String(input);
    return Response.json({ items: [] });
  }) as typeof fetch;
  const tokenProvider: TokenProvider = { configured: true, async getToken() { return "test-token"; } };
  const client = new CxmApiClient(
    loadSettings({ HOST: "127.0.0.1", BIM_BASE_URL: "https://bim.example.test" }),
    tokenProvider,
    mockFetch,
  );
  await client.call(tool, {});
  assert.equal(new URL(target).origin, "https://bim.example.test");
  assert.equal(new URL(target).pathname, "/api/BoqItem/list");
});

test("POST multipart tools forward bounded base64 files as form data", async () => {
  const config = loadToolConfig("config/write-tools.json");
  const uploadTool = config.tools.find((tool) => tool.path === "/api/files/upload");
  assert.ok(uploadTool);
  let observedFileName = "";
  let observedFileText = "";
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.method, "POST");
    assert.match(request.headers.get("content-type") ?? "", /^multipart\/form-data; boundary=/);
    const form = await request.formData();
    const file = form.get("file");
    assert.ok(file instanceof File);
    observedFileName = file.name;
    observedFileText = await file.text();
    return Response.json({ uploaded: true });
  }) as typeof fetch;
  const tokenProvider: TokenProvider = {
    configured: true,
    async getToken() {
      return "test-token";
    },
  };
  const client = new CxmApiClient(
    loadSettings({ HOST: "127.0.0.1", CXM_MAX_UPLOAD_BYTES: "16384" }),
    tokenProvider,
    mockFetch,
  );
  await client.call(uploadTool, {
    files: [
      {
        fieldName: "file",
        fileName: "sample.txt",
        mediaType: "text/plain",
        dataBase64: Buffer.from("hello").toString("base64"),
      },
    ],
  });
  assert.equal(observedFileName, "sample.txt");
  assert.equal(observedFileText, "hello");
});

test("TingOp DELETE tools forward the method and path with bearer auth", async () => {
  const tool = loadToolConfig("config/tingop/write-tools.json").tools.find(
    (candidate) => candidate.method === "DELETE" && candidate.path === "/Tag/{id}",
  );
  assert.ok(tool);
  let observedRequest: Request | undefined;
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    observedRequest = new Request(input, init);
    return Response.json({ deleted: true });
  }) as typeof fetch;
  const client = new CxmApiClient(
    loadSettings({
      HOST: "127.0.0.1",
      CXM_BASE_URL: "https://tingop.example.test",
    }),
    { configured: true, async getToken() { return "tingop-token"; } },
    mockFetch,
  );

  await client.call(tool, { id: 7 });
  assert.equal(observedRequest?.method, "DELETE");
  assert.equal(observedRequest?.headers.get("authorization"), "Bearer tingop-token");
  assert.equal(new URL(observedRequest?.url ?? "").pathname, "/Tag/7");
});

test("TingOp Check-in tools reuse the TingOp bearer token on the separate Check-in API", async () => {
  const tool = loadToolConfig("config/tingop-checkin/tools.json").tools.find(
    (candidate) => candidate.path === "/api/CheckIn/v2/team/{team_id}",
  );
  assert.ok(tool);
  const teamParameter = tool.parameters.find((parameter) => parameter.source === "path");
  assert.ok(teamParameter);
  let observedRequest: Request | undefined;
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    observedRequest = new Request(input, init);
    return Response.json({ items: [] });
  }) as typeof fetch;
  const client = new CxmApiClient(
    loadSettings({
      HOST: "127.0.0.1",
      CXM_BASE_URL: "https://tingop.example.test",
      TINGOP_CHECKIN_BASE_URL: "https://checkin.example.test",
    }),
    { configured: true, async getToken() { return "tingop-token"; } },
    mockFetch,
  );

  await client.call(tool, { [teamParameter.name]: "team-1" });
  assert.equal(observedRequest?.method, "GET");
  assert.equal(observedRequest?.headers.get("authorization"), "Bearer tingop-token");
  assert.equal(new URL(observedRequest?.url ?? "").origin, "https://checkin.example.test");
  assert.equal(new URL(observedRequest?.url ?? "").pathname, "/api/CheckIn/v2/team/team-1");
});
