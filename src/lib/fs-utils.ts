import { readFileSync, existsSync } from "node:fs";

export function readJSON(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function readFileSafe(filePath, maxLines = 300) {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    if (lines.length > maxLines) return lines.slice(0, maxLines).join("\n") + `\n// ... (${lines.length - maxLines} more lines)`;
    return content;
  } catch {
    return null;
  }
}
