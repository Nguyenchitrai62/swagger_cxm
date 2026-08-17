import type { CallToolResult } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { CxmApiClient, CxmApiError, type JsonValue } from "./cxm-client.js";
import type { ToolDefinition, ToolParameter } from "./tool-config.js";

function baseSchema(parameter: ToolParameter): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (parameter.type) {
    case "integer":
      schema = z.number().int();
      break;
    case "number":
      schema = z.number().finite();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "array": {
      const item = baseSchema({
        ...parameter,
        type: parameter.itemType ?? "string",
        required: true,
      });
      schema = z.array(item).max(100);
      break;
    }
    case "object":
      schema = z
        .record(z.string(), z.json())
        .refine((value) => Object.keys(value).length <= 100, "At most 100 filter keys are allowed");
      break;
    default:
      schema = z.string().max(10_000);
  }

  if (parameter.source === "path" && parameter.type === "string") {
    schema = (schema as z.ZodString).min(1);
  }
  if (parameter.minimum !== undefined && (parameter.type === "integer" || parameter.type === "number")) {
    schema = (schema as z.ZodNumber).min(parameter.minimum);
  }
  if (parameter.maximum !== undefined && (parameter.type === "integer" || parameter.type === "number")) {
    schema = (schema as z.ZodNumber).max(parameter.maximum);
  }
  if (parameter.enum) {
    const allowed = parameter.enum;
    schema = schema.refine(
      (value) => allowed.some((candidate) => Object.is(candidate, value)),
      `Allowed values: ${allowed.join(", ")}`,
    );
  }
  return schema.describe(parameter.description);
}

export function createInputSchema(tool: ToolDefinition): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const parameter of tool.parameters) {
    let schema = baseSchema(parameter);
    if (parameter.default !== undefined) {
      schema = schema.optional().default(parameter.default);
    } else if (!parameter.required) {
      schema = schema.optional();
    }
    shape[parameter.name] = schema;
  }

  if (tool.requestBody?.mode === "json") {
    let bodySchema: z.ZodTypeAny;
    if (tool.requestBody.rootType === "object" && tool.requestBody.fields.length > 0) {
      const bodyShape: Record<string, z.ZodTypeAny> = {};
      for (const field of tool.requestBody.fields) {
        let fieldSchema = baseSchema({
          name: field.name,
          wireName: field.wireName,
          source: "query",
          type: field.type,
          ...(field.itemType ? { itemType: field.itemType } : {}),
          required: field.required,
          description: field.description,
        });
        if (!field.required) fieldSchema = fieldSchema.optional();
        bodyShape[field.name] = fieldSchema;
      }
      bodySchema = z.strictObject(bodyShape);
    } else if (tool.requestBody.rootType === "array") {
      bodySchema = z.array(z.json()).max(1_000);
    } else {
      bodySchema = z.json();
    }
    shape.body = (tool.requestBody.required ? bodySchema : bodySchema.optional()).describe(
      tool.requestBody.description,
    );
  }

  if (tool.requestBody?.mode === "multipart") {
    const regularFields = tool.requestBody.fields.filter(
      (field) => field.format?.toLowerCase() !== "binary",
    );
    if (regularFields.length > 0) {
      const formShape: Record<string, z.ZodTypeAny> = {};
      for (const field of regularFields) {
        let fieldSchema = baseSchema({
          name: field.name,
          wireName: field.wireName,
          source: "query",
          type: field.type,
          ...(field.itemType ? { itemType: field.itemType } : {}),
          required: field.required,
          description: field.description,
        });
        if (!field.required) fieldSchema = fieldSchema.optional();
        formShape[field.name] = fieldSchema;
      }
      const formSchema = z.strictObject(formShape).describe(tool.requestBody.description);
      shape.form = regularFields.some((field) => field.required) ? formSchema : formSchema.optional();
    }
    const fileFields = tool.requestBody.fields.filter(
      (field) => field.format?.toLowerCase() === "binary",
    );
    if (fileFields.length > 0) {
      const filesSchema = z
        .array(
          z.strictObject({
            fieldName: z.enum(fileFields.map((field) => field.wireName) as [string, ...string[]]),
            fileName: z.string().min(1).max(255),
            mediaType: z.string().min(1).max(200).optional(),
            dataBase64: z.string().min(4).max(14_000_000),
          }),
        )
        .max(10)
        .describe("Files encoded as standard base64. Total decoded size is limited by the server.");
      shape.files = fileFields.some((field) => field.required) ? filesSchema.min(1) : filesSchema.optional();
    }
  }

  if (tool.safety === "review") {
    shape.confirmRiskyCall = z
      .literal(true)
      .describe(
        "Required confirmation: this GET endpoint name suggests server-side synchronization.",
      );
  }
  if (tool.method !== "GET") {
    shape.confirmWrite = z
      .literal(true)
      .describe(
        `Required confirmation that the agent may execute this CXM ${tool.method} request.`,
      );
  }
  if (tool.safety === "destructive") {
    shape.confirmDestructive = z
      .literal(true)
      .describe("Additional confirmation for bulk/import/sync/cancel/reject/reset/delete behavior.");
  }
  return z.strictObject(shape);
}

