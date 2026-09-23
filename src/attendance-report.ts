import type { JsonValue } from "./cxm-client.js";

type JsonObject = { [key: string]: JsonValue };

interface ReportRow {
  row: JsonObject;
  dateBucket?: string;
}

interface EmployeeAggregate {
  employeeId: JsonValue;
  employeeCode: JsonValue;
  employeeName: JsonValue;
  days: number;
  daysWithHours: number;
  daysApproved: number;
  workedMinutes: number;
  approvedMinutes: number;
  unapprovedMinutes: number;
  sortName: string;
}

interface DateAggregate {
  date: string;
  employeeCount: number;
  employeesWithHours: number;
  workedMinutes: number;
  approvedMinutes: number;
  employeeKeys: Set<string>;
}

export interface AttendanceReportOptions {
  includeDailyRows?: boolean;
  maxEmployees?: number;
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function minutesFromTimeSpan(value: JsonValue | undefined): number | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  const totalMinutes = asNumber(object.totalMinutes);
  if (totalMinutes !== undefined) return totalMinutes;
  const totalHours = asNumber(object.totalHours);
  if (totalHours !== undefined) return totalHours * 60;

  const days = asNumber(object.days);
  const hours = asNumber(object.hours);
  const minutes = asNumber(object.minutes);
  const seconds = asNumber(object.seconds);
  if (days === undefined && hours === undefined && minutes === undefined && seconds === undefined) {
    return undefined;
  }
  return (days ?? 0) * 24 * 60 + (hours ?? 0) * 60 + (minutes ?? 0) + (seconds ?? 0) / 60;
}

function minutesFromMap(value: JsonValue | undefined): number | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  let total = 0;
  let found = false;
  for (const child of Object.values(object)) {
    const minutes = asNumber(child) ?? minutesFromTimeSpan(child);
    if (minutes === undefined) continue;
    total += minutes;
    found = true;
  }
  return found ? total : undefined;
}

function rowsFromValue(value: JsonValue): ReportRow[] {
  if (Array.isArray(value)) {
    return value.flatMap((child) => {
      const row = asObject(child);
      return row ? [{ row }] : [];
    });
  }

  const object = asObject(value);
  if (!object) return [];
  const collectionKeys = new Set(["results", "items", "data", "result"]);
  const rows: ReportRow[] = [];
  for (const [key, child] of Object.entries(object)) {
    if (!Array.isArray(child)) continue;
    for (const item of child) {
      const row = asObject(item);
      if (row) rows.push({ row, ...(collectionKeys.has(key) ? {} : { dateBucket: key }) });
    }
  }
  return rows;
}

function reportDate(row: JsonObject, dateBucket: string | undefined): string {
  if (dateBucket) return dateBucket;
  const dateKey = row.date_Key;
  if (typeof dateKey === "string" || typeof dateKey === "number") return String(dateKey);
  return "unknown";
}

function employeeIdentity(row: JsonObject): string {
  for (const key of ["employeeId", "employeeCode", "face_Identity_Id", "employee_Name"]) {
    const value = row[key];
    if (typeof value === "string" || typeof value === "number") return `${key}:${value}`;
  }
  return "unknown";
}

function employeeValue(row: JsonObject, key: string): JsonValue {
  const value = row[key];
  return value === undefined ? null : value;
}

function workedMinutes(row: JsonObject): number {
  return minutesFromTimeSpan(row.day_Hours) ?? minutesFromMap(row.shift_Hours) ?? 0;
}

function approvedMinutes(row: JsonObject): number {
  const main = asNumber(row.totalApprovedMainShift);
  const overtime = asNumber(row.totalApprovedOTShift);
  if (main !== undefined || overtime !== undefined) return (main ?? 0) + (overtime ?? 0);
  return minutesFromTimeSpan(row.approved_Day_Hours) ?? minutesFromMap(row.approved_Shift_Hours) ?? 0;
}

