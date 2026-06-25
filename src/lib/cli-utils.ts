export function getArg(prefix: string): string | null {
  const a = process.argv.find((a) => a.startsWith(prefix));
  if (!a) return null;
  return a.slice(prefix.length) || null;
}

export function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}
