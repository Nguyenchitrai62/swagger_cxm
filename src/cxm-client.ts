import type { AppSettings } from "./settings.js";
import type { TokenProvider } from "./token-provider.js";
import type { ToolDefinition } from "./tool-config.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CxmApiResult {
  data: JsonValue;
  status: number;
  contentType: string;
}

export class CxmApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly details?: JsonValue,
  ) {
    super(message);
    this.name = "CxmApiError";
  }
}

type FetchLike = typeof fetch;

interface McpUploadFile {
  fieldName: string;
  fileName: string;
  mediaType?: string;
  dataBase64: string;
}

function appendQueryValue(url: URL, wireName: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  if (Array.isArray(value)) {
    for (const item of value) appendQueryValue(url, wireName, item);
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      appendQueryValue(url, `${wireName}.${key}`, child);
    }
    return;
  }
  url.searchParams.append(wireName, String(value));
}

export function buildRequestUrl(
  baseUrl: URL,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): URL {
  let path = tool.path;
  for (const parameter of tool.parameters.filter((item) => item.source === "path")) {
    const value = args[parameter.name];
    if (value === undefined || value === null || value === "") {
      throw new CxmApiError(
        `Missing required path parameter: ${parameter.name}`,
        "INVALID_TOOL_ARGUMENTS",
      );
    }
    path = path.replace(`{${parameter.wireName}}`, encodeURIComponent(String(value)));
  }
  if (/\{[^}]+\}/.test(path)) {
    throw new CxmApiError("Not all path parameters were resolved", "INVALID_TOOL_CONFIG");
  }

  const url = new URL(path, baseUrl);
  for (const parameter of tool.parameters.filter((item) => item.source === "query")) {
    appendQueryValue(url, parameter.wireName, args[parameter.name]);
  }
  return url;
}

