import path from "node:path";

/** `./rel/path` for paths under `cwd`, otherwise a relative or absolute path. */
export function displayPath(target: string, cwd = process.cwd()): string {
  const rel = path.relative(cwd, target);
  if (rel === "") return ".";
  if (path.isAbsolute(rel)) return target;
  if (rel.startsWith("..")) return rel.split(path.sep).join("/");
  return `./${rel.split(path.sep).join("/")}`;
}
