import type { CallToolResult } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { summarizeAttendanceReport } from "./attendance-report.js";
import { CxmApiClient, CxmApiError, type JsonValue } from "./cxm-client.js";
import { getHrToolCount, registerHrTools } from "./hr-tools.js";
import type { ToolDefinition, ToolParameter } from "./tool-config.js";

export const ATTENDANCE_REPORT_TOOL_NAME = "tingop_checkin_attendance_report";

function findAttendanceReportTool(tools: readonly ToolDefinition[]): ToolDefinition | undefined {
  return tools.find(
    (tool) =>
      tool.upstream === "tingop-checkin" &&
      tool.method === "GET" &&
      tool.path === "/api/CheckIn/attendance/company/external/{external_company_Id}/report/range",
  );
}

export function getAdditionalMcpToolCount(tools: readonly ToolDefinition[]): number {
  return (findAttendanceReportTool(tools) ? 1 : 0) + getHrToolCount(tools);
}

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

const attendanceReportInputSchema = z
  .strictObject({
    externalCompanyId: z
      .number()
      .int()
      .positive()
      .describe("Mã companyId số trong TingOp dùng làm external_company_Id của Check-in."),
    fromWorkingDay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the yyyy-MM-dd format")
      .describe("Ngày bắt đầu, định dạng yyyy-MM-dd."),
    toWorkingDay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the yyyy-MM-dd format")
      .describe("Ngày kết thúc, định dạng yyyy-MM-dd."),
    includeDailyRows: z
      .boolean()
      .default(false)
      .describe("Include raw daily rows in addition to the compact summary."),
    maxEmployees: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum number of employees returned in the employee summary."),
  })
  .superRefine((value, context) => {
    const from = Date.parse(`${value.fromWorkingDay}T00:00:00Z`);
    const to = Date.parse(`${value.toWorkingDay}T00:00:00Z`);
    const validFrom =
      Number.isFinite(from) && new Date(from).toISOString().slice(0, 10) === value.fromWorkingDay;
    const validTo =
      Number.isFinite(to) && new Date(to).toISOString().slice(0, 10) === value.toWorkingDay;
    if (!validFrom) {
      context.addIssue({ code: "custom", path: ["fromWorkingDay"], message: "Invalid calendar date" });
    }
    if (!validTo) {
      context.addIssue({ code: "custom", path: ["toWorkingDay"], message: "Invalid calendar date" });
    }
    if (Number.isFinite(from) && Number.isFinite(to)) {
      if (to < from) {
        context.addIssue({
          code: "custom",
          path: ["toWorkingDay"],
          message: "toWorkingDay must be on or after fromWorkingDay",
        });
      }
      if (to - from > 366 * 24 * 60 * 60 * 1_000) {
        context.addIssue({
          code: "custom",
          path: ["toWorkingDay"],
          message: "The report range cannot exceed 366 days",
        });
      }
    }
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
  const additionalReadTools = getAdditionalMcpToolCount(tools);
  const getCount = tools.filter((tool) => tool.method === "GET").length + additionalReadTools;
  const postCount = tools.filter((tool) => tool.method === "POST").length;
  const putCount = tools.filter((tool) => tool.method === "PUT").length;
  const deleteCount = tools.filter((tool) => tool.method === "DELETE").length;
  const breakdown = [
    `${getCount} GET`,
    ...(postCount ? [`${postCount} POST`] : []),
    ...(putCount ? [`${putCount} PUT`] : []),
    ...(deleteCount ? [`${deleteCount} DELETE`] : []),
  ];
  const totalToolCount = tools.length + additionalReadTools;
  const server = new McpServer(
    {
      name: instanceName,
      version: "1.0.0",
      description:
        "Allowlisted CXM, BIM, TingOp, and Check-in API access for agent-assisted data QC and controlled operations.",
    },
    {
      instructions:
        `This server exposes ${totalToolCount} allowlisted tools (${breakdown.join(", ")}). ` +
        "Use GET tools to cross-check projects, contracts, purchase orders, warehouses, transactions, payments, " +
        "fiscal periods, and workflow state. Paginate instead of requesting large result sets. " +
        "Every POST, PUT, and DELETE call requires confirmWrite=true. Tools marked destructive also require " +
        "confirmDestructive=true; confirm exact targets and payloads with the user before calling them. " +
        (additionalReadTools
          ? "Use tingop_hr_directory for companies/projects/teams/employees, " +
            "tingop_checkin_attendance_report for a compact company attendance summary, and " +
            "tingop_checkin_team_daily for one team/day including missing check-ins and detectable late arrivals. " +
            "These convenience tools are read-only; use the prefixed raw GET tools for fields or workflows " +
            "not covered by them."
          : ""),
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
          "hicas.vn/upstream": tool.upstream,
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

  const attendanceReportTool = findAttendanceReportTool(tools);
  if (attendanceReportTool) {
    server.registerTool(
      ATTENDANCE_REPORT_TOOL_NAME,
      {
        title: "TingOp Check-in: Attendance report summary",
        description:
          "Read-only composite tool. Fetches the Check-in company report for a date range and " +
          "summarizes worked minutes, approved minutes, employees, and daily totals. " +
          "Use the direct Check-in GET tools when raw per-day or per-team details are needed.",
        inputSchema: attendanceReportInputSchema,
        outputSchema,
        annotations: {
          title: "TingOp Check-in: Attendance report summary",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        _meta: {
          "hicas.vn/cxm-tag": "CheckIn",
          "hicas.vn/cxm-method": "GET",
          "hicas.vn/cxm-path": attendanceReportTool.path,
          "hicas.vn/cxm-safety": "read-only",
          "hicas.vn/upstream": "tingop-checkin",
          "hicas.vn/composite": "attendance-report",
        },
      },
      async (rawArgs): Promise<CallToolResult> => {
        try {
          const args = attendanceReportInputSchema.parse(rawArgs);
          const result = await client.call(attendanceReportTool, {
            externalCompanyId: args.externalCompanyId,
            fromWorkingDay: args.fromWorkingDay,
            toWorkingDay: args.toWorkingDay,
          });
          const summary = summarizeAttendanceReport(result.data, {
            includeDailyRows: args.includeDailyRows,
            maxEmployees: args.maxEmployees,
          });
          const output = {
            data: {
              externalCompanyId: args.externalCompanyId,
              fromWorkingDay: args.fromWorkingDay,
              toWorkingDay: args.toWorkingDay,
              ...summary,
            },
            meta: {
              endpoint: attendanceReportTool.path,
              status: result.status,
              contentType: result.contentType,
            },
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        } catch (error) {
          return errorResult(error, attendanceReportTool);
        }
      },
    );
  }

  registerHrTools(server, tools, client);

  return server;
}
