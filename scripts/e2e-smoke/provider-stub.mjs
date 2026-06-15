#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (process.env.YOLO_PROVIDER_STUB_FAIL === "1") {
    process.stderr.write("YOLO provider stub forced failure\n");
    process.exit(42);
  }

  const target = process.env.YOLO_PROVIDER_STUB_TARGET || "components/ExternalSmokeBadge.tsx";
  const path = join(process.cwd(), target);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    "export type ExternalSmokeBadgeProps = {",
    "  label?: string;",
    "};",
    "",
    "export function ExternalSmokeBadge({ label = \"Packed external smoke ready\" }: ExternalSmokeBadgeProps): string {",
    "  return `External smoke: ${label}`;",
    "}",
    "",
    "export const externalSmokeBadgeMarker = \"YOLO_PACKED_EXTERNAL_SMOKE_MARKER\";",
    "",
  ].join("\n"), "utf8");

  process.stdout.write(`${JSON.stringify({
    status: "completed",
    provider: "stub",
    target,
    prompt_bytes: Buffer.byteLength(prompt, "utf8"),
  })}\n`);
});
