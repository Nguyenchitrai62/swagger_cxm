import assert from "node:assert/strict";
import test from "node:test";

import { summarizeAttendanceReport } from "../src/attendance-report.js";

test("attendance report summary aggregates worked and approved minutes by employee and date", () => {
  const summary = summarizeAttendanceReport({
    "2026-09-01": [
      {
        employeeId: 10,
        employeeCode: "E010",
        employee_Name: "Nguyen A",
        day_Hours: { totalMinutes: 480 },
        totalApprovedMainShift: 450,
        totalApprovedOTShift: 30,
        date_Key: 20260901,
      },
      {
        employeeId: 11,
        employeeCode: "E011",
        employee_Name: "Tran B",
        day_Hours: { totalMinutes: 0 },
        totalApprovedMainShift: 0,
        totalApprovedOTShift: 0,
        date_Key: 20260901,
      },
    ],
    "2026-09-02": [
      {
        employeeId: 10,
        employeeCode: "E010",
        employee_Name: "Nguyen A",
        day_Hours: { totalMinutes: 420 },
        approved_Day_Hours: { totalMinutes: 390 },
        date_Key: 20260902,
      },
    ],
  });

  assert.equal(summary.totalRows, 3);
  assert.equal(summary.totalDates, 2);
  assert.equal(summary.employeeCount, 2);
  assert.equal(summary.totalWorkedMinutes, 900);
  assert.equal(summary.totalApprovedMinutes, 870);
  assert.deepEqual(summary.employees, [
    {
      employeeId: 10,
      employeeCode: "E010",
      employeeName: "Nguyen A",
      days: 2,
      daysWithHours: 2,
      daysApproved: 2,
      workedMinutes: 900,
      approvedMinutes: 870,
      unapprovedMinutes: 30,
    },
    {
      employeeId: 11,
      employeeCode: "E011",
      employeeName: "Tran B",
      days: 1,
      daysWithHours: 0,
      daysApproved: 0,
      workedMinutes: 0,
      approvedMinutes: 0,
      unapprovedMinutes: 0,
    },
  ]);
  assert.deepEqual(summary.byDate, [
    {
      date: "2026-09-01",
      employeeCount: 2,
      employeesWithHours: 1,
      workedMinutes: 480,
      approvedMinutes: 480,
    },
    {
      date: "2026-09-02",
      employeeCount: 1,
      employeesWithHours: 1,
      workedMinutes: 420,
      approvedMinutes: 390,
    },
  ]);
});

test("attendance report can include bounded daily rows", () => {
  const summary = summarizeAttendanceReport(
    {
      "2026-09-01": [
        {
          employeeId: 10,
          day_Hours: { totalMinutes: 60 },
          totalApprovedMainShift: 60,
          totalApprovedOTShift: 0,
        },
      ],
    },
    { includeDailyRows: true, maxEmployees: 1 },
  );

  assert.ok(Array.isArray(summary.dailyRows));
  assert.equal((summary.dailyRows as Array<Record<string, unknown>>)[0]?.dateBucket, "2026-09-01");
  assert.equal((summary.dailyRows as Array<Record<string, unknown>>)[0]?.workedMinutes, 60);
});
