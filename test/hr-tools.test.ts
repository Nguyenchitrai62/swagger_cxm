import assert from "node:assert/strict";
import test from "node:test";

import { summarizeTeamDaily } from "../src/hr-tools.js";

test("team daily summary identifies missing and late employees from shift times", () => {
  const summary = summarizeTeamDaily(
    {
      inSide_Team: [
        {
          employeeId: 1,
          employeeCode: "E001",
          name: "Late Person",
          shift_CheckIn_Option: [{ id: 10, startTime: "08:00:00" }],
          shift_CheckIn_List: {
            "10": [{ id: 100, timeStamp: "2026-09-15T08:12:00+07:00" }],
          },
        },
        {
          employeeId: 2,
          employeeCode: "E002",
          name: "Missing Person",
          shift_CheckIn_Option: [{ id: 10, startTime: "08:00:00" }],
          shift_CheckIn_List: {},
        },
      ],
      outSide_Team: [
        {
          employeeId: 3,
          name: "Outside Person",
          checkIn_List: [{ id: 200, timeStamp: "2026-09-15T07:55:00+07:00" }],
        },
      ],
    },
    99,
    "2026-09-15",
    5,
  );

  assert.equal(summary.teamId, 99);
  assert.equal(summary.insideTeamCount, 2);
  assert.equal(summary.outsideTeamCount, 1);
  assert.equal(summary.checkedInCount, 2);
  assert.equal(summary.missingCheckInCount, 1);
  assert.equal(summary.lateCount, 1);
  assert.deepEqual(summary.latePeople, [
    {
      employeeId: 1,
      employeeCode: "E001",
      employeeName: "Late Person",
      shiftId: 10,
      scheduledStart: "08:00:00",
      firstCheckIn: "2026-09-15T08:12:00+07:00",
      lateMinutes: 12,
    },
  ]);
});
