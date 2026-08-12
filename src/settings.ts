import { isIP } from "node:net";

export interface AppSettings {
  host: string;
  port: number;
  mcpInstanceName: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  mcpApiKey?: string;
  cxmBaseUrl: URL;
  cxmAccessToken?: string;
  cxmAccessTokenFile?: string;
  cxmRefreshToken?: string;
  cxmRefreshTokenFile?: string;
  cxmOAuthClientId: string;
  cxmOAuthScope: string;
  cxmInteractiveLogin: boolean;
  cxmTenantId?: string;
  requestTimeoutMs: number;
  maxRequestBytes: number;
  maxUploadBytes: number;
  maxResponseBytes: number;
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? [...new Set(entries)] : undefined;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function booleanSetting(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const raw = optional(env[name]);
  if (!raw) return fallback;
  if (/^(true|1|yes|on)$/i.test(raw)) return true;
  if (/^(false|0|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): AppSettings {
  const host = optional(env.HOST) ?? "127.0.0.1";
  const allowedHosts = csv(env.MCP_ALLOWED_HOSTS);
  if (!isLoopback(host) && !allowedHosts) {
    throw new Error(
      "MCP_ALLOWED_HOSTS is required when HOST is not loopback (for DNS rebinding protection)",
    );
  }

  const cxmBaseUrl = new URL(
    optional(env.CXM_BASE_URL) ?? "https://cxm.erp-uat.hicas.vn",
  );
  if (cxmBaseUrl.protocol !== "https:" && !isLoopback(cxmBaseUrl.hostname)) {
    throw new Error("CXM_BASE_URL must use HTTPS unless it points to loopback");
  }

  const settings: AppSettings = {
    host,
    port: integerSetting(env, "PORT", 9000, 1, 65_535),
    mcpInstanceName: optional(env.MCP_INSTANCE_NAME) ?? "hicas-cxm",
    cxmBaseUrl,
    cxmOAuthClientId: optional(env.CXM_OAUTH_CLIENT_ID) ?? "CxmApi_App",
    cxmOAuthScope: optional(env.CXM_OAUTH_SCOPE) ?? "offline_access CxmApi",
    cxmInteractiveLogin: booleanSetting(env, "CXM_INTERACTIVE_LOGIN"),
    requestTimeoutMs: integerSetting(env, "CXM_REQUEST_TIMEOUT_MS", 30_000, 1_000, 300_000),
    maxRequestBytes: integerSetting(
      env,
      "CXM_MAX_REQUEST_BYTES",
      1024 * 1024,
      16 * 1024,
      16 * 1024 * 1024,
    ),
    maxUploadBytes: integerSetting(
      env,
      "CXM_MAX_UPLOAD_BYTES",
      10 * 1024 * 1024,
      16 * 1024,
      32 * 1024 * 1024,
    ),
    maxResponseBytes: integerSetting(
      env,
      "CXM_MAX_RESPONSE_BYTES",
      512 * 1024,
      16 * 1024,
      10 * 1024 * 1024,
    ),
  };

  const allowedOrigins = csv(env.MCP_ALLOWED_ORIGINS);
  const mcpKey = optional(env.MCP_KEY);
  const legacyMcpApiKey = optional(env.MCP_API_KEY);
  if (mcpKey && legacyMcpApiKey && mcpKey !== legacyMcpApiKey) {
    throw new Error("MCP_KEY and MCP_API_KEY are both set but do not match");
  }
  const mcpApiKey = mcpKey ?? legacyMcpApiKey;
  const cxmAccessToken = optional(env.CXM_ACCESS_TOKEN);
  const cxmAccessTokenFile = optional(env.CXM_ACCESS_TOKEN_FILE);
  const cxmRefreshToken = optional(env.CXM_REFRESH_TOKEN);
  const cxmRefreshTokenFile = optional(env.CXM_REFRESH_TOKEN_FILE);
  const cxmTenantId = optional(env.CXM_TENANT_ID);
  if (allowedHosts) settings.allowedHosts = allowedHosts;
  if (allowedOrigins) settings.allowedOrigins = allowedOrigins;
  if (mcpApiKey) settings.mcpApiKey = mcpApiKey;
  if (cxmAccessToken) settings.cxmAccessToken = cxmAccessToken;
  if (cxmAccessTokenFile) settings.cxmAccessTokenFile = cxmAccessTokenFile;
  if (cxmRefreshToken) settings.cxmRefreshToken = cxmRefreshToken;
  if (cxmRefreshTokenFile) settings.cxmRefreshTokenFile = cxmRefreshTokenFile;
  if (cxmTenantId) settings.cxmTenantId = cxmTenantId;
  return settings;
}
