import type { CallToolResult } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { CxmApiClient, CxmApiError, type JsonValue } from "./cxm-client.js";
import type { ToolDefinition } from "./tool-config.js";

export const HR_DIRECTORY_TOOL_NAME = "tingop_hr_directory";
export const TEAM_DAILY_TOOL_NAME = "tingop_checkin_team_daily";

type JsonObject = { [key: string]: JsonValue };

const highLevelOutputSchema = z.object({
  data: z.json(),
  meta: z.object({
    endpoint: z.string(),
    status: z.number().int(),
    contentType: z.string(),
  }),
});

const directoryInputSchema = z.strictObject({
  resource: z
    .enum(["companies", "projects", "teams", "employees"])
    .describe("Directory resource to list or search."),
  companyId: z.number().int().positive().optional().describe("Filter by TingOp company ID."),
  projectId: z.number().int().positive().optional().describe("Filter teams by TingOp project ID."),
  search: z.string().max(200).optional().describe("Optional name/code search."),
  pageSize: z.number().int().min(1).max(100).default(100).describe("Maximum source rows to request."),
});

const teamDailyInputSchema = z.strictObject({
  teamId: z.number().int().positive().describe("TingOp team ID."),
  workingDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the yyyy-MM-dd format")
    .describe("Working day in yyyy-MM-dd format."),
  lateGraceMinutes: z
    .number()
    .int()
    .min(0)
    .max(120)
    .default(0)
    .describe("Ignore lateness up to this many minutes after the scheduled shift start."),
  includeRaw: z.boolean().default(false).describe("Include the raw team review response."),
});

function findTool(
  tools: readonly ToolDefinition[],
  path: string,
  upstream: "tingop" | "tingop-checkin",
): ToolDefinition | undefined {
  return tools.find((tool) => tool.method === "GET" && tool.upstream === upstream && tool.path === path);
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return undefined;
}

function records(value: JsonValue | undefined): JsonObject[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const object = objectValue(item);
      return object ? [object] : [];
    });
  }
  const object = objectValue(value);
  if (!object) return [];
  for (const key of ["results", "items", "data", "result"]) {
    const child = object[key];
    if (Array.isArray(child)) return records(child);
  }
  return [];
}

function matchesSearch(record: JsonObject, search: string | undefined): boolean {
  if (!search) return true;
  const needle = search.toLocaleLowerCase();
  return ["name", "code", "employeeCode", "firstName", "middleName", "lastName", "projectGuid"]
    .map((key) => stringValue(record[key])?.toLocaleLowerCase() ?? "")
    .some((value) => value.includes(needle));
}

function outputResult(
  data: JsonValue,
  endpoint: string,
  status: number,
  contentType: string,
): CallToolResult {
  const output = { data, meta: { endpoint, status, contentType } };
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
  };
}

function errorResult(error: unknown, endpoint: string): CallToolResult {
  const payload: Record<string, JsonValue> = {
    error: error instanceof Error ? error.message : String(error),
    endpoint,
    code: error instanceof CxmApiError ? error.code : "MCP_TOOL_ERROR",
  };
  if (error instanceof CxmApiError) {
    if (error.status !== undefined) payload.status = error.status;
    if (error.details !== undefined) payload.details = error.details;
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function argsForTool(
  tool: ToolDefinition,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set(tool.parameters.map((parameter) => parameter.name));
  return Object.fromEntries(Object.entries(values).filter(([key]) => allowed.has(key)));
}

function getParameterValue(record: JsonObject, keys: string[]): JsonValue {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return null;
}

function parseTime(value: JsonValue | undefined): { hours: number; minutes: number; seconds: number } | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return undefined;
  return {
    hours: Number(match[1]),
    minutes: Number(match[2]),
    seconds: Number(match[3] ?? 0),
  };
}

function eventDate(value: JsonValue | undefined, workingDay: string): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : `${value.replace(" ", "T")}+07:00`;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  if (!value.includes("T") && !value.includes(" ")) {
    return new Date(`${workingDay}T${value}+07:00`);
  }
  return parsed;
}

