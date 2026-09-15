import { DEFAULT_API_BASE_URL, fetchNotes } from "../api.js";
import type { NotesResponse } from "../api.js";
import { readConfig } from "../config.js";
import { collectGitMetadata } from "../git.js";

/** Why the repository could not be identified, in the terms the user can act on. */
const GIT_HINTS = {
  "not-a-repository": "not a git repository — run isy notes inside the checkout",
  "no-commits": "this repository has no commits yet",
  "no-remote": "no origin remote — ISY identifies a pull request by its repository",
} as const;

/**
 * The published link for the run, the same one the pull request comment carries
 * (`report.ts:reportLink`). `/r/:id` is served by the API, which redirects to
 * the web app, so the client never has to know the front-end's address.
 */
function reportUrl(baseUrl: string, analysisId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/r/${analysisId}`;
}

/**
 * The notes, ready to paste. The header is the only line added: each prompt
 * already opens with its file, severity and confidence, so repeating them
 * above it would only cost the reader a line before the part they hand over.
 */
export function formatNotes(data: NotesResponse, baseUrl: string): string {
  const where = `${data.repo}#${data.prNumber}${data.branch ? ` · ${data.branch}` : ""}`;
  const count = data.notes.length === 0 ? "no notes" : `${data.notes.length} note${data.notes.length === 1 ? "" : "s"}`;
  const header = `${where} · ${count} · ${reportUrl(baseUrl, data.analysisId)}`;

  if (data.notes.length === 0) return header;
  return [header, "", data.notes.map((note) => note.prompt).join("\n\n---\n\n")].join("\n");
}

export async function runNotes(
  options: { json?: boolean; pr?: number },
  cwd: string,
): Promise<void> {
  const config = await readConfig();
  const token = typeof config.token === "string" && config.token.length > 0 ? config.token : undefined;
  if (!token) throw new Error("not configured — run: isy init");

  const git = await collectGitMetadata(cwd);
  if (!git.ok) throw new Error(GIT_HINTS[git.reason]);

  const baseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const data = await fetchNotes({
    baseUrl,
    token,
    repo: git.metadata.remote,
    branch: git.metadata.branch,
    pr: options.pr,
  });

  console.log(options.json ? JSON.stringify(data, null, 2) : formatNotes(data, baseUrl));
}
