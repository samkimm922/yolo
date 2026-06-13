export function getArg(prefix) {
  const a = process.argv.find(a => a.startsWith(prefix));
  if (!a) return null;
  return a.slice(prefix.length) || null;
}

export function hasFlag(flag) {
  return process.argv.includes(flag);
}
