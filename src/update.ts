import { sep } from "node:path";

/**
 * Whether the server's client version is ahead of this one.
 *
 * ponytail: numeric dot-compare, no semver parsing — pre-release tags and build
 * metadata compare as "not newer" rather than wrongly. Pull in a semver library
 * the day the CLI actually ships tagged builds.
 */
export function isNewer(latest: string | undefined, current: string): boolean {
  if (!latest || latest === current) return false;

  const parse = (value: string): number[] | undefined => {
    const parts = value.split(".");
    if (parts.length !== 3) return undefined;
    const numbers = parts.map((part) => Number(part));
    return numbers.every((n) => Number.isInteger(n) && n >= 0) ? numbers : undefined;
  };

  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;

  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

/**
 * How this install updates itself. A package under node_modules came from a
 * package manager; anything else is a source checkout, where pulling and
 * rebuilding is the only honest answer — and where `npm install -g` would
 * quietly replace the checkout the developer is working in.
 */
export function updateCommand(dir: string = import.meta.dirname): string {
  return dir.includes(`${sep}node_modules${sep}`)
    ? "npm install -g @nightloom/isy@latest"
    : "git pull && npm install && npm run build";
}

/** The one line the user sees when their client is behind. */
export function updateNotice(latest: string | undefined, current: string): string | undefined {
  if (!isNewer(latest, current)) return undefined;
  return `isy ${latest} is available (you have ${current}) — update: ${updateCommand()}`;
}
