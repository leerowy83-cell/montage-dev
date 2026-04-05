"""
MontageDev Tool Implementations — All 23 tools.
Bash, Read, Write, Edit, Glob, Grep, TodoWrite, web_search,
NotebookRead, NotebookEdit, UrlFetch, Diff, SqlQuery, JsonQuery,
RegexTest, FormatCode, LintCode, RunTests, GitOp, ApiCall,
SecretScan, MemoryWrite, Task
"""
import difflib
import fnmatch
import glob as glob_module
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import urllib.request as urlreq
    import urllib.error as urlerr
except ImportError:
    urlreq = None

from .web_search import search_web

WORKSPACE_BASE = "/tmp/montagedev_workspaces"
DEFAULT_WORKSPACE = "/tmp/montagedev_ws"
MAX_OUTPUT = 10_000
BASH_TIMEOUT = 30
MEMORY_FILE = "/tmp/montagedev_memory.json"


def _ensure_dir(path):
    os.makedirs(path, exist_ok=True)
    return path

def _workspace(conversation_id=None):
    d = os.path.join(WORKSPACE_BASE, str(conversation_id)[:8]) if conversation_id else DEFAULT_WORKSPACE
    return _ensure_dir(d)

def _truncate(text, limit=MAX_OUTPUT):
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + f"\n\n... [truncated {len(text)-limit} chars] ...\n\n" + text[-half:]


# ─── Bash ─────────────────────────────────────────────────────────────────────
def run_bash(command, cwd=None):
    work_dir = cwd or DEFAULT_WORKSPACE
    _ensure_dir(work_dir)
    try:
        result = subprocess.run(command, shell=True, cwd=work_dir,
            capture_output=True, text=True, timeout=BASH_TIMEOUT)
        out = ""
        if result.stdout: out += result.stdout
        if result.stderr: out += ("\n" if out else "") + result.stderr
        if result.returncode != 0 and not out:
            out = f"[exited with code {result.returncode}]"
        return _truncate(out.strip() or "[no output]")
    except subprocess.TimeoutExpired:
        return f"[command timed out after {BASH_TIMEOUT}s]"
    except Exception as e:
        return f"[bash error: {e}]"


# ─── Read ─────────────────────────────────────────────────────────────────────
def read_file(file_path, line_start=None, line_end=None):
    MAX_LINES = 2000
    try:
        path = Path(file_path)
        if not path.exists(): return f"[error: file not found: {file_path}]"
        if path.is_dir(): return f"[error: {file_path} is a directory]"
        img_exts = {".png",".jpg",".jpeg",".gif",".webp",".bmp",".avif",".svg"}
        if path.suffix.lower() in img_exts:
            return f"[image file: {file_path}, {path.stat().st_size} bytes — use UrlFetch for data URIs]"
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        total = len(lines)
        start = max(0, (line_start or 1) - 1)
        end = min(total, line_end or (start + MAX_LINES))
        if end - start > MAX_LINES:
            end = start + MAX_LINES; truncated = True
        else:
            truncated = False
        numbered = "".join(f"{i+1}\t{line}" for i, line in enumerate(lines[start:end], start=start))
        header = f"[{file_path}] ({total} lines total"
        if line_start or line_end: header += f", showing {start+1}–{end}"
        header += ")"
        if truncated: header += f" [truncated to {MAX_LINES} lines]"
        return f"{header}\n{numbered}"
    except Exception as e:
        return f"[read error: {e}]"


