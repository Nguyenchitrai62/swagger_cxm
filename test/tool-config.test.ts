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

// The administration surface stays closed except for these five endpoints, which
// exist so an agent can read and rewrite role permissions during permission testing.
const admittedAdministrationEndpoints = new Set([
  "GET /api/permission-management/permissions",
  "PUT /api/permission-management/permissions",
  "GET /api/identity/roles/all",
  "GET /api/identity/users/by-username/{userName}",
  "GET /api/identity/users/{id}/roles",
]);

const isAdmitted = (tool: { method: string; path: string }): boolean =>
  admittedAdministrationEndpoints.has(`${tool.method} ${tool.path}`);

test("frozen allowlist contains all 187 GET tools", () => {
  const config = loadToolConfig();
  assert.equal(config.tools.length, 187);
  assert.equal(new Set(config.tools.map((tool) => tool.name)).size, 187);
  assert.ok(config.tools.every((tool) => tool.method === "GET"));
  assert.equal(config.selectedTags.length, 50);
  assert.ok(
    config.tools.every((tool) => isAdmitted(tool) || !excludedAdministrationTags.has(tool.tag)),
  );
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

test("write allowlist contains 349 confirmed write tools", () => {
  const config = loadToolConfig("config/write-tools.json");
  assert.equal(config.tools.length, 349);
  assert.equal(config.tools.filter((tool) => tool.method === "POST").length, 348);
  assert.equal(config.tools.filter((tool) => tool.method === "PUT").length, 1);
  assert.ok(config.tools.every((tool) => ["write", "destructive"].includes(tool.safety)));
  assert.ok(
    config.tools.every((tool) => isAdmitted(tool) || !excludedAdministrationTags.has(tool.tag)),
  );
  assert.ok(config.tools.every((tool) => !tool.path.includes("/admin/")));
  assert.equal(config.tools.filter((tool) => tool.safety === "destructive").length, 74);
  assert.equal(config.tools.filter((tool) => tool.requestBody?.mode === "json").length, 261);
  assert.equal(config.tools.filter((tool) => tool.requestBody?.mode === "multipart").length, 26);
  assert.equal(config.tools.filter((tool) => !tool.requestBody).length, 62);
});

test("only the five listed administration endpoints are reachable", () => {
  const tools = [
    ...loadToolConfig().tools,
    ...loadToolConfig("config/write-tools.json").tools,
  ];
  const administration = tools
    .filter((tool) => excludedAdministrationTags.has(tool.tag))
    .map((tool) => `${tool.method} ${tool.path}`)
    .sort();

  assert.deepEqual(administration, [...admittedAdministrationEndpoints].sort());

  // Reading a user's roles is admitted; rewriting them must never be.
  assert.ok(
    !tools.some((tool) => tool.method === "PUT" && tool.path === "/api/identity/users/{id}/roles"),
  );
  // The one PUT in the allowlist overwrites an entire role's permission set.
  const puts = tools.filter((tool) => tool.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0]?.path, "/api/permission-management/permissions");
  assert.equal(puts[0]?.safety, "destructive");
  assert.equal(
    puts[0]?.requestBody?.fields.find((field) => field.wireName === "permissions")?.itemType,
    "object",
  );
});

test("SIT uses an independently frozen GET and POST allowlist", () => {
  const readConfig = loadToolConfig("config/sit/tools.json");
  const writeConfig = loadToolConfig("config/sit/write-tools.json");

  assert.equal(readConfig.sourceOpenApi, "https://api.hawee.hicas.vn/swagger/v1/swagger.json");
  assert.equal(writeConfig.sourceOpenApi, "https://api.hawee.hicas.vn/swagger/v1/swagger.json");
  assert.ok(readConfig.tools.every((tool) => tool.method === "GET"));
  assert.ok(writeConfig.tools.every((tool) => tool.method === "POST"));
  assert.ok(readConfig.tools.every((tool) => !excludedAdministrationTags.has(tool.tag)));
  assert.ok(writeConfig.tools.every((tool) => !excludedAdministrationTags.has(tool.tag)));
});
