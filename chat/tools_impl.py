"""
MontageDev Tool Implementations
Python side of: BashTool, FileReadTool, FileWriteTool, FileEditTool,
GlobTool, GrepTool, TodoWriteTool, web_search (via web_search.py)
"""
import fnmatch
import glob as glob_module
import os
import re
import subprocess
import tempfile
from pathlib import Path

from .web_search import search_web

# Each session gets a workspace dir under /tmp
WORKSPACE_BASE = "/tmp/montagedev_workspaces"
DEFAULT_WORKSPACE = "/tmp/montagedev_ws"
MAX_OUTPUT = 8_000   # chars, to avoid flooding context
BASH_TIMEOUT = 30    # seconds


def _ensure_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path


def _workspace(conversation_id: str | None = None) -> str:
    if conversation_id:
        d = os.path.join(WORKSPACE_BASE, str(conversation_id)[:8])
    else:
        d = DEFAULT_WORKSPACE
    return _ensure_dir(d)


def _truncate(text: str, limit: int = MAX_OUTPUT) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + f"\n\n... [truncated {len(text)-limit} chars] ...\n\n" + text[-half:]


# ─── Bash ─────────────────────────────────────────────────────────────────────

def run_bash(command: str, cwd: str | None = None) -> str:
    """Execute a bash command. Returns stdout+stderr combined."""
    work_dir = cwd or DEFAULT_WORKSPACE
    _ensure_dir(work_dir)
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=BASH_TIMEOUT,
        )
        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            output += ("\n" if output else "") + result.stderr
        if result.returncode != 0 and not output:
            output = f"[exited with code {result.returncode}]"
        return _truncate(output.strip() or "[no output]")
    except subprocess.TimeoutExpired:
        return f"[command timed out after {BASH_TIMEOUT}s]"
    except Exception as e:
        return f"[bash error: {e}]"


# ─── File Read ────────────────────────────────────────────────────────────────

def read_file(file_path: str, line_start: int | None = None, line_end: int | None = None) -> str:
    """Read a file with line numbers (cat -n format). Max 2000 lines."""
    MAX_LINES = 2000
    try:
        path = Path(file_path)
        if not path.exists():
            return f"[error: file not found: {file_path}]"
        if path.is_dir():
            return f"[error: {file_path} is a directory — use Bash with ls]"

        # Image check
        img_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"}
        if path.suffix.lower() in img_exts:
            size = path.stat().st_size
            return f"[image file: {file_path}, size: {size} bytes — image viewing not supported in this mode]"

        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()

        total = len(lines)
        start = max(0, (line_start or 1) - 1)
        end   = min(total, line_end or (start + MAX_LINES))

        if end - start > MAX_LINES:
            end = start + MAX_LINES
            truncated = True
        else:
            truncated = False

        numbered = "".join(
            f"{i+1}\t{line}" for i, line in enumerate(lines[start:end], start=start)
        )

        header = f"[{file_path}] ({total} lines total"
        if line_start or line_end:
            header += f", showing lines {start+1}–{end}"
        header += ")"
        if truncated:
            header += f" [truncated to {MAX_LINES} lines — use line_start/line_end for more]"

        return f"{header}\n{numbered}"
    except Exception as e:
        return f"[read error: {e}]"


# ─── File Write ───────────────────────────────────────────────────────────────

