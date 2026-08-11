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