const outputSchema = z.object({
  data: z.json(),
  meta: z.object({
    endpoint: z.string(),
    status: z.number().int(),
    contentType: z.string(),
  }),
});

function errorResult(error: unknown, tool: ToolDefinition): CallToolResult {
  const payload: Record<string, JsonValue> = {
    error: error instanceof Error ? error.message : String(error),
    endpoint: tool.path,
  };
  if (error instanceof CxmApiError) {
    payload.code = error.code;
    if (error.status !== undefined) payload.status = error.status;
    if (error.details !== undefined) payload.details = error.details;
  } else {
    payload.code = "MCP_TOOL_ERROR";
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function createCxmMcpServer(
  tools: readonly ToolDefinition[],
  client: CxmApiClient,
  instanceName = "hicas-cxm",
): McpServer {
  const getCount = tools.filter((tool) => tool.method === "GET").length;
  const postCount = tools.filter((tool) => tool.method === "POST").length;
  const putCount = tools.filter((tool) => tool.method === "PUT").length;
  const breakdown = [`${getCount} GET`, `${postCount} POST`, ...(putCount ? [`${putCount} PUT`] : [])];
  const server = new McpServer(
    {
      name: instanceName,
      version: "1.0.0",
      description:
        "Allowlisted GET, POST and PUT access to HICAS CXM for agent-assisted data QC and controlled operations.",
    },
    {
      instructions:
        `This server exposes ${tools.length} allowlisted CXM tools (${breakdown.join(", ")}). ` +
        "Use GET tools to cross-check projects, contracts, purchase orders, warehouses, transactions, payments, " +
        "fiscal periods, and workflow state. Paginate instead of requesting large result sets. " +
        "Every POST and PUT call requires confirmWrite=true. Tools marked destructive also require " +
        "confirmDestructive=true; confirm exact targets and payloads with the user before calling them.",
    },
  );

  for (const tool of tools) {
    const annotations =
      tool.safety === "read-only"
        ? {
            title: tool.title,
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          }
        : tool.method !== "GET"
          ? {
              title: tool.title,
              readOnlyHint: false,
              destructiveHint: tool.safety === "destructive",
              idempotentHint: tool.method === "PUT",
              openWorldHint: true,
            }
          : {
            title: tool.title,
            openWorldHint: true,
          };

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: createInputSchema(tool),
        outputSchema,
        annotations,
        _meta: {
          "hicas.vn/cxm-tag": tool.tag,
          "hicas.vn/cxm-method": tool.method,
          "hicas.vn/cxm-path": tool.path,
          "hicas.vn/cxm-safety": tool.safety,
        },
      },
      async (rawArgs): Promise<CallToolResult> => {
        const args = rawArgs as Record<string, unknown>;
        try {
          const result = await client.call(tool, args);
          const output = {
            data: result.data,
            meta: {
              endpoint: tool.path,
              status: result.status,
              contentType: result.contentType,
            },
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        } catch (error) {
          return errorResult(error, tool);
        }
      },
    );
  }

  return server;
}
