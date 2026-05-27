import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(sourceRoot, "dist");

function copyIfExists(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function writeRuntimePackageJson(): void {
  const packageJson = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  const runtimePackageJson = {
    ...packageJson,
    main: "./sdk.js",
    types: "./sdk.d.ts",
    exports: Object.fromEntries(
      Object.entries(packageJson.exports || {}).map(([name, target]) => [
        name,
        String(target).replace(/^\.\/dist\//, "./"),
      ]),
    ),
    bin: Object.fromEntries(
      Object.entries(packageJson.bin || {}).map(([name, target]) => [
        name,
        String(target).replace(/^\.\/dist\//, "./"),
      ]),
    ),
  };
  writeFileSync(join(distRoot, "package.json"), `${JSON.stringify(runtimePackageJson, null, 2)}\n`, "utf8");
}

function writeRuntimeApiBoundary(): void {
  const boundaryPath = join(distRoot, "docs", "public-sdk-api-boundary.json");
  if (!existsSync(boundaryPath)) return;
  const boundary = JSON.parse(readFileSync(boundaryPath, "utf8"));
  for (const entry of boundary.package_exports || []) {
    if (typeof entry.target === "string") {
      entry.target = entry.target.replace(/^\.\/dist\//, "./");
    }
  }
  writeFileSync(boundaryPath, `${JSON.stringify(boundary, null, 2)}\n`, "utf8");
}

function prunePythonCaches(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory() && entry === "__pycache__") {
      rmSync(fullPath, { recursive: true, force: true });
      continue;
    }
    if (stat.isDirectory()) {
      prunePythonCaches(fullPath);
    }
  }
}

mkdirSync(distRoot, { recursive: true });

for (const path of ["docs", "schemas", "fixtures"]) {
  rmSync(join(distRoot, path), { recursive: true, force: true });
  copyIfExists(join(sourceRoot, path), join(distRoot, path));
}

for (const file of ["README.md", "CHANGELOG.md", "config.yaml", "config.example.yaml", "settings-minimal.json"]) {
  copyIfExists(join(sourceRoot, file), join(distRoot, file));
}

writeRuntimePackageJson();
writeRuntimeApiBoundary();
prunePythonCaches(join(distRoot, "fixtures"));