# ─── Write ────────────────────────────────────────────────────────────────────
def write_file(file_path, content):
    try:
        path = Path(file_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        return f"[wrote {len(content)} bytes ({content.count(chr(10))+1} lines) to {file_path}]"
    except Exception as e:
        return f"[write error: {e}]"


# ─── Edit ─────────────────────────────────────────────────────────────────────
def edit_file(file_path, old_string, new_string, replace_all=False):
    try:
        path = Path(file_path)
        if not path.exists(): return f"[error: file not found: {file_path}]"
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        count = content.count(old_string)
        if count == 0:
            return f"[edit failed: old_string not found in {file_path}]\nLooking for: {repr(old_string[:80])}"
        if count > 1 and not replace_all:
            return (f"[edit failed: old_string appears {count} times. "
                    "Provide more context to make unique, or set replace_all=true]")
        new_content = content.replace(old_string, new_string) if replace_all else content.replace(old_string, new_string, 1)
        replaced = count if replace_all else 1
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return f"[edited {file_path}: replaced {replaced} occurrence(s)]"
    except Exception as e:
        return f"[edit error: {e}]"


# ─── Glob ─────────────────────────────────────────────────────────────────────
def run_glob(pattern, cwd=None):
    base = cwd or DEFAULT_WORKSPACE
    try:
        full_pattern = pattern if os.path.isabs(pattern) else os.path.join(base, pattern)
        matches = glob_module.glob(full_pattern, recursive=True)
        matches.sort(key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0, reverse=True)
        if not matches: return f"[no files matching: {pattern}]"
        lines = [f"{len(matches)} file(s) matching '{pattern}':"]
        for m in matches[:200]: lines.append(f"  {m}")
        if len(matches) > 200: lines.append(f"  ... and {len(matches)-200} more")
        return "\n".join(lines)
    except Exception as e:
        return f"[glob error: {e}]"


# ─── Grep ─────────────────────────────────────────────────────────────────────
def run_grep(pattern, cwd=None, glob_pattern=None, output_mode="content", case_insensitive=False):
    base = cwd or DEFAULT_WORKSPACE
    try:
        flags = re.IGNORECASE if case_insensitive else 0
        regex = re.compile(pattern, flags)
    except re.error as e:
        return f"[grep error: invalid regex '{pattern}': {e}]"
    results = []; file_count = 0; match_count = 0
    try:
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules","__pycache__",".git","venv",".venv","dist","build")]
            for fname in files:
                if glob_pattern and not fnmatch.fnmatch(fname, glob_pattern): continue
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                        content = f.read()
                    file_matches = list(regex.finditer(content))
                    if not file_matches: continue
                    file_count += 1; match_count += len(file_matches)
                    rel = os.path.relpath(fpath, base)
                    if output_mode == "files": results.append(rel)
                    elif output_mode == "count": results.append(f"{rel}: {len(file_matches)}")
                    else:
                        lines = content.split("\n")
                        for m in file_matches[:20]:
                            lineno = content[:m.start()].count("\n") + 1
                            results.append(f"{rel}:{lineno}: {lines[lineno-1].strip()[:200]}")
                except (PermissionError, OSError): continue
        if not results: return f"[no matches for: {pattern}]"
        header = f"{match_count} match(es) in {file_count} file(s) for '{pattern}':"
        body = "\n".join(results[:500])
        if len(results) > 500: body += f"\n... and {len(results)-500} more results"
        return f"{header}\n{body}"
    except Exception as e:
        return f"[grep error: {e}]"


# ─── TodoWrite ────────────────────────────────────────────────────────────────
def format_todos(todos):
    if not todos: return "[todo list cleared]"
    lines = ["[todo list updated]"]
    for t in todos:
        icon = {"done":"✓","in_progress":"→","pending":"○"}.get(t.get("status","pending"),"○")
        prio = t.get("priority","")
        lines.append(f"  {icon} {t.get('content','')}{f' [{prio}]' if prio else ''} ({t.get('status','pending')})")
    return "\n".join(lines)


# ─── NotebookRead ─────────────────────────────────────────────────────────────
def read_notebook(notebook_path, cell_index=None):
    try:
        with open(notebook_path, "r", encoding="utf-8") as f:
            nb = json.load(f)
        cells = nb.get("cells", [])
        if cell_index is not None:
            if cell_index >= len(cells): return f"[error: notebook has {len(cells)} cells, index {cell_index} out of range]"
            cells = [cells[cell_index]]
        lines = [f"[Notebook: {notebook_path}, {len(nb.get('cells',[]))} cells total]"]
        for i, cell in enumerate(cells):
            idx = cell_index if cell_index is not None else i
            ct = cell.get("cell_type","code")
            src = "".join(cell.get("source",[]))
            lines.append(f"\n--- Cell {idx} ({ct}) ---\n{src}")
            if ct == "code" and cell.get("outputs"):
                for out in cell["outputs"][:3]:
                    if out.get("output_type") == "stream":
                        lines.append(f"[Output]: {''.join(out.get('text',[][:10]))}")
                    elif out.get("output_type") in ("execute_result","display_data"):
                        data = out.get("data",{})
                        if "text/plain" in data:
                            lines.append(f"[Result]: {''.join(data['text/plain'])[:200]}")
        return "\n".join(lines)
    except FileNotFoundError:
        return f"[error: notebook not found: {notebook_path}]"
    except Exception as e:
        return f"[notebook read error: {e}]"


# ─── NotebookEdit ─────────────────────────────────────────────────────────────
def edit_notebook(notebook_path, cell_index, new_source=None, cell_type="code", action="replace"):
    try:
        with open(notebook_path, "r", encoding="utf-8") as f:
            nb = json.load(f)
        cells = nb.get("cells", [])
        if action == "delete":
            if cell_index >= len(cells): return f"[error: cell index {cell_index} out of range]"
            cells.pop(cell_index)
        elif action == "insert":
            new_cell = {"cell_type": cell_type, "metadata": {}, "source": [new_source or ""], "outputs": [] if cell_type == "code" else None}
            if cell_type == "code": new_cell["execution_count"] = None
            cells.insert(cell_index, new_cell)
        else:  # replace
            if cell_index >= len(cells): return f"[error: cell index {cell_index} out of range]"
            cells[cell_index]["source"] = [new_source or ""]
            cells[cell_index]["cell_type"] = cell_type
            if cell_type == "code": cells[cell_index]["outputs"] = []
        nb["cells"] = cells
        with open(notebook_path, "w", encoding="utf-8") as f:
            json.dump(nb, f, indent=1)
        return f"[notebook edited: {action} on cell {cell_index} in {notebook_path}]"
    except Exception as e:
        return f"[notebook edit error: {e}]"


# ─── UrlFetch ─────────────────────────────────────────────────────────────────
def fetch_url(url, method="GET", headers=None, body=None, max_bytes=50000):
    try:
        req = urlreq.Request(url, method=method)
        req.add_header("User-Agent", "MontageDev/1.0")
        if headers:
            for k, v in headers.items(): req.add_header(k, v)
        if body:
            if isinstance(body, dict):
                body = json.dumps(body).encode()
                req.add_header("Content-Type", "application/json")
            elif isinstance(body, str):
                body = body.encode()
            req.data = body
        with urlreq.urlopen(req, timeout=15) as resp:
            status = resp.status
            ct = resp.headers.get("Content-Type", "")
            raw = resp.read(max_bytes)
            try:
                text = raw.decode("utf-8", errors="replace")
            except Exception:
                text = repr(raw[:500])
            if "application/json" in ct:
                try:
                    parsed = json.loads(text)
                    text = json.dumps(parsed, indent=2)[:max_bytes]
                except Exception:
                    pass
            return f"[HTTP {status} {url}]\nContent-Type: {ct}\n\n{text}"
    except urlerr.HTTPError as e:
        return f"[HTTP {e.code} {url}]: {e.reason}"
    except Exception as e:
        return f"[fetch error: {e}]"


# ─── Diff ─────────────────────────────────────────────────────────────────────
def run_diff(file_a, file_b, content_a=None, content_b=None, context_lines=3):
    try:
        if file_a == "stdin":
            lines_a = (content_a or "").splitlines(keepends=True)
            label_a = "a"
        else:
            with open(file_a, "r", encoding="utf-8", errors="replace") as f:
                lines_a = f.readlines()
            label_a = file_a
        if file_b == "stdin":
            lines_b = (content_b or "").splitlines(keepends=True)
            label_b = "b"
        else:
            with open(file_b, "r", encoding="utf-8", errors="replace") as f:
                lines_b = f.readlines()
            label_b = file_b
        diff = list(difflib.unified_diff(lines_a, lines_b, fromfile=label_a, tofile=label_b, n=context_lines))
        if not diff: return "[no differences]"
        return _truncate("".join(diff))
    except Exception as e:
        return f"[diff error: {e}]"


# ─── SqlQuery ─────────────────────────────────────────────────────────────────
def run_sql_query(db_path, query, params=None):
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(query, params or [])
        if cur.description:
            cols = [d[0] for d in cur.description]
            rows = cur.fetchmany(100)
            lines = [" | ".join(cols), "-" * (sum(len(c) for c in cols) + 3 * len(cols))]
            for row in rows:
                lines.append(" | ".join(str(v) if v is not None else "NULL" for v in row))
            if len(rows) == 100: lines.append("... (100 row limit)")
            result = "\n".join(lines)
        else:
            conn.commit()
            result = f"[query OK, {cur.rowcount} row(s) affected]"
        conn.close()
        return result
    except Exception as e:
        return f"[sql error: {e}]"


# ─── JsonQuery ────────────────────────────────────────────────────────────────
def run_json_query(source, expression, data=None):
    try:
        if source == "inline":
            obj = json.loads(data or "{}")
        else:
            with open(source, "r", encoding="utf-8") as f:
                obj = json.load(f)
        # Simple jq-like evaluation using Python
        result = _eval_jq(obj, expression)
        return json.dumps(result, indent=2, default=str)[:MAX_OUTPUT]
    except Exception as e:
        return f"[json query error: {e}]"

def _eval_jq(obj, expr):
    expr = expr.strip()
    if expr == ".": return obj
    if expr.startswith(".") and "[" not in expr and "|" not in expr:
        keys = expr[1:].split(".")
        for k in keys:
            if k == "": continue
            if isinstance(obj, dict): obj = obj.get(k)
            elif isinstance(obj, list): obj = [item.get(k) if isinstance(item, dict) else None for item in obj]
            else: return None
        return obj
    if "|" in expr:
        parts = expr.split("|", 1)
        obj = _eval_jq(obj, parts[0].strip())
        return _eval_jq(obj, parts[1].strip())
    if expr == "length":
        return len(obj) if hasattr(obj, "__len__") else 0
    if expr == "keys" and isinstance(obj, dict):
        return list(obj.keys())
    if expr == ".[]" and isinstance(obj, (list, dict)):
        return list(obj.values()) if isinstance(obj, dict) else obj
    return obj


# ─── RegexTest ────────────────────────────────────────────────────────────────
def test_regex(pattern, text, flags="", language="python"):
    try:
        re_flags = 0
        if "i" in flags: re_flags |= re.IGNORECASE
        if "m" in flags: re_flags |= re.MULTILINE
        if "s" in flags: re_flags |= re.DOTALL
        regex = re.compile(pattern, re_flags)
        matches = list(regex.finditer(text))
        if not matches: return f"[no matches for: {pattern}]"
        lines = [f"{len(matches)} match(es) for /{pattern}/:"]
        for i, m in enumerate(matches[:20]):
            lines.append(f"\nMatch {i+1}: {repr(m.group())} at position {m.start()}-{m.end()}")
            if m.groups():
                for j, g in enumerate(m.groups(), 1):
                    lines.append(f"  Group {j}: {repr(g)}")
            if m.groupdict():
                for name, val in m.groupdict().items():
                    lines.append(f"  Named '{name}': {repr(val)}")
        return "\n".join(lines)
    except re.error as e:
        return f"[regex error: {e}]"


# ─── FormatCode ───────────────────────────────────────────────────────────────
def format_code(code=None, language="python", file_path=None):
    try:
        if file_path:
            with open(file_path, "r", encoding="utf-8") as f:
                code = f.read()
        if language == "python":
            result = run_bash(f"echo {repr(code)} | python3 -m black - 2>&1 || echo '{code}'")
            return result
        elif language in ("javascript", "typescript", "json", "html", "css", "markdown"):
            if shutil.which("prettier"):
                ext = {"javascript":"js","typescript":"ts"}.get(language, language)
                with tempfile.NamedTemporaryFile(suffix=f".{ext}", mode="w", delete=False) as tmp:
                    tmp.write(code or ""); tmp_path = tmp.name
                result = run_bash(f"prettier --write {tmp_path} 2>&1 && cat {tmp_path}")
                os.unlink(tmp_path)
                return result
        elif language == "sql":
            return f"[formatted SQL]\n{code}"
        return f"[format not available for {language} — formatter not installed]"
    except Exception as e:
        return f"[format error: {e}]"


# ─── LintCode ────────────────────────────────────────────────────────────────
def lint_code(code=None, language="python", file_path=None, rules=None):
    try:
        if not file_path:
            ext = {"python":"py","javascript":"js","typescript":"ts"}.get(language,"txt")
            with tempfile.NamedTemporaryFile(suffix=f".{ext}", mode="w", delete=False) as tmp:
                tmp.write(code or ""); file_path = tmp.name; cleanup = True
        else:
            cleanup = False
        if language == "python":
            result = run_bash(f"python3 -m ruff check {file_path} 2>&1 || python3 -m pylint {file_path} 2>&1")
        elif language in ("javascript","typescript"):
            result = run_bash(f"npx eslint {file_path} 2>&1 || echo 'ESLint not available'")
        else:
            result = f"[linting not available for {language}]"
        if cleanup: os.unlink(file_path)
        return result or "[no issues found]"
    except Exception as e:
        return f"[lint error: {e}]"


# ─── RunTests ────────────────────────────────────────────────────────────────
def run_tests(test_path, framework=None, filter_pattern=None, coverage=False, timeout=60):
    try:
        if not framework:
            if test_path.endswith(".py") or "/test" in test_path: framework = "pytest"
            elif test_path.endswith((".js",".ts")): framework = "jest"
            else: framework = "pytest"
        if framework == "pytest":
            cmd = f"python3 -m pytest {test_path} -v"
            if filter_pattern: cmd += f" -k '{filter_pattern}'"
            if coverage: cmd += " --cov --cov-report=term-missing"
            cmd += f" --timeout={timeout}"
        elif framework in ("jest","vitest"):
            cmd = f"npx {framework} {test_path} --reporter=verbose"
            if filter_pattern: cmd += f" -t '{filter_pattern}'"
        elif framework == "go":
            cmd = f"go test {test_path} -v -timeout {timeout}s"
        else:
            cmd = f"python3 -m pytest {test_path} -v"
        result = run_bash(cmd)
        return _truncate(result)
    except Exception as e:
        return f"[test run error: {e}]"


# ─── GitOp ────────────────────────────────────────────────────────────────────
def run_git_op(operation, args=None, cwd=None):
    args = args or {}
    work_dir = cwd or DEFAULT_WORKSPACE
    cmds = {
        "status": "git status --short",
        "diff": f"git diff {'--staged' if args.get('staged') else ''} {args.get('file','')}",
        "log": f"git log {'--oneline' if args.get('oneline') else ''} -n {args.get('n',10)}",
        "add": f"git add {' '.join(args.get('files', ['.']))}",
        "commit": f"git commit {'--all' if args.get('all') else ''} -m {repr(args.get('message','[auto commit]'))}",
        "push": f"git push {args.get('remote','origin')} {args.get('branch','HEAD')} {'--force' if args.get('force') else ''}",
        "pull": "git pull",
        "branch": f"git branch {'-d' if args.get('delete') else ''} {args.get('name','')}",
        "checkout": f"git checkout {'-b' if args.get('create') else ''} {args.get('branch','')}",
        "merge": f"git merge {args.get('branch','')}",
        "stash": f"git stash push -m {repr(args.get('message','stash'))}",
        "stash_pop": "git stash pop",
        "reset": f"git reset {'--hard' if args.get('hard') else '--soft' if args.get('soft') else ''} {args.get('ref','HEAD')}",
        "clean": "git clean -fd",
    }
    cmd = cmds.get(operation, f"git {operation}")
    return run_bash(cmd, cwd=work_dir)


# ─── ApiCall ─────────────────────────────────────────────────────────────────
def api_call(url, method="GET", headers=None, body=None, params=None, timeout=30):
    try:
        if params:
            from urllib.parse import urlencode
            url = url + ("&" if "?" in url else "?") + urlencode(params)
        body_data = None
        if body:
            body_data = json.dumps(body).encode()
        return fetch_url(url, method=method, headers=headers, body=body_data, max_bytes=50000)
    except Exception as e:
        return f"[api call error: {e}]"


# ─── SecretScan ───────────────────────────────────────────────────────────────
SECRET_PATTERNS = [
    ("CRITICAL", r'(?i)(password|passwd|pwd)\s*[=:]\s*["\']?[^\s"\']{8,}'),
    ("CRITICAL", r'(?i)(api_key|apikey|api-key)\s*[=:]\s*["\']?[A-Za-z0-9_\-]{16,}'),
    ("CRITICAL", r'(?i)(secret_key|secret)\s*[=:]\s*["\']?[^\s"\']{16,}'),
    ("CRITICAL", r'sk-[A-Za-z0-9]{32,}'),  # OpenAI
    ("CRITICAL", r'eyJ[A-Za-z0-9_\-]{50,}'),  # JWT
    ("HIGH",     r'(?i)(aws_access_key_id|aws_secret)\s*[=:]\s*["\']?[A-Z0-9]{16,}'),
    ("HIGH",     r'ghp_[A-Za-z0-9]{36}'),  # GitHub PAT
    ("HIGH",     r'xoxb-[A-Za-z0-9\-]{50,}'),  # Slack bot
    ("HIGH",     r'AIza[0-9A-Za-z_\-]{35}'),  # Google API
    ("MEDIUM",   r'(?i)private_key\s*[=:]\s*["\']?-----BEGIN'),
    ("MEDIUM",   r'(?i)client_secret\s*[=:]\s*["\']?[^\s"\']{16,}'),
    ("LOW",      r'(?i)(username|user)\s*[=:]\s*["\']?[^\s"\']{4,}'),
]

def scan_secrets(path=None, code=None, severity="all"):
    min_sev = {"critical": 4, "high": 3, "medium": 2, "low": 1, "all": 0}
    min_level = min_sev.get(severity.lower(), 0)
    sev_levels = {"CRITICAL": 4, "HIGH": 3, "MEDIUM": 2, "LOW": 1}
    findings = []

    def scan_text(text, filename):
        for sev, pattern in SECRET_PATTERNS:
            if sev_levels.get(sev, 0) < min_level: continue
            for m in re.finditer(pattern, text):
                lineno = text[:m.start()].count("\n") + 1
                # Mask the actual secret in output
                match_text = m.group()
                if len(match_text) > 20:
                    match_text = match_text[:10] + "..." + match_text[-4:]
                findings.append(f"[{sev}] {filename}:{lineno}: {match_text}")

    if code:
        scan_text(code, "<inline>")
    elif path:
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    scan_text(f.read(), path)
            except Exception: pass
        elif os.path.isdir(path):
            for root, dirs, files in os.walk(path):
                dirs[:] = [d for d in dirs if d not in (".git","node_modules","venv",".venv")]
                for fname in files:
                    if any(fname.endswith(ext) for ext in (".pyc",".jpg",".png",".gif",".zip",".tar")): continue
                    fpath = os.path.join(root, fname)
                    try:
                        with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                            scan_text(f.read(), os.path.relpath(fpath, path))
                    except Exception: continue

    if not findings: return "[no secrets detected]"
    return f"[secret scan: {len(findings)} finding(s)]\n" + "\n".join(findings[:50])


# ─── MemoryWrite ─────────────────────────────────────────────────────────────
def memory_write(key, value=None, action="write"):
    try:
        memory = {}
        if os.path.exists(MEMORY_FILE):
            with open(MEMORY_FILE, "r") as f:
                memory = json.load(f)
        if action == "list":
            if not memory: return "[memory is empty]"
            return "[memory keys]\n" + "\n".join(f"  {k}: {v[:60]}..." if len(str(v)) > 60 else f"  {k}: {v}" for k, v in memory.items())
        elif action == "delete":
            if key in memory:
                del memory[key]
                with open(MEMORY_FILE, "w") as f:
                    json.dump(memory, f, indent=2)
                return f"[deleted memory key: {key}]"
            return f"[memory key not found: {key}]"
        else:  # write
            memory[key] = value or ""
            with open(MEMORY_FILE, "w") as f:
                json.dump(memory, f, indent=2)
            return f"[memory written: {key} = {str(value)[:80]}]"
    except Exception as e:
        return f"[memory error: {e}]"


# ─── Task ─────────────────────────────────────────────────────────────────────
def run_task(description, prompt, tools=None):
    # Task spawning is handled at the view level — this is a placeholder
    # that confirms the task was received and passes context
    return f"[Task queued: {description}]\nPrompt will be handled by a focused subtask agent.\nNote: Full Task spawning requires multi-agent orchestration at the view level."


# ─── Dispatcher ───────────────────────────────────────────────────────────────
def execute_tool(tool_name, args, conversation_id=None, current_todos=None):
    updated_todos = current_todos

    if tool_name == "Bash":
        result = run_bash(args.get("command",""), cwd=args.get("cwd"))
    elif tool_name == "Read":
        result = read_file(args.get("file_path",""), args.get("line_start"), args.get("line_end"))
    elif tool_name == "Write":
        result = write_file(args.get("file_path",""), args.get("content",""))
    elif tool_name == "Edit":
        result = edit_file(args.get("file_path",""), args.get("old_string",""), args.get("new_string",""), args.get("replace_all",False))
    elif tool_name == "Glob":
        result = run_glob(args.get("pattern",""), cwd=args.get("cwd"))
    elif tool_name == "Grep":
        result = run_grep(args.get("pattern",""), cwd=args.get("cwd"), glob_pattern=args.get("glob_pattern"), output_mode=args.get("output_mode","content"), case_insensitive=args.get("case_insensitive",False))
    elif tool_name == "TodoWrite":
        new_todos = args.get("todos",[])
        updated_todos = new_todos
        result = format_todos(new_todos)
    elif tool_name == "web_search":
        result = search_web(args.get("query",""))
    elif tool_name == "NotebookRead":
        result = read_notebook(args.get("notebook_path",""), args.get("cell_index"))
    elif tool_name == "NotebookEdit":
        result = edit_notebook(args.get("notebook_path",""), args.get("cell_index",0), args.get("new_source"), args.get("cell_type","code"), args.get("action","replace"))
    elif tool_name == "UrlFetch":
        result = fetch_url(args.get("url",""), args.get("method","GET"), args.get("headers"), args.get("body"), args.get("max_bytes",50000))
    elif tool_name == "Diff":
        result = run_diff(args.get("file_a","stdin"), args.get("file_b","stdin"), args.get("content_a"), args.get("content_b"), args.get("context_lines",3))
    elif tool_name == "SqlQuery":
        result = run_sql_query(args.get("db_path",":memory:"), args.get("query","SELECT 1"), args.get("params"))
    elif tool_name == "JsonQuery":
        result = run_json_query(args.get("source","inline"), args.get("expression","."), args.get("data"))
    elif tool_name == "RegexTest":
        result = test_regex(args.get("pattern",""), args.get("text",""), args.get("flags",""), args.get("language","python"))
    elif tool_name == "FormatCode":
        result = format_code(args.get("code"), args.get("language","python"), args.get("file_path"))
    elif tool_name == "LintCode":
        result = lint_code(args.get("code"), args.get("language","python"), args.get("file_path"), args.get("rules"))
    elif tool_name == "RunTests":
        result = run_tests(args.get("test_path","."), args.get("framework"), args.get("filter"), args.get("coverage",False), args.get("timeout",60))
    elif tool_name == "GitOp":
        result = run_git_op(args.get("operation","status"), args.get("args",{}))
    elif tool_name == "ApiCall":
        result = api_call(args.get("url",""), args.get("method","GET"), args.get("headers"), args.get("body"), args.get("params"), args.get("timeout",30))
    elif tool_name == "SecretScan":
        result = scan_secrets(args.get("path"), args.get("code"), args.get("severity","all"))
    elif tool_name == "MemoryWrite":
        result = memory_write(args.get("key",""), args.get("value"), args.get("action","write"))
    elif tool_name == "Task":
        result = run_task(args.get("description",""), args.get("prompt",""), args.get("tools"))
    else:
        result = f"[unknown tool: {tool_name}]"

    return result, updated_todos
