import { existsSync, readFileSync } from "node:fs";

if (!existsSync("state/baseline/test-failures.txt")) {
  throw new Error("baseline failure record missing");
}

const baseline = readFileSync("state/baseline/test-failures.txt", "utf8");
if (!baseline.includes("legacy-failure.test.ts")) {
  throw new Error("expected legacy failure marker");
}

console.log("known baseline failure recorded");
