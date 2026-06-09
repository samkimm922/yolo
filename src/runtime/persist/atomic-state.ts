import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function writeStateAtomic(path: string, data: unknown): void {
  // 1. backup current as .bak
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  // 2. write tmp + fsync
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  // 3. atomic rename
  renameSync(tmp, path);
}

export function readStateWithFallback<T = unknown>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    const bak = `${path}.bak`;
    if (existsSync(bak)) return JSON.parse(readFileSync(bak, "utf8")) as T;
    throw new Error(`State file ${path} is corrupt and no valid backup exists`);
  }
}
