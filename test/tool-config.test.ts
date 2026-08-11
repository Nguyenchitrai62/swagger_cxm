import assert from "node:assert/strict";
import test from "node:test";

import { loadToolConfig } from "../src/tool-config.js";

const excludedAdministrationTags = new Set([
  "AbpApiDefinition",
  "AbpApplicationConfiguration",
  "AbpApplicationLocalization",
  "Permissions",
  "Features",
  "Login",
  "Profile",
  "Tenant",
  "AbpTenant",
  "User",
  "CxmUser",
  "UserLookup",
  "Role",
  "OrganizationUnit",
  "TimeZoneSettings",
  "EmailSettings",
  "EmailTemplate",
  "ExternalApiLog",
  "Banner",
  "Account",
  "DynamicClaims",
]);

test("frozen allowlist contains all 183 non-administration GET tools", () => {
  const config = loadToolConfig();
  assert.equal(config.tools.length, 183);
  assert.equal(new Set(config.tools.map((tool) => tool.name)).size, 183);
  assert.ok(config.tools.every((tool) => tool.method === "GET"));
  assert.equal(config.selectedTags.length, 47);
  assert.ok(config.tools.every((tool) => !excludedAdministrationTags.has(tool.tag)));
  assert.ok(config.tools.every((tool) => !tool.path.includes("/admin/")));
  assert.equal(config.tools.filter((tool) => tool.tag === "PaymentRequest").length, 23);
  assert.equal(config.tools.filter((tool) => tool.tag === "Project").length, 4);
  assert.equal(config.tools.filter((tool) => tool.tag === "Workflow").length, 8);
});

test("list endpoints are capped and the synchronization endpoint requires review", () => {
  const config = loadToolConfig();
  const paginatedParameters = config.tools
    .flatMap((tool) => tool.parameters)
    .filter((parameter) => parameter.wireName.toLowerCase() === "maxresultcount");

  assert.ok(paginatedParameters.length > 0);
  assert.ok(
    paginatedParameters.every(
      (parameter) => parameter.default === 25 && parameter.maximum === 100,
    ),
  );

  const reviewTools = config.tools.filter((tool) => tool.safety === "review");
  assert.deepEqual(
    reviewTools.map((tool) => tool.path),
    ["/api/app/workflow/workflow-definition-sync"],
  );
});

test("write allowlist contains 347 confirmed non-administration POST tools", () => {
  const config = loadToolConfig("config/write-tools.json");
  assert.equal(config.tools.length, 347);
  assert.ok(config.tools.every((tool) => tool.method === "POST"));
  assert.ok(config.tools.every((tool) => ["write", "destructive"].includes(tool.safety)));
  assert.ok(config.tools.every((tool) => !excludedAdministrationTags.has(tool.tag)));
  assert.ok(config.tools.every((tool) => !tool.path.includes("/admin/")));
  assert.equal(config.tools.filter((tool) => tool.safety === "destructive").length, 73);
  assert.equal(config.tools.filter((tool) => tool.requestBody?.mode === "json").length, 260);
  assert.equal(config.tools.filter((tool) => tool.requestBody?.mode === "multipart").length, 25);
  assert.equal(config.tools.filter((tool) => !tool.requestBody).length, 62);
});
