export function status() {
  return "ok";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(status());
}
