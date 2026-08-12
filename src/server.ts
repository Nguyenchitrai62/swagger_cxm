import { createServer } from "node:http";

import { createCxmMcpRuntime } from "./app.js";
import { loadSettings } from "./settings.js";
import { createTokenProvider } from "./token-provider.js";
import { loadToolConfig } from "./tool-config.js";

const settings = loadSettings();
const readConfig = loadToolConfig();
const writeConfig = loadToolConfig(
  process.env.CXM_WRITE_TOOLS_CONFIG ?? "config/write-tools.json",
);
const tokenProvider = createTokenProvider(settings);
const runtime = createCxmMcpRuntime(settings, readConfig, writeConfig, tokenProvider);
const httpServer = createServer(runtime.app);

httpServer.listen(settings.port, settings.host, () => {
  console.log(
    `CXM MCP listening on http://${settings.host}:${settings.port} with ` +
      `${readConfig.tools.length + writeConfig.tools.length} tools at /mcp ` +
      `(${readConfig.tools.length} GET, ${writeConfig.tools.length} POST)`,
  );
  if (!tokenProvider.configured) {
    console.warn(
      "CXM token is not configured; tools will return CXM_TOKEN_MISSING until one is provided.",
    );
  }
  if (!settings.mcpApiKey) {
    console.warn("MCP_KEY is not configured; only use this unauthenticated endpoint locally.");
  }
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; shutting down`);
  httpServer.close();
  await runtime.handler.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