function scheduledDate(workingDay: string, time: JsonValue | undefined): Date | undefined {
  const parsed = parseTime(time);
  if (!parsed) return undefined;
  return new Date(
    `${workingDay}T${String(parsed.hours).padStart(2, "0")}:${String(parsed.minutes).padStart(2, "0")}:${String(parsed.seconds).padStart(2, "0")}+07:00`,
  );
}

function arrayObjects(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const object = objectValue(item);
    return object ? [object] : [];
  });
}

function checkInEvents(person: JsonObject): JsonObject[] {
  const direct = arrayObjects(person.checkIn_List);
  const grouped = objectValue(person.shift_CheckIn_List);
  if (!grouped) return direct;
  const groupedEvents = Object.values(grouped).flatMap((value) => arrayObjects(value));
  return [...direct, ...groupedEvents].filter(
    (event, index, all) =>
      all.findIndex((candidate) => candidate.id !== undefined && candidate.id === event.id) === index,
  );
}

function latePeople(
  people: JsonObject[],
  workingDay: string,
  lateGraceMinutes: number,
): JsonObject[] {
  const output: JsonObject[] = [];
  for (const person of people) {
    const options = arrayObjects(person.shift_CheckIn_Option);
    const grouped = objectValue(person.shift_CheckIn_List);
    const events = checkInEvents(person);
    for (const option of options) {
      const shiftId = stringValue(option.id) ?? stringValue(option.shiftId);
      const scheduled = scheduledDate(workingDay, option.startTime);
      if (!shiftId || !scheduled || !grouped) continue;
      const shiftEvents = arrayObjects(grouped[shiftId]);
      const firstEvent = shiftEvents
        .map((event) => ({ event, date: eventDate(event.timeStamp, workingDay) }))
        .filter((item): item is { event: JsonObject; date: Date } => item.date !== undefined)
        .sort((left, right) => left.date.getTime() - right.date.getTime())[0];
      if (!firstEvent) continue;
      const delay = Math.floor((firstEvent.date.getTime() - scheduled.getTime()) / 60_000);
      if (delay > lateGraceMinutes) {
        output.push({
          employeeId: getParameterValue(person, ["employeeId"]),
          employeeCode: getParameterValue(person, ["employeeCode"]),
          employeeName: getParameterValue(person, ["name", "employee_Name"]),
          shiftId: option.id ?? option.shiftId ?? null,
          scheduledStart: option.startTime ?? null,
          firstCheckIn: firstEvent.event.timeStamp ?? null,
          lateMinutes: delay,
        });
      }
    }
  }
  return output;
}

export function summarizeTeamDaily(
  data: JsonValue,
  teamId: number,
  workingDay: string,
  lateGraceMinutes: number,
  includeRaw = false,
): JsonObject {
  const response = objectValue(data) ?? {};
  const inside = arrayObjects(response.inSide_Team);
  const outside = arrayObjects(response.outSide_Team);
  const checkedIn = [...inside, ...outside].filter((person) => checkInEvents(person).length > 0);
  const missing = inside.filter((person) => checkInEvents(person).length === 0);
  const late = latePeople(inside, workingDay, lateGraceMinutes);
  const summary: JsonObject = {
    teamId,
    workingDay,
    insideTeamCount: inside.length,
    outsideTeamCount: outside.length,
    checkedInCount: checkedIn.length,
    missingCheckInCount: missing.length,
    lateCount: late.length,
    latePeople: late,
    missingPeople: missing.map((person) => ({
      employeeId: getParameterValue(person, ["employeeId"]),
      employeeCode: getParameterValue(person, ["employeeCode"]),
      employeeName: getParameterValue(person, ["name", "employee_Name"]),
    })),
    lateDetection: "Only rows with a scheduled shift start and a first check-in timestamp are classified as late.",
  };
  if (includeRaw) summary.raw = data;
  return summary;
}

