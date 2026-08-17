import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;

interface SelectedGroups {
  sourceOpenApi: string;
  expectedSourceGetCount: number;
  expectedGetToolCount: number;
  expectedSourcePostCount: number;
  expectedPostToolCount: number;
  expectedSourcePutCount?: number;
  expectedPutToolCount?: number;
  excludedTags: string[];
  excludedPaths: string[];
  reviewPaths: string[];
  /**
   * Administration endpoints re-admitted one at a time, written as "METHOD /path".
   * Tag-level exclusion stays in force for everything else, so opening
   * "GET /api/identity/users/{id}/roles" never also opens the PUT that rewrites them.
   */
  includedEndpoints?: string[];
  /** Endpoints forced to `destructive` regardless of their path shape. */
  destructiveEndpoints?: string[];
}

type HttpMethod = "GET" | "POST" | "PUT";

interface GeneratedParameter {
  name: string;
  wireName: string;
  source: "path" | "query";
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  itemType?: "string" | "integer" | "number" | "boolean";
  required: boolean;
  description: string;
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean | Array<string | number | boolean>;
  enum?: Array<string | number | boolean>;
}

interface GeneratedBodyField {
  name: string;
  wireName: string;
  type: GeneratedParameter["type"];
  itemType?: GeneratedParameter["itemType"] | "object";
  required: boolean;
  description: string;
  format?: string;
}

interface GeneratedRequestBody {
  mode: "json" | "multipart";
  required: boolean;
  rootType: GeneratedParameter["type"];
  description: string;
  fields: GeneratedBodyField[];
}

const groupPurpose: Record<string, string> = {
  Project: "project master data and project status",
  WorkPackage: "project work-package data",
  Party: "customer, supplier, partner, contact, address, bank-account, and role data",
  SupplyContract: "supply-contract header, item, document, and process data",
  SupplyContractAppendix: "supply-contract appendix and contract-item data",
  PurchaseOrder: "purchase-order, allocation, cost-comparison, and process data",
  Warehouse: "warehouse master data",
  WarehouseTransaction: "inventory movement, allocation, transfer, and partner data",
  MaterialAcceptanceCertificate: "material acceptance certificate and item data",
  WarehouseWeightedAveragePrice: "warehouse weighted-average price and inventory valuation data",
  FiscalPeriod: "fiscal-period master data",
  Workflow: "workflow definition, instance, approval-step, and approver data",
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[{}]/g, " ")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

function snake(value: string): string {
  return words(value).join("_");
}