async function readLimitedBody(response: Response, limit: number): Promise<Uint8Array> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > limit) {
    throw new CxmApiError(
      `CXM response is ${advertisedLength} bytes; configured limit is ${limit}`,
      "RESPONSE_TOO_LARGE",
      response.status,
    );
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel("response limit exceeded");
      throw new CxmApiError(
        `CXM response exceeded the configured ${limit}-byte limit`,
        "RESPONSE_TOO_LARGE",
        response.status,
      );
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseBody(bytes: Uint8Array, contentType: string): JsonValue {
  if (bytes.byteLength === 0) return null;
  const normalizedType = contentType.toLowerCase();
  const textLike =
    normalizedType.includes("json") ||
    normalizedType.startsWith("text/") ||
    normalizedType.includes("xml") ||
    normalizedType.includes("javascript");

  if (textLike) {
    const text = new TextDecoder().decode(bytes);
    if (normalizedType.includes("json")) {
      try {
        return JSON.parse(text) as JsonValue;
      } catch {
        return { rawText: text, parseWarning: "CXM returned invalid JSON" };
      }
    }
    return text;
  }

  return {
    mediaType: contentType || "application/octet-stream",
    encoding: "base64",
    data: Buffer.from(bytes).toString("base64"),
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function mapBodyFields(tool: ToolDefinition, value: unknown): unknown {
  if (!tool.requestBody || tool.requestBody.rootType !== "object" || !tool.requestBody.fields.length) {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const field of tool.requestBody.fields) {
    if (Object.hasOwn(input, field.name)) output[field.wireName] = input[field.name];
  }
  return output;
}

function appendFormValue(form: FormData, name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendFormValue(form, name, item);
    return;
  }
  form.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new CxmApiError("Upload dataBase64 is not valid base64", "INVALID_TOOL_ARGUMENTS");
  }
  return Buffer.from(normalized, "base64");
}

export class CxmApiClient {
  constructor(
    private readonly settings: AppSettings,
    private readonly tokenProvider: TokenProvider,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async call(tool: ToolDefinition, args: Record<string, unknown>): Promise<CxmApiResult> {
    let token = await this.tokenProvider.getToken();
    if (!token) {
      throw new CxmApiError(
        "CXM is not signed in. Open /auth/login?MCP_KEY=<YOUR_KEY> in a browser, or configure an access/refresh token.",
        "CXM_TOKEN_MISSING",
      );
    }

    const url = buildRequestUrl(this.settings.cxmBaseUrl, tool, args);
    const headers = new Headers({
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${token}`,
      "user-agent": "cxm-readonly-mcp/1.0.0",
    });
    if (this.settings.cxmTenantId) headers.set("__tenant", this.settings.cxmTenantId);

    const sendsBody = tool.method === "POST" || tool.method === "PUT";
    let requestBody: BodyInit | undefined;
    if (sendsBody && tool.requestBody?.mode === "json") {
      const mappedBody = mapBodyFields(tool, args.body);
      if (mappedBody === undefined && tool.requestBody.required) {
        throw new CxmApiError(`This ${tool.method} requires a JSON body`, "INVALID_TOOL_ARGUMENTS");
      }
      if (mappedBody !== undefined) {
        const serialized = JSON.stringify(mappedBody);
        if (byteLength(serialized) > this.settings.maxRequestBytes) {
          throw new CxmApiError(
            `JSON request exceeds the configured ${this.settings.maxRequestBytes}-byte limit`,
            "REQUEST_TOO_LARGE",
          );
        }
        headers.set("content-type", "application/json");
        requestBody = serialized;
      }
    } else if (sendsBody && tool.requestBody?.mode === "multipart") {
      const form = new FormData();
      const mappedForm = mapBodyFields(tool, args.form);
      if (mappedForm && typeof mappedForm === "object" && !Array.isArray(mappedForm)) {
        const serializedForm = JSON.stringify(mappedForm);
        if (byteLength(serializedForm) > this.settings.maxRequestBytes) {
          throw new CxmApiError("Multipart text fields exceed the configured limit", "REQUEST_TOO_LARGE");
        }
        for (const [name, value] of Object.entries(mappedForm as Record<string, unknown>)) {
          appendFormValue(form, name, value);
        }
      }

      const files = Array.isArray(args.files) ? (args.files as McpUploadFile[]) : [];
      const allowedFileFields = new Set(
        tool.requestBody.fields
          .filter((field) => field.format?.toLowerCase() === "binary")
          .map((field) => field.wireName),
      );
      let totalUploadBytes = 0;
      for (const file of files) {
        if (!file || typeof file !== "object") {
          throw new CxmApiError("Invalid multipart file entry", "INVALID_TOOL_ARGUMENTS");
        }
        if (allowedFileFields.size > 0 && !allowedFileFields.has(file.fieldName)) {
          throw new CxmApiError(
            `Unexpected upload field ${file.fieldName}; allowed: ${[...allowedFileFields].join(", ")}`,
            "INVALID_TOOL_ARGUMENTS",
          );
        }
        const bytes = decodeBase64(file.dataBase64);
        totalUploadBytes += bytes.byteLength;
        if (totalUploadBytes > this.settings.maxUploadBytes) {
          throw new CxmApiError(
            `Uploads exceed the configured ${this.settings.maxUploadBytes}-byte limit`,
            "REQUEST_TOO_LARGE",
          );
        }
        const blobBytes = new Uint8Array(bytes.byteLength);
        blobBytes.set(bytes);
        form.append(
          file.fieldName,
          new Blob([blobBytes], { type: file.mediaType || "application/octet-stream" }),
          file.fileName,
        );
      }
      const requiredFileFields = tool.requestBody.fields
        .filter((field) => field.required && field.format?.toLowerCase() === "binary")
        .map((field) => field.wireName);
      for (const requiredField of requiredFileFields) {
        if (!files.some((file) => file.fieldName === requiredField)) {
          throw new CxmApiError(
            `Missing required upload field: ${requiredField}`,
            "INVALID_TOOL_ARGUMENTS",
          );
        }
      }
      requestBody = form;
    }

    const send = async (bearerToken: string): Promise<Response> => {
      headers.set("authorization", `Bearer ${bearerToken}`);
      try {
        const init: RequestInit = {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(this.settings.requestTimeoutMs),
        };
        init.method = tool.method;
        if (requestBody !== undefined) init.body = requestBody;
        return await this.fetchImpl(url, init);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CxmApiError(`Cannot reach CXM: ${message}`, "CXM_NETWORK_ERROR");
      }
    };

    let response = await send(token);
    if (response.status === 401 && this.tokenProvider.invalidateToken) {
      this.tokenProvider.invalidateToken(token);
      const refreshedToken = await this.tokenProvider.getToken();
      if (refreshedToken && refreshedToken !== token) {
        token = refreshedToken;
        response = await send(token);
      }
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    const bytes = await readLimitedBody(response, this.settings.maxResponseBytes);
    const data = parseBody(bytes, contentType);
    if (!response.ok) {
      throw new CxmApiError(
        `CXM returned HTTP ${response.status}`,
        response.status === 401 ? "CXM_UNAUTHORIZED" : "CXM_HTTP_ERROR",
        response.status,
        data,
      );
    }

    return { data, status: response.status, contentType };
  }

  async get(tool: ToolDefinition, args: Record<string, unknown>): Promise<CxmApiResult> {
    return this.call(tool, args);
  }
}
