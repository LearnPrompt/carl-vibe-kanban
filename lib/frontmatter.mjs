// Minimal, self-contained YAML-subset frontmatter parser/serializer.
// Supports: string / number / boolean / null scalars, and string arrays
// (inline `[a, b]` or block `- a` / `- b` style). No nesting, no multi-line
// scalars. Good enough for board task cards; not a general YAML parser.

const FRONTMATTER_DELIM = "---";

const RESERVED_SCALARS = new Set(["true", "false", "null", "~", ""]);

function isNumericLike(str) {
  return /^-?\d+(\.\d+)?$/.test(str);
}

function needsQuoting(str) {
  if (str === "") return true;
  if (RESERVED_SCALARS.has(str.toLowerCase())) return true;
  if (isNumericLike(str)) return true;
  if (/^[\s]|[\s]$/.test(str)) return true;
  if (/[\n]/.test(str)) return true;
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(str)) return true;
  if (/: /.test(str) || str.endsWith(":")) return true;
  if (str === FRONTMATTER_DELIM) return true;
  return false;
}

function quoteString(str) {
  // JSON.stringify produces a double-quoted, escaped string which is a
  // valid subset of YAML double-quoted scalars for our purposes.
  return JSON.stringify(str);
}

function serializeScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  const str = String(value);
  return needsQuoting(str) ? quoteString(str) : str;
}

function serializeStringArrayInline(arr) {
  return `[${arr.map((item) => serializeScalar(item)).join(", ")}]`;
}

export function stringifyFrontmatter(data, body = "") {
  const lines = [FRONTMATTER_DELIM];
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (Array.isArray(value)) {
      lines.push(`${key}: ${serializeStringArrayInline(value)}`);
    } else {
      lines.push(`${key}: ${serializeScalar(value)}`);
    }
  }
  lines.push(FRONTMATTER_DELIM);
  const header = lines.join("\n");
  const normalizedBody = body ?? "";
  if (normalizedBody === "") {
    return `${header}\n`;
  }
  return `${header}\n${normalizedBody}`;
}

function parseScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to raw string on malformed quoting
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  return trimmed;
}

function splitInlineArrayItems(inner) {
  const rawItems = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' && inner[i - 1] !== "\\") {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      rawItems.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  rawItems.push(current);
  return rawItems.map((item) => parseScalar(item.trim()));
}

function parseInlineArray(raw) {
  const trimmed = raw.trim();
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  return splitInlineArrayItems(inner);
}

export function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    return { data: {}, body: normalized };
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_DELIM) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { data: {}, body: normalized };
  }
  const headerLines = lines.slice(1, closeIdx);
  const bodyLines = lines.slice(closeIdx + 1);
  // Drop exactly one leading blank line after the closing delimiter, if any,
  // since stringifyFrontmatter always emits "---\n" then the body directly.
  let bodyStart = 0;
  if (bodyLines[0] === "") bodyStart = 1;
  const body = bodyLines.slice(bodyStart).join("\n");

  const data = {};
  for (let i = 0; i < headerLines.length; i++) {
    const line = headerLines[i];
    if (line.trim() === "") continue;
    const match = line.match(/^([A-Za-z0-9_]+):(.*)$/);
    if (!match) continue;
    const key = match[1];
    const rest = match[2];
    const restTrimmed = rest.trim();
    if (restTrimmed === "") {
      // possible block-style array on following lines: "  - item"
      const items = [];
      let j = i + 1;
      while (j < headerLines.length && /^\s*-\s?/.test(headerLines[j])) {
        const itemRaw = headerLines[j].replace(/^\s*-\s?/, "");
        items.push(parseScalar(itemRaw));
        j++;
      }
      if (items.length > 0) {
        data[key] = items;
        i = j - 1;
      } else {
        data[key] = null;
      }
    } else if (restTrimmed.startsWith("[")) {
      data[key] = parseInlineArray(restTrimmed);
    } else {
      data[key] = parseScalar(restTrimmed);
    }
  }

  return { data, body };
}
