import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { urlencoded } from "express";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

import { renderAuthPage } from "./auth-page.js";
import { CxmApiClient } from "./cxm-client.js";
import { createCxmMcpServer } from "./mcp-server.js";
import type { AppSettings } from "./settings.js";
import { CxmAuthenticationError, type TokenProvider } from "./token-provider.js";
import type { ToolConfig } from "./tool-config.js";

export interface CxmMcpRuntime {
  app: Express;
  handler: McpHttpHandler;
}

function mcpKeyAuth(expectedKey: string | undefined): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!expectedKey) {
      next();
      return;
    }

    const authorization = request.header("authorization") ?? "";
    const bearerKey = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const queryValue = request.query.MCP_KEY;
    const queryKey = typeof queryValue === "string" ? queryValue : "";
    const expectedBytes = Buffer.from(expectedKey);
    const valid = [bearerKey, queryKey].some((provided) => {
      const providedBytes = Buffer.from(provided);
      return (
        expectedBytes.length === providedBytes.length &&
        timingSafeEqual(expectedBytes, providedBytes)
      );
    });
    if (!valid) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="cxm-mcp"');
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}

function queryCredential(request: Request): string | undefined {
  const value = request.query.MCP_KEY;
  return typeof value === "string" && value ? value : undefined;
}

function withMcpKey(path: string, request: Request): string {
  const key = queryCredential(request);
  return key ? `${path}?MCP_KEY=${encodeURIComponent(key)}` : path;
}

function sendAuthPage(
  request: Request,
  response: Response,
  tokenProvider: TokenProvider,
  options: { error?: string; success?: boolean } = {},
): void {
  const status = tokenProvider.getStatus?.() ?? {
    configured: tokenProvider.configured,
    authenticated: tokenProvider.configured,
  };
  response.set({
    "cache-control": "no-store, max-age=0",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.type("html").send(
    renderAuthPage({
      authenticated: status.authenticated,
      actionUrl: withMcpKey("/auth/login", request),
      logoutUrl: withMcpKey("/auth/logout", request),
      mcpUrl: withMcpKey("/mcp", request),
      ...options,
    }),
  );
}

async function serveWebHandler(
  handler: McpHttpHandler,
  request: Request,
  response: Response,
): Promise<void> {
  const abortController = new AbortController();
  request.once("aborted", () => abortController.abort());

  const url = new URL(request.originalUrl, `${request.protocol}://${request.get("host")}`);
  // Never expose the query-string credential to the protocol handler or its diagnostics.
  url.searchParams.delete("MCP_KEY");
  const headers = new Headers(request.headers as HeadersInit);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const init: RequestInit = {
    method: request.method,
    headers,
    signal: abortController.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined) {
    init.body = JSON.stringify(request.body);
  }

  const webResponse = await handler.fetch(new globalThis.Request(url, init));
  response.status(webResponse.status);
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  if (!webResponse.body) {
    response.end();
    return;
  }

  await pipeline(
    Readable.fromWeb(webResponse.body as import("node:stream/web").ReadableStream<Uint8Array>),
    response,
  );
}

export function createCxmMcpRuntime(
  settings: AppSettings,
  readConfig: ToolConfig,
  writeConfig: ToolConfig,
  tokenProvider: TokenProvider,
  fetchImpl: typeof fetch = fetch,
): CxmMcpRuntime {
  const appOptions: Parameters<typeof createMcpExpressApp>[0] = {
    host: settings.host,
    jsonLimit: "1mb",
  };
  if (settings.allowedHosts) appOptions.allowedHosts = settings.allowedHosts;
  if (settings.allowedOrigins) appOptions.allowedOrigins = settings.allowedOrigins;
  const app = createMcpExpressApp(appOptions);
  app.use(urlencoded({ extended: false, limit: "16kb" }));

  const client = new CxmApiClient(settings, tokenProvider, fetchImpl);
  const tools = [...readConfig.tools, ...writeConfig.tools];
  const handler = createMcpHandler(() => createCxmMcpServer(tools, client), {
    responseMode: "auto",
    onerror: (error) => console.error("MCP protocol error:", error.message),
  });

  app.get("/", (_request, response) => {
    response.json({
      name: "hicas-cxm",
      version: "1.0.0",
      transport: "MCP Streamable HTTP",
      endpoint: "/mcp",
      login: "/auth/login?MCP_KEY=<YOUR_KEY>",
      health: "/healthz",
      readTools: readConfig.tools.length,
      writeTools: writeConfig.tools.length,
      totalTools: tools.length,
      authentication: settings.mcpApiKey
        ? ["MCP_KEY query parameter", "Authorization Bearer header"]
        : [],
    });
  });
  app.get("/healthz", (_request, response) => {
    response.json({
      status: "ok",
      readToolCount: readConfig.tools.length,
      writeToolCount: writeConfig.tools.length,
      totalToolCount: tools.length,
      selectedReadTags: readConfig.selectedTags,
      selectedWriteTags: writeConfig.selectedTags,
      cxmTokenConfigured: tokenProvider.configured,
    });
  });

  const auth = mcpKeyAuth(settings.mcpApiKey);
  app.get("/auth/login", auth, (request, response) => {
    sendAuthPage(request, response, tokenProvider, {
      success: request.query.success === "1",
    });
  });
  app.post("/auth/login", auth, async (request, response) => {
    if (!tokenProvider.login) {
      response.status(501);
      sendAuthPage(request, response, tokenProvider, {
        error: "Token provider hiện tại không hỗ trợ đăng nhập tương tác.",
      });
      return;
    }
    const username = typeof request.body?.username === "string" ? request.body.username : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    const remember = request.body?.remember === "true";
    if (username.length > 200 || password.length > 500) {
      response.status(400);
      sendAuthPage(request, response, tokenProvider, { error: "Dữ liệu đăng nhập không hợp lệ." });
      return;
    }
    try {
      await tokenProvider.login({ username, password, remember });
      const loginUrl = withMcpKey("/auth/login", request);
      response.redirect(303, `${loginUrl}${loginUrl.includes("?") ? "&" : "?"}success=1`);
    } catch (error) {
      response.status(error instanceof CxmAuthenticationError ? 401 : 502);
      sendAuthPage(request, response, tokenProvider, {
        error:
          error instanceof CxmAuthenticationError
            ? error.message
            : "Không thể kết nối máy chủ đăng nhập CXM.",
      });
    }
  });
  app.post("/auth/logout", auth, (request, response) => {
    tokenProvider.logout?.();
    response.redirect(303, withMcpKey("/auth/login", request));
  });
  app.get("/auth/status", auth, (_request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json(
      tokenProvider.getStatus?.() ?? {
        configured: tokenProvider.configured,
        authenticated: tokenProvider.configured,
      },
    );
  });

  // A human opening the MCP URL gets the login UI. MCP clients use JSON/SSE Accept headers.
  app.get("/mcp", auth, (request, response, next) => {
    if ((request.header("accept") ?? "").includes("text/html")) {
      response.redirect(303, withMcpKey("/auth/login", request));
      return;
    }
    next();
  });
  app.all("/mcp", auth, async (request, response) => {
    try {
      await serveWebHandler(handler, request, response);
    } catch (error) {
      console.error("MCP HTTP adapter error:", error);
      if (!response.headersSent) response.status(500).json({ error: "Internal MCP error" });
      else response.end();
    }
  });

  return { app, handler };
}
