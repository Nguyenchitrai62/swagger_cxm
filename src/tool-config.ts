import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

const primitiveValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const parameterSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9]*$/, "Parameter names must be lower camelCase"),
  wireName: z.string().min(1),
  source: z.enum(["path", "query"]),
  type: z.enum(["string", "integer", "number", "boolean", "array", "object"]),
  itemType: z.enum(["string", "integer", "number", "boolean", "object"]).optional(),
  required: z.boolean().default(false),
  description: z.string().min(1),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  default: z.union([primitiveValueSchema, z.array(primitiveValueSchema)]).optional(),
  enum: z.array(primitiveValueSchema).min(1).optional(),
});

const bodyFieldSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  wireName: z.string().min(1),
  type: z.enum(["string", "integer", "number", "boolean", "array", "object"]),
  itemType: z.enum(["string", "integer", "number", "boolean", "object"]).optional(),
  required: z.boolean().default(false),
  description: z.string().min(1),
  format: z.string().min(1).optional(),
});

const requestBodySchema = z.strictObject({
  mode: z.enum(["json", "multipart"]),
  required: z.boolean().default(false),
  rootType: z.enum(["string", "integer", "number", "boolean", "array", "object"]),
  description: z.string().min(1),
  fields: z.array(bodyFieldSchema),
});

const toolDefinitionSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9_-]+$/, "Tool names must use lowercase letters, numbers, _ or -"),
  title: z.string().min(1),
  description: z.string().min(1),
  tag: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT"]),
  path: z.string().startsWith("/"),
  safety: z.enum(["read-only", "review", "write", "destructive"]),
  parameters: z.array(parameterSchema).default([]),
  requestBody: requestBodySchema.optional(),
});

const toolConfigSchema = z.strictObject({
  generatedAt: z.string().datetime(),
  sourceOpenApi: z.string().url(),
  sourceTitle: z.string().min(1),
  selectedTags: z.array(z.string()).min(1),
  tools: z.array(toolDefinitionSchema).min(1),
});

export type ToolParameter = z.infer<typeof parameterSchema>;
export type ToolBodyField = z.infer<typeof bodyFieldSchema>;
export type ToolRequestBody = z.infer<typeof requestBodySchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type ToolConfig = z.infer<typeof toolConfigSchema>;

export function loadToolConfig(configPath = process.env.CXM_TOOLS_CONFIG): ToolConfig {
  const absolutePath = resolve(configPath ?? "config/tools.json");
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read tool allowlist at ${absolutePath}: ${message}`);
  }

  const config = toolConfigSchema.parse(parsed);
  validateToolConfig(config);
  return config;
}

export function validateToolConfig(config: ToolConfig): void {
  const toolNames = new Set<string>();
  const endpointKeys = new Set<string>();

  for (const tool of config.tools) {
    if (!config.selectedTags.includes(tool.tag)) {
      throw new Error(`Tool ${tool.name} has a non-allowlisted tag: ${tool.tag}`);
    }

    if (toolNames.has(tool.name)) {
      throw new Error(`Duplicate MCP tool name: ${tool.name}`);
    }
    toolNames.add(tool.name);

    const endpointKey = `${tool.method} ${tool.path}`;
    if (endpointKeys.has(endpointKey)) {
      throw new Error(`Duplicate endpoint in tool allowlist: ${endpointKey}`);
    }
    endpointKeys.add(endpointKey);

    if (tool.path.startsWith("//") || tool.path.includes("://") || tool.path.includes("..")) {
      throw new Error(`Unsafe path in tool ${tool.name}: ${tool.path}`);
    }

    if (tool.method === "GET" && !["read-only", "review"].includes(tool.safety)) {
      throw new Error(`GET tool ${tool.name} has invalid safety ${tool.safety}`);
    }
    if (tool.method !== "GET" && !["write", "destructive"].includes(tool.safety)) {
      throw new Error(`${tool.method} tool ${tool.name} has invalid safety ${tool.safety}`);
    }
    if (tool.method === "GET" && tool.requestBody) {
      throw new Error(`GET tool ${tool.name} cannot define a request body`);
    }

    const parameterNames = new Set<string>();
    for (const parameter of tool.parameters) {
      if (parameterNames.has(parameter.name)) {
        throw new Error(`Duplicate parameter ${parameter.name} in tool ${tool.name}`);
      }
      parameterNames.add(parameter.name);
    }

    const placeholders = [...tool.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const pathParameters = tool.parameters.filter((parameter) => parameter.source === "path");

    for (const placeholder of placeholders) {
      const matchingParameter = pathParameters.find(
        (parameter) => parameter.wireName === placeholder,
      );
      if (!matchingParameter || !matchingParameter.required) {
        throw new Error(
          `Path placeholder {${placeholder}} in ${tool.name} needs a required path parameter`,
        );
      }
    }

    for (const parameter of pathParameters) {
      if (!placeholders.includes(parameter.wireName)) {
        throw new Error(
          `Path parameter ${parameter.name} is not present in the path for ${tool.name}`,
        );
      }
    }
  }
}
