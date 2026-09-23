import { createServer } from "node:http";

import { createCxmMcpRuntime } from "./app.js";
import { getAdditionalMcpToolCount } from "./mcp-server.js";
import { loadSettings } from "./settings.js";
import { createTokenProvider } from "./token-provider.js";
import { loadToolConfig } from "./tool-config.js";

const settings = loadSettings();
const readConfig = loadToolConfig();
const writeConfig = loadToolConfig(
  process.env.CXM_WRITE_TOOLS_CONFIG ?? "config/write-tools.json",
);
const bimConfig = process.env.BIM_TOOLS_CONFIG
  ? loadToolConfig(process.env.BIM_TOOLS_CONFIG)
  : undefined;
const checkInReadConfig = process.env.TINGOP_CHECKIN_TOOLS_CONFIG
  ? loadToolConfig(process.env.TINGOP_CHECKIN_TOOLS_CONFIG)
  : undefined;
const checkInWriteConfig = process.env.TINGOP_CHECKIN_WRITE_TOOLS_CONFIG
  ? loadToolConfig(process.env.TINGOP_CHECKIN_WRITE_TOOLS_CONFIG)
  : undefined;
if (!!checkInReadConfig !== !!checkInWriteConfig) {
  throw new Error(
    "TINGOP_CHECKIN_TOOLS_CONFIG and TINGOP_CHECKIN_WRITE_TOOLS_CONFIG must be configured together",
  );
}
const checkInConfig = checkInReadConfig && checkInWriteConfig
  ? { read: checkInReadConfig, write: checkInWriteConfig }
  : undefined;
const tokenProvider = createTokenProvider(settings);
const runtime = createCxmMcpRuntime(
  settings,
  readConfig,
  writeConfig,
  tokenProvider,
  fetch,
  bimConfig,
  checkInConfig,
);
const httpServer = createServer(runtime.app);
const allTools = [
  ...readConfig.tools,
  ...writeConfig.tools,
  ...(bimConfig?.tools ?? []),
  ...(checkInConfig?.read.tools ?? []),
  ...(checkInConfig?.write.tools ?? []),
];
const additionalReadTools = getAdditionalMcpToolCount(allTools);
const methodCounts = ["GET", "POST", "PUT", "DELETE"]
  .map(
    (method) =>
      `${method} ${allTools.filter((tool) => tool.method === method).length + (method === "GET" ? additionalReadTools : 0)}`,
  )
  .filter((entry) => !entry.endsWith(" 0"));

httpServer.listen(settings.port, settings.host, () => {
  console.log(
    `${settings.mcpUpstreamName ?? "CXM"} MCP listening on http://${settings.host}:${settings.port} with ` +
      `${allTools.length + additionalReadTools} tools at /mcp (${methodCounts.join(", ")})`,
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