export function summarizeAttendanceReport(
  data: JsonValue,
  options: AttendanceReportOptions = {},
): JsonObject {
  const rows = rowsFromValue(data);
  const employees = new Map<string, EmployeeAggregate>();
  const dates = new Map<string, DateAggregate>();

  for (const { row, dateBucket } of rows) {
    const employeeKey = employeeIdentity(row);
    const worked = workedMinutes(row);
    const approved = approvedMinutes(row);
    const date = reportDate(row, dateBucket);
    const current: EmployeeAggregate = employees.get(employeeKey) ?? {
      employeeId: employeeValue(row, "employeeId"),
      employeeCode: employeeValue(row, "employeeCode"),
      employeeName: employeeValue(row, "employee_Name"),
      days: 0,
      daysWithHours: 0,
      daysApproved: 0,
      workedMinutes: 0,
      approvedMinutes: 0,
      unapprovedMinutes: 0,
      sortName: String(row.employee_Name ?? row.employeeCode ?? row.employeeId ?? employeeKey),
    };
    current.days = Number(current.days) + 1;
    if (worked > 0 || approved > 0) current.daysWithHours = Number(current.daysWithHours) + 1;
    if (approved > 0) current.daysApproved = Number(current.daysApproved) + 1;
    current.workedMinutes = Number(current.workedMinutes) + worked;
    current.approvedMinutes = Number(current.approvedMinutes) + approved;
    current.unapprovedMinutes = Math.max(
      0,
      Number(current.unapprovedMinutes) + Math.max(worked - approved, 0),
    );
    employees.set(employeeKey, current);

    const dateSummary: DateAggregate = dates.get(date) ?? {
      date,
      employeeCount: 0,
      employeesWithHours: 0,
      workedMinutes: 0,
      approvedMinutes: 0,
      employeeKeys: new Set<string>(),
    };
    if (!dateSummary.employeeKeys.has(employeeKey)) {
      dateSummary.employeeKeys.add(employeeKey);
      dateSummary.employeeCount = Number(dateSummary.employeeCount) + 1;
      if (worked > 0 || approved > 0) {
        dateSummary.employeesWithHours = Number(dateSummary.employeesWithHours) + 1;
      }
    }
    dateSummary.workedMinutes = Number(dateSummary.workedMinutes) + worked;
    dateSummary.approvedMinutes = Number(dateSummary.approvedMinutes) + approved;
    dates.set(date, dateSummary);
  }

  const maxEmployees = Math.max(1, Math.min(options.maxEmployees ?? 100, 500));
  const employeeAggregates = [...employees.values()]
    .sort((left, right) => left.sortName.localeCompare(right.sortName))
  const employeeSummaries: JsonObject[] = employeeAggregates.map(
    ({ sortName: _sortName, ...summary }) => summary,
  );
  const dailySummaries: JsonObject[] = [...dates.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map(({ employeeKeys: _employeeKeys, ...summary }) => summary);
  const output: JsonObject = {
    totalRows: rows.length,
    totalDates: dates.size,
    employeeCount: employees.size,
    returnedEmployeeCount: Math.min(employeeSummaries.length, maxEmployees),
    omittedEmployeeCount: Math.max(employeeSummaries.length - maxEmployees, 0),
    totalWorkedMinutes: employeeAggregates.reduce(
      (total, employee) => total + Number(employee.workedMinutes),
      0,
    ),
    totalApprovedMinutes: employeeAggregates.reduce(
      (total, employee) => total + Number(employee.approvedMinutes),
      0,
    ),
    employees: employeeSummaries.slice(0, maxEmployees),
    byDate: dailySummaries,
  };

  if (options.includeDailyRows) {
    output.dailyRows = rows.map(({ row, dateBucket }) => ({
      ...row,
      ...(dateBucket ? { dateBucket } : {}),
      workedMinutes: workedMinutes(row),
      approvedMinutes: approvedMinutes(row),
    }));
  }
  return output;
}
