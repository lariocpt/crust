// One item, one line — shared by stdout printing and shell-stage stdin.
export function formatItem(x: unknown): string {
  if (x instanceof Response) {
    return `${x.status} ${x.statusText} ${x.url}`;
  }
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
