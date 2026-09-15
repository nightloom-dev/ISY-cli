import { appendFile, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { isyHome, pendingAlertPath } from "./paths.js";

/**
 * One line to the developer that had nowhere to go at the moment it happened.
 *
 * Three things produce such a line: Kimi and Codex discard hook stdout on their
 * lifecycle events, and a sweep runs detached from any CLI at all — nobody is
 * watching its stdout. A parked line is shown at the next SessionStart, which
 * is the next time this developer is looking at a CLI rather than mid-thought.
 *
 * Never throws: an alert is not worth breaking a session over.
 */
export async function parkAlert(message: string): Promise<void> {
  try {
    await mkdir(isyHome(), { recursive: true, mode: 0o700 });
    await appendFile(pendingAlertPath(), `${message}\n`);
  } catch {
    return;
  }
}

/**
 * The parked lines, taken rather than read: the file is renamed first, so a
 * park landing between the read and the truncate is not lost — it creates a
 * fresh file the next drain picks up. Two CLIs starting at once means one of
 * them wins the rename and shows the backlog; neither shows it twice.
 *
 * A claim that cannot then be read is put back. Stranding it would lose every
 * line in it silently, and a `.claimed-<pid>` nobody reads is not a backlog,
 * it is litter.
 */
export async function drainAlerts(): Promise<string> {
  const claimed = `${pendingAlertPath()}.claimed-${process.pid}`;
  try {
    await rename(pendingAlertPath(), claimed);
  } catch {
    return "";
  }

  let parked: string;
  try {
    parked = await readFile(claimed, "utf8");
  } catch {
    try {
      await rename(claimed, pendingAlertPath());
    } catch {
      // Nothing left to try; the alert is gone either way.
    }
    return "";
  }

  // Already read, so a failed unlink costs nothing but the file: the next drain
  // from this pid renames over it.
  try {
    await unlink(claimed);
  } catch {
    // See above.
  }

  return parked.trim();
}

/** What to show now, with anything parked earlier ahead of it. */
export async function withParkedAlerts(message: string): Promise<string> {
  const parked = await drainAlerts();
  return [parked, message].filter((part) => part.length > 0).join("\n");
}
