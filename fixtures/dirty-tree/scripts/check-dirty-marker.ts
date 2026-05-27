import { existsSync, readFileSync } from "node:fs";

if (!existsSync("local/unsaved-note.txt")) {
  throw new Error("dirty marker missing");
}

const value = readFileSync("src/index.ts", "utf8");
if (!value.includes("stable")) {
  throw new Error("expected stable source marker");
}

console.log("dirty marker preserved");
