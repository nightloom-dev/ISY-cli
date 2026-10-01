"""Drive an interactive CLI through a pseudo-terminal, for e2e/live.mjs.

Node has no PTY in its standard library, Python does. Usage:

    pty-drive.py <steps.json> -- <command> [args...]

steps.json is a list of steps, run in order:
    {"wait": "<regex>", "timeout": 60}   until the screen text (ANSI stripped) matches, after the last mark
    {"send": "<text>"}                    write to the terminal; "\\r" is Enter
    {"sleep": 1.5}
    {"mark": "<name>"}                    record the time and move the "after" point for the next wait
    {"waitExit": 30}                      until the process exits
    {"snap": "<name>"}                    keep the screen text since the last mark, for the report

Prints one JSON object: {"ok", "failedStep", "marks": {name: seconds since start}, "exitCode", "screen"}.
The screen is read coarsely, as text: good enough to see a prompt come back, not to render the UI.
"""

import json
import os
import pty
import re
import select
import signal
import sys
import time

CURSOR_FORWARD = re.compile(rb"\x1b\[(\d*)C")
ANSI = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78NOM]|[\x00-\x08\x0e-\x1f]")


def main() -> None:
    split = sys.argv.index("--")
    steps = json.load(open(sys.argv[1]))
    command = sys.argv[split + 1 :]

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(command[0], command)

    # A wide terminal: the TUI wraps long lines, and a wrapped prompt does not match.
    import fcntl
    import struct
    import termios

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))

    start = time.monotonic()
    raw = bytearray()
    after = 0  # offset into the cleaned text a wait starts looking from
    marks: dict[str, float] = {}
    snaps: dict[str, str] = {}
    mark_at = 0  # where the text stood at the last mark
    exit_code = None

    def pump(timeout: float) -> bool:
        """Read what is there; False once the child is gone."""
        nonlocal exit_code
        ready, _, _ = select.select([fd], [], [], timeout)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if chunk:
                raw.extend(chunk)
                # Answer the terminal queries a TUI makes on start, or it waits for them.
                if b"\x1b[6n" in chunk:
                    os.write(fd, b"\x1b[1;1R")
                if b"\x1b[c" in chunk or b"\x1b[0c" in chunk:
                    os.write(fd, b"\x1b[?62;22c")
                return True
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            exit_code = os.waitstatus_to_exitcode(status)
            return False
        return True

    def text() -> str:
        # The TUI moves the cursor instead of printing spaces; put them back first.
        spaced = CURSOR_FORWARD.sub(lambda m: b" " * int(m.group(1) or 1), bytes(raw))
        return ANSI.sub(b"", spaced).decode("utf-8", "replace")

    failed = None
    for index, step in enumerate(steps):
        if "wait" in step:
            pattern = re.compile(step["wait"])
            deadline = time.monotonic() + step.get("timeout", 60)
            while not pattern.search(text(), after):
                if time.monotonic() > deadline or not pump(0.2):
                    if not pattern.search(text(), after):
                        failed = index
                    break
            if failed is not None:
                break
            match = pattern.search(text(), after)
            after = match.end() if match else after
        elif "send" in step:
            os.write(fd, step["send"].encode())
        elif "sleep" in step:
            deadline = time.monotonic() + step["sleep"]
            while time.monotonic() < deadline and pump(0.05):
                pass
        elif "mark" in step:
            marks[step["mark"]] = round(time.monotonic() - start, 3)
            after = mark_at = len(text())
        elif "snap" in step:
            snaps[step["snap"]] = text()[mark_at:][-6000:]
        elif "waitExit" in step:
            deadline = time.monotonic() + step["waitExit"]
            while exit_code is None and time.monotonic() < deadline:
                pump(0.1)
            if exit_code is None:
                failed = index
                break
            marks.setdefault("exited", round(time.monotonic() - start, 3))

    if exit_code is None:
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(1)
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass

    print(json.dumps({"ok": failed is None, "failedStep": failed, "marks": marks, "snaps": snaps, "exitCode": exit_code, "screen": text()[-20000:]}))


if __name__ == "__main__":
    main()