function registerDirectoryTool(
  server: McpServer,
  tools: readonly ToolDefinition[],
  client: CxmApiClient,
): boolean {
  const employeeList = findTool(tools, "/api/Employee", "tingop");
  const employeeByCompany = findTool(tools, "/api/Employee/company/{companyId}", "tingop");
  const projectList = findTool(tools, "/api/Project", "tingop");
  const projectByCompany = findTool(tools, "/api/Project/company/{id}", "tingop");
  const teamList = findTool(tools, "/api/Team", "tingop");
  const teamByProject = findTool(tools, "/api/Team/project/{id}", "tingop");
  const companyDetails = findTool(tools, "/Companies/{id}", "tingop");
  if (!employeeList || !projectList || !teamList) return false;

  server.registerTool(
    HR_DIRECTORY_TOOL_NAME,
    {
      title: "TingOp HR: Directory",
      description:
        "Read-only HR directory helper. Lists companies, projects/offices, teams, or employees " +
        "with practical filters. Use the raw GET tools when an exact API response or uncommon filter is needed.",
      inputSchema: directoryInputSchema,
      outputSchema: highLevelOutputSchema,
      annotations: {
        title: "TingOp HR: Directory",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: {
        "hicas.vn/cxm-tag": "HRDirectory",
        "hicas.vn/cxm-method": "GET",
        "hicas.vn/cxm-safety": "read-only",
        "hicas.vn/upstream": "tingop",
        "hicas.vn/composite": "hr-directory",
      },
    },
    async (rawArgs): Promise<CallToolResult> => {
      const args = directoryInputSchema.parse(rawArgs);
      try {
        if (args.resource === "companies") {
          const [employeeResult, projectResult] = await Promise.all([
            client.call(employeeList, argsForTool(employeeList, { pageSize: args.pageSize })),
            client.call(projectList, argsForTool(projectList, { pageSize: args.pageSize })),
          ]);
          const groups = new Map<string, JsonObject>();
          for (const employee of records(employeeResult.data)) {
            const id = stringValue(employee.companyId);
            if (!id) continue;
            const current = groups.get(id) ?? {
              id: Number.isFinite(Number(id)) ? Number(id) : id,
              employeeCount: 0,
              projectCount: 0,
              projectNames: [],
            };
            current.employeeCount = Number(current.employeeCount) + 1;
            groups.set(id, current);
          }
          for (const project of records(projectResult.data)) {
            const id = stringValue(project.companyId);
            if (!id) continue;
            const current = groups.get(id) ?? {
              id: Number.isFinite(Number(id)) ? Number(id) : id,
              employeeCount: 0,
              projectCount: 0,
              projectNames: [],
            };
            current.projectCount = Number(current.projectCount) + 1;
            const names = Array.isArray(current.projectNames)
              ? current.projectNames.filter((item): item is string => typeof item === "string")
              : [];
            const name = stringValue(project.name) ?? stringValue(project.code);
            if (name && !names.includes(name) && names.length < 20) names.push(name);
            current.projectNames = names;
            groups.set(id, current);
          }
          let items = [...groups.values()];
          if (args.companyId !== undefined) items = items.filter((item) => Number(item.id) === args.companyId);
          if (companyDetails) {
            items = await Promise.all(
              items.slice(0, 100).map(async (item) => {
                try {
                  const detail = await client.call(companyDetails, { id: Number(item.id) });
                  return { ...item, details: detail.data };
                } catch {
                  return item;
                }
              }),
            );
          }
          return outputResult(
            { resource: args.resource, count: items.length, items },
            "/Companies/{id} + /api/Employee + /api/Project",
            200,
            "application/json",
          );
        }

        let sourceTool: ToolDefinition;
        let sourceArgs: Record<string, unknown> = { pageSize: args.pageSize, search: args.search };
        if (args.resource === "employees") {
          sourceTool = args.companyId !== undefined && employeeByCompany ? employeeByCompany : employeeList;
          if (sourceTool === employeeByCompany && args.companyId !== undefined) {
            sourceArgs.companyId = args.companyId;
          }
        } else if (args.resource === "projects") {
          sourceTool = args.companyId !== undefined && projectByCompany ? projectByCompany : projectList;
          if (sourceTool === projectByCompany && args.companyId !== undefined) sourceArgs.id = args.companyId;
        } else {
          sourceTool = args.projectId !== undefined && teamByProject ? teamByProject : teamList;
          if (sourceTool === teamByProject && args.projectId !== undefined) sourceArgs.id = args.projectId;
        }
        const result = await client.call(sourceTool, argsForTool(sourceTool, sourceArgs));
        let items = records(result.data).filter((item) => matchesSearch(item, args.search));
        if (args.resource === "teams" && args.companyId !== undefined) {
          items = items.filter((item) => Number(item.companyId) === args.companyId);
        }
        if (args.resource === "employees" && args.companyId !== undefined) {
          items = items.filter((item) => Number(item.companyId) === args.companyId);
        }
        return outputResult(
          { resource: args.resource, count: items.length, items },
          sourceTool.path,
          result.status,
          result.contentType,
        );
      } catch (error) {
        return errorResult(error, "TingOp HR directory");
      }
    },
  );
  return true;
}

function registerTeamDailyTool(
  server: McpServer,
  tools: readonly ToolDefinition[],
  client: CxmApiClient,
): boolean {
  const sourceTool = findTool(tools, "/api/CheckIn/v2/team/{team_id}", "tingop-checkin");
  if (!sourceTool) return false;

  server.registerTool(
    TEAM_DAILY_TOOL_NAME,
    {
      title: "TingOp Check-in: Team daily summary",
      description:
        "Read-only team/day attendance summary. Reports present and missing check-ins and " +
        "flags late arrivals when the response contains both scheduled shift start and first check-in time.",
      inputSchema: teamDailyInputSchema,
      outputSchema: highLevelOutputSchema,
      annotations: {
        title: "TingOp Check-in: Team daily summary",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: {
        "hicas.vn/cxm-tag": "CheckIn",
        "hicas.vn/cxm-method": "GET",
        "hicas.vn/cxm-path": sourceTool.path,
        "hicas.vn/cxm-safety": "read-only",
        "hicas.vn/upstream": "tingop-checkin",
        "hicas.vn/composite": "team-daily-attendance",
      },
    },
    async (rawArgs): Promise<CallToolResult> => {
      const args = teamDailyInputSchema.parse(rawArgs);
      try {
        const result = await client.call(sourceTool, {
          teamId: args.teamId,
          workingDay: args.workingDay,
        });
        const summary = summarizeTeamDaily(
          result.data,
          args.teamId,
          args.workingDay,
          args.lateGraceMinutes,
          args.includeRaw,
        );
        return outputResult(summary, sourceTool.path, result.status, result.contentType);
      } catch (error) {
        return errorResult(error, sourceTool.path);
      }
    },
  );
  return true;
}

export function getHrToolCount(tools: readonly ToolDefinition[]): number {
  let count = 0;
  if (
    findTool(tools, "/api/Employee", "tingop") &&
    findTool(tools, "/api/Project", "tingop") &&
    findTool(tools, "/api/Team", "tingop")
  ) {
    count += 1;
  }
  if (findTool(tools, "/api/CheckIn/v2/team/{team_id}", "tingop-checkin")) count += 1;
  return count;
}

export function registerHrTools(
  server: McpServer,
  tools: readonly ToolDefinition[],
  client: CxmApiClient,
): void {
  registerDirectoryTool(server, tools, client);
  registerTeamDailyTool(server, tools, client);
}
