import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AppSettings } from "./settings.js";

export interface TokenProvider {
  readonly configured: boolean;
  getToken(): Promise<string | undefined>;
  invalidateToken?(token?: string): void;
  login?(credentials: CxmLoginCredentials): Promise<void>;
  logout?(): void;
  getStatus?(): TokenProviderStatus;
}

export interface CxmLoginCredentials {
  username: string;
  password: string;
  remember: boolean;
}

export interface TokenProviderStatus {
  configured: boolean;
  authenticated: boolean;
}

export class CxmAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CxmAuthenticationError";
  }
}

type FetchLike = typeof fetch;

interface OAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function normalizeToken(value: string | undefined): string | undefined {
  const token = value?.trim().replace(/^Bearer\s+/i, "").trim();
  return token || undefined;
}

function expiresSoon(token: string, skewSeconds = 60): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && payload.exp <= Date.now() / 1000 + skewSeconds;
  } catch {
    return false;
  }
}

async function readTokenFile(path: string, settingName: string): Promise<string | undefined> {
  try {
    return normalizeToken(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${settingName}: ${message}`);
  }
}

export function createTokenProvider(
  settings: AppSettings,
  fetchImpl: FetchLike = fetch,
): TokenProvider {
  let cachedAccessToken: string | undefined;
  let cachedRefreshToken: string | undefined;
  let invalidatedAccessToken: string | undefined;
  let refreshInFlight: Promise<string> | undefined;
  // Interactive mode deliberately ignores inherited/static tokens until the user signs in.
  let loggedOut = settings.cxmInteractiveLogin;

  async function configuredAccessToken(): Promise<string | undefined> {
    return settings.cxmAccessTokenFile
      ? readTokenFile(settings.cxmAccessTokenFile, "CXM_ACCESS_TOKEN_FILE")
      : normalizeToken(settings.cxmAccessToken);
  }

  async function configuredRefreshToken(): Promise<string | undefined> {
    return settings.cxmRefreshTokenFile
      ? readTokenFile(settings.cxmRefreshTokenFile, "CXM_REFRESH_TOKEN_FILE")
      : normalizeToken(settings.cxmRefreshToken);
  }

  async function requestTokens(
    body: URLSearchParams,
    failurePrefix: string,
  ): Promise<{ accessToken: string; refreshToken?: string }> {
    let response: Response;
    try {
      response = await fetchImpl(new URL("/connect/token", settings.cxmBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(settings.requestTimeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CxmAuthenticationError(`${failurePrefix}: ${message}`);
    }

    const raw = await response.text();
    let payload: OAuthTokenResponse = {};
    try {
      payload = JSON.parse(raw) as OAuthTokenResponse;
    } catch {
      // The status and a safe generic message below are more useful than returning HTML.
    }
    if (!response.ok) {
      const upstreamMessage =
        typeof payload.error_description === "string"
          ? payload.error_description.trim().slice(0, 300)
          : undefined;
      throw new CxmAuthenticationError(
        upstreamMessage || `${failurePrefix} (HTTP ${response.status})`,
      );
    }

    const accessToken =
      typeof payload.access_token === "string" ? normalizeToken(payload.access_token) : undefined;
    if (!accessToken) {
      throw new CxmAuthenticationError("CXM token response did not contain access_token");
    }

    const rotatedRefreshToken =
      typeof payload.refresh_token === "string"
        ? normalizeToken(payload.refresh_token)
        : undefined;
    return {
      accessToken,
      ...(rotatedRefreshToken ? { refreshToken: rotatedRefreshToken } : {}),
    };
  }

  async function acceptTokens(
    accessToken: string,
    refreshToken: string | undefined,
    previousRefreshToken?: string,
  ): Promise<string> {
    cachedAccessToken = accessToken;
    cachedRefreshToken = refreshToken ?? previousRefreshToken;
    invalidatedAccessToken = undefined;
    loggedOut = false;

    if (refreshToken && settings.cxmRefreshTokenFile) {
      try {
        await mkdir(dirname(settings.cxmRefreshTokenFile), { recursive: true });
        await writeFile(settings.cxmRefreshTokenFile, `${refreshToken}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        // `mode` only applies when a file is created. Tighten permissions after
        // every rotation as well, including files mounted by a deployment.
        await chmod(settings.cxmRefreshTokenFile, 0o600);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Could not persist rotated CXM refresh token: ${message}`);
      }
    }
    return accessToken;
  }

  async function refreshAccessToken(refreshToken: string): Promise<string> {
    const tokens = await requestTokens(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: settings.cxmOAuthClientId,
        scope: settings.cxmOAuthScope,
        remember: "true",
      }),
      "Cannot refresh CXM access token",
    );
    return acceptTokens(tokens.accessToken, tokens.refreshToken, refreshToken);
  }

  function isConfigured(): boolean {
    return (
      !loggedOut &&
      Boolean(
        cachedAccessToken ||
          cachedRefreshToken ||
          settings.cxmAccessToken ||
          settings.cxmAccessTokenFile ||
          settings.cxmRefreshToken ||
          settings.cxmRefreshTokenFile,
      )
    );
  }

  return {
    get configured(): boolean {
      return isConfigured();
    },
    async getToken(): Promise<string | undefined> {
      if (loggedOut) return undefined;
      const accessToken = cachedAccessToken ?? (await configuredAccessToken());
      const usableAccessToken =
        accessToken && accessToken !== invalidatedAccessToken && !expiresSoon(accessToken)
          ? accessToken
          : undefined;
      if (usableAccessToken) return usableAccessToken;

      const refreshToken = cachedRefreshToken ?? (await configuredRefreshToken());
      if (!refreshToken) return accessToken;

      refreshInFlight ??= refreshAccessToken(refreshToken).finally(() => {
        refreshInFlight = undefined;
      });
      return refreshInFlight;
    },
    invalidateToken(token?: string): void {
      invalidatedAccessToken = token ?? cachedAccessToken;
      if (!token || token === cachedAccessToken) cachedAccessToken = undefined;
    },
    async login(credentials: CxmLoginCredentials): Promise<void> {
      const username = credentials.username.trim();
      if (!username || !credentials.password) {
        throw new CxmAuthenticationError("Tên đăng nhập và mật khẩu là bắt buộc");
      }
      const scope = credentials.remember
        ? settings.cxmOAuthScope
        : settings.cxmOAuthScope.replace(/\boffline_access\b/gi, "").trim() || "CxmApi";
      const tokens = await requestTokens(
        new URLSearchParams({
          grant_type: "password",
          username,
          password: credentials.password,
          client_id: settings.cxmOAuthClientId,
          scope,
          remember: String(credentials.remember),
        }),
        "Đăng nhập CXM thất bại",
      );
      await acceptTokens(tokens.accessToken, tokens.refreshToken);
    },
    logout(): void {
      cachedAccessToken = undefined;
      cachedRefreshToken = undefined;
      invalidatedAccessToken = undefined;
      refreshInFlight = undefined;
      loggedOut = true;
    },
    getStatus(): TokenProviderStatus {
      const configured = isConfigured();
      return {
        configured,
        authenticated:
          configured &&
          Boolean(
            cachedAccessToken || settings.cxmAccessToken || settings.cxmAccessTokenFile,
          ),
      };
    },
  };
}
