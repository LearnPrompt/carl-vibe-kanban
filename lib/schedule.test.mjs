import test from "node:test";
import assert from "node:assert/strict";

import {
  LABEL,
  REFRESH_COMMAND,
  isValidTime,
  parseTime,
  buildPlist,
  buildPlistForTimes,
  parseTimesFromPlist,
  buildCrontabLine,
} from "./schedule.mjs";

test("isValidTime accepts HH:MM and rejects garbage", () => {
  assert.equal(isValidTime("09:00"), true);
  assert.equal(isValidTime("21:45"), true);
  assert.equal(isValidTime("23:59"), true);
  assert.equal(isValidTime("00:00"), true);
  assert.equal(isValidTime("24:00"), false);
  assert.equal(isValidTime("9:00"), false);
  assert.equal(isValidTime("09:60"), false);
  assert.equal(isValidTime("not-a-time"), false);
  assert.equal(isValidTime(""), false);
  assert.equal(isValidTime(undefined), false);
});

test("parseTime splits HH:MM into numbers", () => {
  assert.deepEqual(parseTime("09:30"), { hour: 9, minute: 30 });
  assert.deepEqual(parseTime("21:00"), { hour: 21, minute: 0 });
});

test("buildPlistForTimes produces well-formed XML with StartCalendarInterval per time", () => {
  const xml = buildPlistForTimes({
    label: LABEL,
    times: ["09:00", "21:00"],
    nodeBinDir: "/usr/local/bin",
    home: "/Users/carl",
    user: "carl",
    logPath: "/Users/carl/.cache/board/refresh.log",
  });

  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.carl-vibe-kanban\.refresh<\/string>/);
  assert.match(xml, /<string>\/bin\/zsh<\/string>/);
  assert.match(xml, /<string>-lc<\/string>/);
  // The command string is XML-escaped in place (&& -> &amp;&amp;) since it
  // sits inside a <string> element.
  assert.ok(xml.includes(REFRESH_COMMAND.replace(/&/g, "&amp;")));
  assert.ok(xml.includes("board sync --all &amp;&amp; board commit --all --push &amp;&amp; board render --all"));

  // Two StartCalendarInterval dicts, one per --at time.
  const dictMatches = xml.match(/<key>Hour<\/key>/g) || [];
  assert.equal(dictMatches.length, 2);
  assert.match(xml, /<key>Hour<\/key><integer>9<\/integer>/);
  assert.match(xml, /<key>Minute<\/key><integer>0<\/integer>/);
  assert.match(xml, /<key>Hour<\/key><integer>21<\/integer>/);

  // PATH carries the node bin dir, npm-global/bin under home, and the fixed
  // Homebrew + system paths.
  assert.match(xml, /<key>PATH<\/key>/);
  assert.ok(xml.includes("/usr/local/bin:/Users/carl/.npm-global/bin:/opt/homebrew/bin:/usr/bin:/bin"));

  assert.match(xml, /<key>HOME<\/key>\s*<string>\/Users\/carl<\/string>/);
  assert.match(xml, /<key>USER<\/key>\s*<string>carl<\/string>/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Users\/carl\/\.cache\/board\/refresh\.log<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/carl\/\.cache\/board\/refresh\.log<\/string>/);
});

test("buildPlist accepts a single time and still produces valid XML", () => {
  const xml = buildPlist({
    label: LABEL,
    times: [{ hour: 6, minute: 15 }],
    nodeBinDir: "/opt/homebrew/bin",
    home: "/Users/carl",
    user: "carl",
    logPath: "/Users/carl/.cache/board/refresh.log",
  });
  const dictMatches = xml.match(/<key>Hour<\/key>/g) || [];
  assert.equal(dictMatches.length, 1);
  assert.match(xml, /<key>Hour<\/key><integer>6<\/integer>/);
  assert.match(xml, /<key>Minute<\/key><integer>15<\/integer>/);
});

test("parseTimesFromPlist round-trips what buildPlistForTimes wrote", () => {
  const xml = buildPlistForTimes({
    label: LABEL,
    times: ["09:00", "21:30"],
    nodeBinDir: "/usr/local/bin",
    home: "/Users/carl",
    user: "carl",
  });
  assert.deepEqual(parseTimesFromPlist(xml), ["09:00", "21:30"]);
});

test("parseTimesFromPlist returns empty array for unrelated XML", () => {
  assert.deepEqual(parseTimesFromPlist("<plist></plist>"), []);
  assert.deepEqual(parseTimesFromPlist(""), []);
});

test("buildCrontabLine formats a standard 5-field crontab line", () => {
  assert.equal(
    buildCrontabLine("09:00"),
    `0 9 * * * ${REFRESH_COMMAND}`
  );
  assert.equal(
    buildCrontabLine("21:45"),
    `45 21 * * * ${REFRESH_COMMAND}`
  );
});

test("buildPlist XML-escapes label/paths so special characters can't break the plist", () => {
  const xml = buildPlist({
    label: "com.test.<weird>&thing",
    times: [{ hour: 9, minute: 0 }],
    nodeBinDir: "/usr/local/bin",
    home: "/Users/carl",
    user: "carl",
  });
  assert.ok(xml.includes("com.test.&lt;weird&gt;&amp;thing"));
  assert.ok(!xml.includes("<weird>"));
});

test("plist asks launchd for Standard ProcessType so the job is not throttled", () => {
  const xml = buildPlistForTimes({
    times: ["09:00"],
    command: "board sync --all",
    path: "/usr/bin:/bin",
    home: "/Users/x",
    user: "x",
    log: "/Users/x/.cache/board/refresh.log",
  });
  assert.match(xml, /<key>ProcessType<\/key>\s*<string>Standard<\/string>/);
});
