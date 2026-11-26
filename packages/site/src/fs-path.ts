import * as native from "node:path";
import { posix, win32 } from "node:path";

/** Disk paths are slash-normalized, but must retain their filesystem's roots. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[/\\]{2}[^/\\]+[/\\]+[^/\\]+/.test(path);
}

function implementation(paths: readonly string[]): typeof posix {
  if (paths.some(isWindowsPath)) return win32;
  // Explicit POSIX paths are also used by config validation on Windows.
  if (paths.some((path) => posix.isAbsolute(path))) return posix;
  return native;
}

export const filesystemPath = {
  resolve(...paths: string[]): string {
    // Unlike normalize, resolve addresses the host filesystem. On Windows,
    // /dist and \dist need a drive/share before hashing, locking, or recovery.
    const disk = paths.some(isWindowsPath) ? win32 : native;
    return toPosix(disk.resolve(...paths.map(toPosix)));
  },
  join(...paths: string[]): string {
    return toPosix(implementation(paths).join(...paths.map(toPosix)));
  },
  dirname(path: string): string {
    return toPosix(implementation([path]).dirname(toPosix(path)));
  },
  basename(path: string): string {
    return implementation([path]).basename(toPosix(path));
  },
  normalize(path: string): string {
    return toPosix(implementation([path]).normalize(toPosix(path)));
  },
  relative(from: string, to: string): string {
    return toPosix(implementation([from, to]).relative(toPosix(from), toPosix(to)));
  },
  isAbsolute(path: string): boolean {
    return posix.isAbsolute(toPosix(path)) || isWindowsPath(path);
  },
};

/** Component-aware, including Windows drive/case semantics; not a string prefix. */
export function pathContains(outer: string, inner: string): boolean {
  const relative = filesystemPath.relative(outer, inner);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith("../") && !filesystemPath.isAbsolute(relative))
  );
}