function lowerCamel(value: string): string {
  const parts = words(value);
  return parts
    .map((part, index) =>
      index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join("");
}

function title(value: string): string {
  return words(value)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function resolveSchema(schema: unknown, openApi: JsonObject): JsonObject {
  if (!isObject(schema)) return {};
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/components/schemas/")) return schema;

  const schemaName = ref.slice("#/components/schemas/".length);
  const components = isObject(openApi.components) ? openApi.components : {};
  const schemas = isObject(components.schemas) ? components.schemas : {};
  return isObject(schemas[schemaName]) ? schemas[schemaName] : schema;
}

function expandObjectSchema(schema: unknown, openApi: JsonObject): JsonObject {
  const resolved = resolveSchema(schema, openApi);
  if (!Array.isArray(resolved.allOf)) return resolved;
  const properties: JsonObject = {};
  const required = new Set<string>();
  for (const item of resolved.allOf) {
    const expanded = expandObjectSchema(item, openApi);
    if (isObject(expanded.properties)) Object.assign(properties, expanded.properties);
    if (Array.isArray(expanded.required)) {
      for (const name of expanded.required) if (typeof name === "string") required.add(name);
    }
  }
  if (isObject(resolved.properties)) Object.assign(properties, resolved.properties);
  if (Array.isArray(resolved.required)) {
    for (const name of resolved.required) if (typeof name === "string") required.add(name);
  }
  return { ...resolved, type: "object", properties, required: [...required] };
}

function mapType(schema: JsonObject): GeneratedParameter["type"] {
  const type = schema.type;
  if (
    type === "string" ||
    type === "integer" ||
    type === "number" ||
    type === "boolean" ||
    type === "array" ||
    type === "object"
  ) {
    return type;
  }
  return "string";
}

function primitiveArray(value: unknown): Array<string | number | boolean> | undefined {
  if (!Array.isArray(value)) return undefined;
  const primitives = value.filter(
    (item): item is string | number | boolean =>
      typeof item === "string" || typeof item === "number" || typeof item === "boolean",
  );
  return primitives.length === value.length && primitives.length > 0 ? primitives : undefined;
}

function uniqueInputName(wireName: string, used: Set<string>): string {
  const fallback = `parameter${used.size + 1}`;
  const base = lowerCamel(wireName) || fallback;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function generateParameter(
  raw: unknown,
  openApi: JsonObject,
  usedNames: Set<string>,
): GeneratedParameter | undefined {
  if (!isObject(raw) || typeof raw.name !== "string") return undefined;
  if (raw.in !== "path" && raw.in !== "query") return undefined;

  const schema = resolveSchema(raw.schema, openApi);
  const type = mapType(schema);
  const parameter: GeneratedParameter = {
    name: uniqueInputName(raw.name, usedNames),
    wireName: raw.name,
    source: raw.in,
    type,
    required: raw.in === "path" || raw.required === true,
    description:
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim()
        : `${raw.name} ${raw.in} parameter from the CXM OpenAPI schema.`,
  };

  if (type === "array") {
    const items = resolveSchema(schema.items, openApi);
    const itemType = mapType(items);
    parameter.itemType =
      itemType === "array" || itemType === "object" ? "string" : itemType;
  }
  if (typeof schema.minimum === "number") parameter.minimum = schema.minimum;
  if (typeof schema.maximum === "number") parameter.maximum = schema.maximum;
  if (
    typeof schema.default === "string" ||
    typeof schema.default === "number" ||
    typeof schema.default === "boolean"
  ) {
    parameter.default = schema.default;
  } else {
    const defaultArray = primitiveArray(schema.default);
    if (defaultArray) parameter.default = defaultArray;
  }
  const enumValues = primitiveArray(schema.enum);
  if (enumValues) parameter.enum = enumValues;

  const normalizedWireName = raw.name.toLowerCase();
  if (normalizedWireName === "maxresultcount" && type === "integer") {
    parameter.minimum = 1;
    parameter.maximum = Math.min(parameter.maximum ?? 100, 100);
    parameter.default = 25;
  }
  if (normalizedWireName === "skipcount" && type === "integer") {
    parameter.minimum = 0;
    parameter.default = 0;
  }

  return parameter;
}

function generateRequestBody(operation: JsonObject, openApi: JsonObject): GeneratedRequestBody | undefined {
  let requestBody = isObject(operation.requestBody) ? operation.requestBody : undefined;
  if (requestBody && typeof requestBody.$ref === "string" && requestBody.$ref.startsWith("#/components/requestBodies/")) {
    const name = requestBody.$ref.slice("#/components/requestBodies/".length);
    const components = isObject(openApi.components) ? openApi.components : {};
    const requestBodies = isObject(components.requestBodies) ? components.requestBodies : {};
    requestBody = isObject(requestBodies[name]) ? requestBodies[name] : requestBody;
  }
  if (!requestBody || !isObject(requestBody.content)) return undefined;

  const contentTypes = Object.keys(requestBody.content);
  const mode = contentTypes.includes("multipart/form-data") ? "multipart" : "json";
  const contentType = mode === "multipart"
    ? "multipart/form-data"
    : contentTypes.find((candidate) => candidate === "application/json")
      ?? contentTypes.find((candidate) => candidate.includes("json"));
  if (!contentType) return undefined;
  const media = requestBody.content[contentType];
  const rawSchema = isObject(media) ? media.schema : undefined;
  const schema = expandObjectSchema(rawSchema, openApi);
  const rootType = mapType(schema);
  const properties = isObject(schema.properties) ? schema.properties : {};
  const requiredNames = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const usedNames = new Set<string>();
  const fields: GeneratedBodyField[] = [];
  for (const [wireName, rawField] of Object.entries(properties)) {
    const field = expandObjectSchema(rawField, openApi);
    const type = mapType(field);
    const generated: GeneratedBodyField = {
      name: uniqueInputName(wireName, usedNames),
      wireName,
      type,
      required: requiredNames.has(wireName),
      description:
        typeof field.description === "string" && field.description.trim()
          ? field.description.trim()
          : `${wireName} request-body field from the CXM OpenAPI schema.`,
    };
    if (typeof field.format === "string") generated.format = field.format;
    if (type === "array") {
      const items = expandObjectSchema(field.items, openApi);
      const itemType = mapType(items);
      // Object elements stay objects: collapsing them to strings made every
      // array-of-object body field reject its own documented payload.
      generated.itemType = itemType === "array" ? "string" : itemType;
      if (typeof items.format === "string" && !generated.format) generated.format = items.format;
    }
    fields.push(generated);
  }

  const fieldSummary = fields.length
    ? ` Fields: ${fields.map((field) => `${field.wireName}${field.required ? " (required)" : ""}${field.format ? ` [${field.format}]` : ""}`).join(", ")}.`
    : " Supply the request body exactly as documented by CXM.";
  return {
    mode,
    required: requestBody.required === true,
    rootType,
    description: `${mode === "multipart" ? "Multipart form" : "JSON"} request body.${fieldSummary}`,
    fields,
  };
}

function pathRootForTag(tag: string): string {
  return `/api/app/${snake(tag).replaceAll("_", "-")}`;
}

function generateToolName(
  tag: string,
  path: string,
  method: HttpMethod,
  used: Set<string>,
): string {
  const prefix = method === "GET" ? `cxm_${snake(tag)}` : `cxm_${method.toLowerCase()}_${snake(tag)}`;
  const root = pathRootForTag(tag);
  let remainder = path.startsWith(root) ? path.slice(root.length) : path.replace(/^\/api\//, "");

  if (!remainder || remainder === "/") remainder = method === "POST" ? "/execute" : "/list";
  if (remainder === "/{id}") remainder = "/get";

  const suffixParts: string[] = [];
  for (const segment of remainder.split("/").filter(Boolean)) {
    const placeholder = segment.match(/^\{(.+)\}$/);
    if (!placeholder) {
      suffixParts.push(snake(segment));
      continue;
    }
    const byPlaceholder = `by_${snake(placeholder[1] ?? "id")}`;
    if (!suffixParts.join("_").endsWith(byPlaceholder)) suffixParts.push(byPlaceholder);
  }
  const suffix = suffixParts.filter(Boolean).join("_");

  const base = `${prefix}_${suffix || "get"}`.slice(0, 128);
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    const ending = `_${counter}`;
    candidate = `${base.slice(0, 128 - ending.length)}${ending}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function writeSafety(
  selected: SelectedGroups,
  path: string,
  method: HttpMethod,
): "write" | "destructive" {
  if ((selected.destructiveEndpoints ?? []).includes(`${method} ${path}`)) return "destructive";
  return /(?:^|\/)(?:delete|delete-many|remove|cancel|reject|revoke|reset|clear|terminate|deactivate|rollback|import|sync|update-many)(?:\/|$|-)/i.test(path)
    ? "destructive"
    : "write";
}

function shouldExclude(
  selected: SelectedGroups,
  tag: string,
  path: string,
  method: HttpMethod,
): boolean {
  // An explicit per-endpoint opt-in outranks the tag and /admin/ exclusions, but
  // only for the exact method listed.
  if ((selected.includedEndpoints ?? []).includes(`${method} ${path}`)) return false;
  // PUT is opt-in only. Tag-based inclusion would otherwise hand the agent every
  // update endpoint in the API the moment PUT generation was switched on.
  if (method === "PUT") return true;
  return (
    selected.excludedTags.includes(tag) ||
    selected.excludedPaths.includes(path) ||
    /\/admin(?:\/|$)/i.test(path)
  );
}

function createOutput(
  openApi: JsonObject,
  selected: SelectedGroups,
  method: HttpMethod,
): { output: JsonObject; sourceCount: number; excludedCount: number; toolCount: number; tools: JsonObject[]; tags: Set<string> } {
  const paths = isObject(openApi.paths) ? openApi.paths : {};
  const tools: JsonObject[] = [];
  const usedToolNames = new Set<string>();
  const includedTags = new Set<string>();
  let sourceCount = 0;
  let excludedCount = 0;

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue;
    const operation = pathItem[method.toLowerCase()];
    if (!isObject(operation)) continue;
    sourceCount += 1;
    const tags = Array.isArray(operation.tags) ? operation.tags : [];
    const tag = tags.find((candidate): candidate is string => typeof candidate === "string");
    if (!tag) throw new Error(`${method} ${path} has no OpenAPI tag; review its classification`);
    if (shouldExclude(selected, tag, path, method)) {
      excludedCount += 1;
      continue;
    }
    includedTags.add(tag);

    const usedParameterNames = new Set<string>();
    const rawParameters = [
      ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
      ...(Array.isArray(operation.parameters) ? operation.parameters : []),
    ];
    const parameters = rawParameters
      .map((parameter) => generateParameter(parameter, openApi, usedParameterNames))
      .filter((parameter): parameter is GeneratedParameter => parameter !== undefined);
    const safety = method === "GET"
      ? selected.reviewPaths.includes(path) ? "review" : "read-only"
      : writeSafety(selected, path, method);
    const generatedName = generateToolName(tag, path, method, usedToolNames);
    const operationDescription =
      typeof operation.description === "string" && operation.description.trim()
        ? operation.description.trim()
        : typeof operation.summary === "string" && operation.summary.trim()
          ? operation.summary.trim()
          : `${method === "GET" ? "Read" : "Execute"} ${groupPurpose[tag] ?? `${tag} data`} in CXM. Endpoint: ${method} ${path}.`;
    const warning = safety === "review"
      ? " Warning: despite using GET, this endpoint name suggests possible server-side synchronization and requires explicit confirmation."
      : safety === "destructive"
        ? ` Warning: this ${method} may perform a bulk, import, synchronization, cancellation, rejection, reset, overwrite, or deletion action and requires destructive confirmation.`
        : safety === "write"
          ? ` Warning: this ${method} may change CXM data and requires explicit write confirmation.`
          : "";
    const requestBody = method === "GET" ? undefined : generateRequestBody(operation, openApi);
    const namePrefix = method === "GET"
      ? `cxm_${snake(tag)}_`
      : `cxm_${method.toLowerCase()}_${snake(tag)}_`;

    tools.push({
      name: generatedName,
      title: `${title(tag)}: ${title(generatedName.replace(namePrefix, ""))}`,
      description: `${operationDescription}${warning}`,
      tag,
      method,
      path,
      safety,
      parameters,
      ...(requestBody ? { requestBody } : {}),
    });
  }

  return {
    sourceCount,
    excludedCount,
    toolCount: tools.length,
    tools,
    tags: includedTags,
    output: {
      generatedAt: new Date().toISOString(),
      sourceOpenApi: selected.sourceOpenApi,
      sourceTitle:
        isObject(openApi.info) && typeof openApi.info.title === "string"
          ? openApi.info.title
          : "CXM API",
      selectedTags: [...includedTags].sort((a, b) => a.localeCompare(b)),
      tools,
    },
  };
}

async function main(): Promise<void> {
  const profileArgumentIndex = process.argv.indexOf("--profile");
  const hasExplicitProfile = profileArgumentIndex >= 0;
  const profile = profileArgumentIndex >= 0 ? process.argv[profileArgumentIndex + 1] : "uat";
  if (!profile || !/^[a-z0-9_-]+$/i.test(profile)) {
    throw new Error("--profile must be followed by a safe profile name");
  }

  // Keep the existing UAT paths as defaults so current deployments and custom
  // CXM_TOOLS_CONFIG overrides remain backwards compatible. Other environments
  // get their own frozen allowlists under config/<profile>/.
  const profileDirectory = profile.toLowerCase() === "uat" ? "config" : `config/${profile}`;
  const selectedPath = resolve(
    (!hasExplicitProfile ? process.env.CXM_SELECTED_GROUPS_CONFIG : undefined) ??
      `${profileDirectory}/selected-groups.json`,
  );
  const readOutputPath = resolve(
    (!hasExplicitProfile ? process.env.CXM_TOOLS_CONFIG : undefined) ??
      `${profileDirectory}/tools.json`,
  );
  const writeOutputPath = resolve(
    (!hasExplicitProfile ? process.env.CXM_WRITE_TOOLS_CONFIG : undefined) ??
      `${profileDirectory}/write-tools.json`,
  );
  const selected = JSON.parse(await readFile(selectedPath, "utf8")) as SelectedGroups;

  const response = await fetch(selected.sourceOpenApi, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`OpenAPI request failed with HTTP ${response.status}`);
  }

  const openApi = (await response.json()) as JsonObject;
  const readResult = createOutput(openApi, selected, "GET");
  const postResult = createOutput(openApi, selected, "POST");
  const putResult = createOutput(openApi, selected, "PUT");

  // PUT tools ship in the same frozen write allowlist as POST: both mutate CXM and
  // both gate on confirmWrite.
  const writeResult = {
    sourceCount: postResult.sourceCount,
    excludedCount: postResult.excludedCount + putResult.excludedCount,
    toolCount: postResult.toolCount + putResult.toolCount,
    output: {
      ...postResult.output,
      selectedTags: [...new Set([...postResult.tags, ...putResult.tags])].sort((a, b) =>
        a.localeCompare(b),
      ),
      tools: [...postResult.tools, ...putResult.tools],
    },
  };

  if (putResult.sourceCount !== (selected.expectedSourcePutCount ?? 0)) {
    throw new Error(
      `Expected ${selected.expectedSourcePutCount ?? 0} source PUT endpoints but found ${putResult.sourceCount}. ` +
        "The upstream OpenAPI changed; review the administration exclusions.",
    );
  }
  if (putResult.toolCount !== (selected.expectedPutToolCount ?? 0)) {
    throw new Error(
      `Expected ${selected.expectedPutToolCount ?? 0} PUT tools but generated ${putResult.toolCount}. ` +
        "PUT endpoints are only admitted one at a time through includedEndpoints.",
    );
  }
  if (readResult.sourceCount !== selected.expectedSourceGetCount) {
    throw new Error(
      `Expected ${selected.expectedSourceGetCount} source GET endpoints but found ${readResult.sourceCount}. ` +
        "The upstream OpenAPI changed; review the administration exclusions.",
    );
  }
  if (writeResult.sourceCount !== selected.expectedSourcePostCount) {
    throw new Error(
      `Expected ${selected.expectedSourcePostCount} source POST endpoints but found ${writeResult.sourceCount}. ` +
        "The upstream OpenAPI changed; review the administration exclusions.",
    );
  }
  if (readResult.toolCount !== selected.expectedGetToolCount) {
    throw new Error(
      `Expected ${selected.expectedGetToolCount} GET tools but generated ${readResult.toolCount}. ` +
        "The upstream OpenAPI may have changed; review before updating the frozen allowlist.",
    );
  }
  if (postResult.toolCount !== selected.expectedPostToolCount) {
    throw new Error(
      `Expected ${selected.expectedPostToolCount} POST tools but generated ${postResult.toolCount}. ` +
        "The upstream OpenAPI may have changed; review before updating the frozen allowlist.",
    );
  }
  await writeFile(readOutputPath, `${JSON.stringify(readResult.output, null, 2)}\n`, "utf8");
  await writeFile(writeOutputPath, `${JSON.stringify(writeResult.output, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Generated ${profile.toUpperCase()} allowlists: ` +
      `${readResult.toolCount} GET tools (${readResult.excludedCount} excluded), ` +
      `${postResult.toolCount} POST tools (${postResult.excludedCount} excluded) and ` +
      `${putResult.toolCount} PUT tools (${putResult.excludedCount} excluded).\n`,
  );
}

await main();
