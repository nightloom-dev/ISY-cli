import { createReadStream } from "node:fs";

/**
 * A file's lines, split on "\n" alone, a trailing "\r" dropped. `node:readline`
 * also ends a line at U+2028 and U+2029, which `JSON.stringify` leaves
 * unescaped inside strings: a JSONL record carrying one came apart into two
 * fragments that neither parsed nor had their secrets redacted by key. Breaking
 * out of the loop closes the file.
 */
export async function* fileLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  let rest = "";
  try {
    for await (const chunk of input as AsyncIterable<string>) {
      let from = 0;
      for (let at = chunk.indexOf("\n"); at !== -1; at = chunk.indexOf("\n", from)) {
        yield withoutCr(rest + chunk.slice(from, at));
        rest = "";
        from = at + 1;
      }
      rest += chunk.slice(from);
    }
    if (rest.length > 0) yield withoutCr(rest);
  } finally {
    input.destroy();
  }
}

function withoutCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