def write_file(file_path: str, content: str) -> str:
    """Write content to a file. Creates parent dirs as needed."""
    try:
        path = Path(file_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        lines = content.count("\n") + 1
        return f"[wrote {len(content)} bytes ({lines} lines) to {file_path}]"
    except Exception as e:
        return f"[write error: {e}]"


# ─── File Edit ────────────────────────────────────────────────────────────────

def edit_file(file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> str:
    """Exact string replacement in a file."""
    try:
        path = Path(file_path)
        if not path.exists():
            return f"[error: file not found: {file_path}]"
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()

        count = content.count(old_string)
        if count == 0:
            # Show nearby context to help debug
            snippet = repr(old_string[:80]) + ("..." if len(old_string) > 80 else "")
            return f"[edit failed: old_string not found in {file_path}]\nLooking for: {snippet}"

        if count > 1 and not replace_all:
            return (
                f"[edit failed: old_string appears {count} times in {file_path}. "
                "Provide more surrounding context to make it unique, or set replace_all=true]"
            )

        if replace_all:
            new_content = content.replace(old_string, new_string)
            replaced = count
        else:
            new_content = content.replace(old_string, new_string, 1)
            replaced = 1

        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)

        return f"[edited {file_path}: replaced {replaced} occurrence(s)]"
    except Exception as e:
        return f"[edit error: {e}]"


# ─── Glob ─────────────────────────────────────────────────────────────────────

def run_glob(pattern: str, cwd: str | None = None) -> str:
    """File pattern matching using glob."""
    base = cwd or DEFAULT_WORKSPACE
    try:
        if not os.path.isabs(pattern):
            full_pattern = os.path.join(base, pattern)
        else:
            full_pattern = pattern

        matches = glob_module.glob(full_pattern, recursive=True)

        # Sort by modification time (most recent first) — mirrors Claude Code
        matches.sort(key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0, reverse=True)

        if not matches:
            return f"[no files matching pattern: {pattern}]"

        lines = [f"{len(matches)} file(s) matching '{pattern}':"]
        for m in matches[:200]:
            lines.append(f"  {m}")
        if len(matches) > 200:
            lines.append(f"  ... and {len(matches)-200} more")
        return "\n".join(lines)
    except Exception as e:
        return f"[glob error: {e}]"


# ─── Grep ─────────────────────────────────────────────────────────────────────

def run_grep(
    pattern: str,
    cwd: str | None = None,
    glob_pattern: str | None = None,
    output_mode: str = "content",
    case_insensitive: bool = False,
) -> str:
    """Regex search across files. output_mode: content | files | count."""
    base = cwd or DEFAULT_WORKSPACE
    try:
        flags = re.IGNORECASE if case_insensitive else 0
        regex = re.compile(pattern, flags)
    except re.error as e:
        return f"[grep error: invalid regex '{pattern}': {e}]"

    results = []
    file_count = 0
    match_count = 0

    try:
        for root, dirs, files in os.walk(base):
            # Skip hidden dirs and common noise
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "__pycache__", ".git", "venv", ".venv")]
            for fname in files:
                if glob_pattern and not fnmatch.fnmatch(fname, glob_pattern):
                    continue
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                        content = f.read()
                    file_matches = list(regex.finditer(content))
                    if not file_matches:
                        continue
                    file_count += 1
                    match_count += len(file_matches)
                    rel = os.path.relpath(fpath, base)
                    if output_mode == "files":
                        results.append(rel)
                    elif output_mode == "count":
                        results.append(f"{rel}: {len(file_matches)}")
                    else:  # content
                        lines = content.split("\n")
                        for m in file_matches[:20]:  # max 20 matches per file
                            lineno = content[:m.start()].count("\n") + 1
                            line_text = lines[lineno - 1].strip()[:200]
                            results.append(f"{rel}:{lineno}: {line_text}")
                except (PermissionError, OSError):
                    continue

        if not results:
            return f"[no matches for pattern: {pattern}]"

        header = f"{match_count} match(es) in {file_count} file(s) for '{pattern}':"
        body = "\n".join(results[:500])
        if len(results) > 500:
            body += f"\n... and {len(results)-500} more results"
        return f"{header}\n{body}"
    except Exception as e:
        return f"[grep error: {e}]"


# ─── TodoWrite ────────────────────────────────────────────────────────────────

def format_todos(todos: list) -> str:
    """Format todos for display in tool result."""
    if not todos:
        return "[todo list cleared]"
    lines = ["[todo list updated]"]
    for t in todos:
        status = t.get("status", "pending")
        icon = {"done": "✓", "in_progress": "→", "pending": "○"}.get(status, "○")
        priority = t.get("priority", "")
        prio_str = f" [{priority}]" if priority else ""
        lines.append(f"  {icon} {t.get('content','')}{prio_str} ({status})")
    return "\n".join(lines)


# ─── Dispatcher ───────────────────────────────────────────────────────────────

def execute_tool(tool_name: str, args: dict, conversation_id: str | None = None, current_todos: list | None = None):
    """
    Execute a tool by name. Returns (result_str, updated_todos).
    updated_todos is only set when TodoWrite is called.
    """
    updated_todos = current_todos  # default: unchanged

    if tool_name == "Bash":
        result = run_bash(args.get("command", ""), cwd=args.get("cwd"))

    elif tool_name == "Read":
        result = read_file(
            args.get("file_path", ""),
            line_start=args.get("line_start"),
            line_end=args.get("line_end"),
        )

    elif tool_name == "Write":
        result = write_file(args.get("file_path", ""), args.get("content", ""))

    elif tool_name == "Edit":
        result = edit_file(
            args.get("file_path", ""),
            args.get("old_string", ""),
            args.get("new_string", ""),
            replace_all=args.get("replace_all", False),
        )

    elif tool_name == "Glob":
        result = run_glob(args.get("pattern", ""), cwd=args.get("cwd"))

    elif tool_name == "Grep":
        result = run_grep(
            args.get("pattern", ""),
            cwd=args.get("cwd"),
            glob_pattern=args.get("glob_pattern"),
            output_mode=args.get("output_mode", "content"),
            case_insensitive=args.get("case_insensitive", False),
        )

    elif tool_name == "TodoWrite":
        new_todos = args.get("todos", [])
        updated_todos = new_todos
        result = format_todos(new_todos)

    elif tool_name == "web_search":
        result = search_web(args.get("query", ""))

    else:
        result = f"[unknown tool: {tool_name}]"

    return result, updated_todos
