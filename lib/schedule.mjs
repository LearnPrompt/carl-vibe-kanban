// `board schedule` — periodic `board sync --all && board commit --all --push
// && board render --all` via a macOS gui-domain LaunchAgent. Deliberately
// NOT cron: cron can't read the login keychain, so `gh`/`claude` silently
// lose auth under it (see obsidian/.../goodcase-cron-keychain-launchd.md).
//
// Everything that shells out to `launchctl` lives in bin/board.mjs; this
// module only builds the plist/crontab text (pure, given explicit inputs)
// and the few path constants — per spec, tests cover plist generation only,
// never launchctl itself.
import path from "node:path";
import os from "node:os";

export const LABEL = "com.carl-vibe-kanban.refresh";
export const REFRESH_COMMAND = "board sync --all && board commit --all --push && board render --all";

export function plistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function defaultLogPath() {
  return path.join(os.homedir(), ".cache", "board", "refresh.log");
}

export function isValidTime(t) {
  return typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

// Pure: "HH:MM" -> {hour, minute} as numbers. Caller must validate with
// isValidTime first (returns {hour: NaN, minute: NaN} on garbage input
// rather than throwing, so a caller that forgets to validate gets an
// obviously-wrong plist instead of a crash).
export function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || "");
  if (!m) return { hour: NaN, minute: NaN };
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Pure: builds the full plist XML text. `times` is an array of "HH:MM"
// strings (StartCalendarInterval fires once per entry — that's how a
// LaunchAgent gets "twice a day" instead of a single interval). `home`/`user`
// are passed in explicitly (not read from `os` here) so this stays a pure
// function of its inputs, per the spec's "纯函数，给定时刻与路径输出 XML".
export function buildPlist({
  label = LABEL,
  times,
  nodeBinDir,
  home,
  user,
  logPath = defaultLogPath(),
  npmGlobalBinDir,
} = {}) {
  const resolvedNpmGlobalBinDir = npmGlobalBinDir || path.join(home || "", ".npm-global", "bin");
  const pathEntries = [nodeBinDir, resolvedNpmGlobalBinDir, "/opt/homebrew/bin", "/usr/bin:/bin"].filter(Boolean);
  const pathValue = pathEntries.join(":");

  const intervalDicts = times
    .map(({ hour, minute }) =>
      [
        "\t\t<dict>",
        `\t\t\t<key>Hour</key><integer>${hour}</integer>`,
        `\t\t\t<key>Minute</key><integer>${minute}</integer>`,
        "\t\t</dict>",
      ].join("\n")
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/zsh</string>
\t\t<string>-lc</string>
\t\t<string>${xmlEscape(REFRESH_COMMAND)}</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${xmlEscape(pathValue)}</string>
\t\t<key>HOME</key>
\t\t<string>${xmlEscape(home || "")}</string>
\t\t<key>USER</key>
\t\t<string>${xmlEscape(user || "")}</string>
\t</dict>
\t<key>StartCalendarInterval</key>
\t<array>
${intervalDicts}
\t</array>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

// Convenience wrapper: accepts "HH:MM" strings directly (what the CLI parses
// from --at) instead of pre-parsed {hour, minute} objects.
export function buildPlistForTimes(opts) {
  const times = (opts.times || []).map(parseTime);
  return buildPlist({ ...opts, times });
}

// Pure: extracts every {Hour, Minute} pair from a StartCalendarInterval
// array in already-generated plist XML, formatted back as "HH:MM" strings —
// used by `board schedule status` to report what's actually installed
// without re-deriving it from CLI flags.
export function parseTimesFromPlist(xml) {
  const out = [];
  const dictRe = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g;
  let m;
  while ((m = dictRe.exec(xml || "")) !== null) {
    const h = String(m[1]).padStart(2, "0");
    const mi = String(m[2]).padStart(2, "0");
    out.push(`${h}:${mi}`);
  }
  return out;
}

// Non-macOS fallback: the equivalent crontab line (printed only, never
// installed — cron can't read the keychain, see module header).
export function buildCrontabLine(time) {
  const { hour, minute } = parseTime(time);
  return `${minute} ${hour} * * * ${REFRESH_COMMAND}`;
}
