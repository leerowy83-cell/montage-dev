# MontageDev AI — Complete Tool Reference Manual

## Overview
MontageDev AI has 23 built-in tools organized into 6 categories.
Each tool is implemented in Python and exposed via Groq function calling.

---

## CATEGORY 1: CORE FILE & SHELL TOOLS

### Tool: Bash
**Purpose**: Execute any bash command in the workspace sandbox.
**When to use**: System commands, package installation, running scripts, git operations,
anything not covered by a dedicated tool.
**When NOT to use**: Reading files (use Read), editing files (use Edit), searching files
(use Grep/Glob), git operations (use GitOp for structured output).

**Parameters**:
- `command` (required): The bash command string.
- `description` (optional): Human-readable description shown to user.

**Behavior**:
- Timeout: 30 seconds. Returns `[command timed out after 30s]` if exceeded.
- Working directory: /tmp/montagedev_workspaces/<conv_id[:8]>/
- stdout and stderr are combined in the output.
- Non-zero exit codes are captured and included.
- Output truncated at 10,000 characters.

**Safety rules**:
- Never skip git hooks (--no-verify).
- Never run rm -rf or DROP TABLE without user confirmation.
- Never hardcode credentials in commands.

**Examples**:
```
# Install a package
command: "pip install stripe --quiet"

# Check Python version
command: "python3 --version"

# List directory
command: "ls -la /tmp/workspace/"

# Run a script
command: "python3 myscript.py --arg value"

# Check git status
command: "git status"

# Build a project
command: "npm run build 2>&1"
```

---

### Tool: Read
**Purpose**: Read file contents with line numbers (like `cat -n`).
**When to use**: ALWAYS before editing a file. Reading config files, source code, logs.
**When NOT to use**: Never use cat/head/tail in Bash when Read works.

**Parameters**:
- `file_path` (required): Absolute path to the file.
- `line_start` (optional): First line to read (1-indexed).
- `line_end` (optional): Last line to read (inclusive).

**Behavior**:
- Returns file with format: `N\tcontent` (N = line number).
- Max 2000 lines per call. Use line_start/line_end for large files.
- Detects image files and returns metadata instead of binary.
- Encodes as UTF-8 with error replacement for binary/mixed files.

**Examples**:
```
# Read full file
file_path: "/tmp/workspace/main.py"

# Read lines 50-100
file_path: "/tmp/workspace/views.py"
line_start: 50
line_end: 100

# Read from line 200 to end (will cap at 2200)
file_path: "/tmp/workspace/big_file.py"
line_start: 200
```

---

### Tool: Write
**Purpose**: Create a new file or completely overwrite an existing one.
**When to use**: Creating new files from scratch. Complete rewrites.
**When NOT to use**: Modifying existing files (use Edit). Appending to files.

**IMPORTANT**: Read the existing file first if it exists. Write destroys existing content.

**Parameters**:
- `file_path` (required): Absolute path.
- `content` (required): Full content to write.

**Examples**:
```
# Create a new Python file
file_path: "/tmp/workspace/utils.py"
content: "def add(a, b):\n    return a + b\n"

# Create a new React component
file_path: "/tmp/workspace/src/Button.tsx"
content: "import React from 'react';\n\ninterface Props {\n  onClick: () => void;\n  children: React.ReactNode;\n}\n\nexport const Button: React.FC<Props> = ({ onClick, children }) => (\n  <button onClick={onClick}>{children}</button>\n);\n"
```

---

### Tool: Edit
**Purpose**: Make exact string replacements in existing files.
**When to use**: Modifying existing files. Fixing specific lines. Refactoring code.
**When NOT to use**: Creating new files (use Write). When the string is not unique.

**CRITICAL**: You MUST Read the file before Edit. The old_string must match exactly —
including whitespace, indentation, and newlines.

**Parameters**:
- `file_path` (required): Absolute path.
- `old_string` (required): Exact string to find.
- `new_string` (required): Replacement string.
- `replace_all` (optional): Replace all occurrences (default: false).

**Error cases**:
- "old_string not found": The text doesn't match exactly. Read the file again.
- "appears N times": Not unique. Add more surrounding context.

**Examples**:
```
# Fix a bug - replace return value
old_string: "    return user.id\n"
new_string: "    return str(user.id)\n"

# Update an import
old_string: "from django.utils import timezone\n"
new_string: "from django.utils import timezone\nfrom django.conf import settings\n"

# Change a function signature
old_string: "def send_message(request, conversation_id):\n"
new_string: "def send_message(request, conversation_id: str):\n"
```

---

### Tool: Glob
**Purpose**: Find files by name pattern using glob matching.
**When to use**: Finding files by extension. Listing source files. Discovering project structure.
**When NOT to use**: Searching file contents (use Grep). Listing directories (use Read or Bash ls).

**Parameters**:
- `pattern` (required): Glob pattern. Examples: `**/*.py`, `src/**/*.ts`, `*.json`.
- `cwd` (optional): Base directory. Defaults to /tmp/workspace.

**Behavior**:
- Recursive: `**` matches any number of directories.
- Returns up to 200 matches sorted by modification time (most recent first).
- Skips hidden directories automatically.

**Examples**:
```
# Find all Python files
pattern: "**/*.py"

# Find all TypeScript files in src/
pattern: "src/**/*.ts"

# Find all config files
pattern: "*.{json,yaml,yml,toml,ini}"

# Find all test files
pattern: "**/test_*.py"
pattern: "**/*.test.ts"
```

---

### Tool: Grep
**Purpose**: Search file contents using regex patterns.
**When to use**: Finding where a function is defined. Searching for error strings.
Finding all usages of a variable. Understanding codebase structure.

**Parameters**:
- `pattern` (required): Regular expression pattern.
- `cwd` (optional): Directory to search (default: /tmp/workspace).
- `glob_pattern` (optional): Filter by file type (e.g., `*.py`).
- `output_mode` (optional): `content` (lines), `files` (file paths), `count` (match counts).
- `case_insensitive` (optional): Boolean, default false.

**Behavior**:
- Skips: hidden dirs, node_modules, __pycache__, .git, venv, dist, build.
- Max 20 matches per file. Max 500 total results.
- Returns file path, line number, and matching line content.

**Examples**:
```
# Find all TODO comments
pattern: "TODO|FIXME|HACK"
output_mode: "content"

# Find all files that import django
pattern: "from django"
output_mode: "files"
glob_pattern: "*.py"

# Find function definitions
pattern: "def send_message"
cwd: "/tmp/workspace/chat/"

# Find unused variables (approximate)
pattern: "\bfoo\b"
case_insensitive: false
```

---

## CATEGORY 2: AI & PLANNING TOOLS

### Tool: TodoWrite
**Purpose**: Create and manage a structured task list for multi-step work.
**When to use**: Tasks with 3+ steps. Complex features. Debugging multi-file issues.
Before starting any significant work.

**Parameters**:
- `todos` (required): Complete list of todo items (replaces existing list).
  Each item: `id`, `content`, `status` (pending/in_progress/done), `priority` (high/medium/low).

**Behavior**:
- Calling TodoWrite REPLACES the entire current list.
- Shows in the UI as a collapsible task panel.
- Only one item should be `in_progress` at a time.
- When all items are `done`, the task panel is complete.

**Examples**:
```json
{
  "todos": [
    {"id": "1", "content": "Read existing auth code", "status": "done", "priority": "high"},
    {"id": "2", "content": "Design OAuth flow", "status": "in_progress", "priority": "high"},
    {"id": "3", "content": "Implement Google OAuth route", "status": "pending", "priority": "high"},
    {"id": "4", "content": "Add frontend OAuth button", "status": "pending", "priority": "medium"},
    {"id": "5", "content": "Test full flow", "status": "pending", "priority": "medium"}
  ]
}
```

---

### Tool: MemoryWrite
**Purpose**: Store persistent facts that survive across conversations.
**When to use**: When user defines a project convention, API URL, tech stack preference,
or corrects an assumption. Store durable facts, not transient data.

**Parameters**:
- `key` (required): Descriptive key name.
- `value` (optional): Fact to remember.
- `action` (optional): `write` (default), `delete`, or `list`.

**Good memory keys**: `project_stack`, `api_base_url`, `db_schema`, `coding_conventions`,
`user_preferences`, `deployment_config`, `team_conventions`.

**Examples**:
```
# Store project tech stack
key: "project_stack"
value: "Django 4.2 + React 18 + Supabase + Tailwind CSS"

# Store API base URL
key: "api_base_url"
value: "https://api.myapp.com/v1/"

# User prefers functional components
key: "coding_conventions"
value: "Always use TypeScript. Functional components only. No default exports."

# List all stored memories
key: "_"
action: "list"
```

---

### Tool: Task
**Purpose**: Spawn a focused subtask agent to handle specific work independently.
**When to use**: Parallel research. Generating a specific module. Running a long analysis.
Work that benefits from a clean, focused context.

**Parameters**:
- `description` (required): Short label for the task.
- `prompt` (required): Full instructions — be comprehensive, it starts fresh.
- `tools` (optional): List of tool names to give the subtask.

**Examples**:
```
# Research a library
description: "Research Stripe Python SDK payment intents"
prompt: "Search for and fetch the Stripe Python SDK documentation for PaymentIntents. Return: 1) how to create a PaymentIntent, 2) the required parameters, 3) how to handle webhooks."

# Generate a module
description: "Write the authentication service module"
prompt: "Write a Python auth service module for a Django app that: 1) verifies Supabase JWTs, 2) has a function get_user_from_token(token: str) -> dict | None, 3) has proper error handling. Use python-jose for JWT. Return only the code."
```

---

## CATEGORY 3: WEB & NETWORK TOOLS

### Tool: web_search
**Purpose**: Search the internet for current information.
**When to use**: Recent events, current API docs, library changelogs, anything after training cutoff.
Whenever you're unsure if your knowledge is current.

**Parameters**:
- `query` (required): Concise search query (3-8 words work best).

**Examples**:
```
# Find recent news
query: "Groq API new models 2025"

# Find documentation
query: "Supabase realtime channels JavaScript"

# Find error solutions
query: "Django StreamingHttpResponse SSE Vercel"

# Find library examples
query: "React 18 useTransition concurrent example"
```

---

### Tool: UrlFetch
**Purpose**: Fetch the content of any URL.
**When to use**: Reading documentation pages. Fetching API responses. Downloading JSON data.
Verifying that a URL works.

**Parameters**:
- `url` (required): The full URL.
- `method` (optional): HTTP method, default GET.
- `headers` (optional): Headers as object.
- `body` (optional): Request body string.
- `max_bytes` (optional): Max bytes to return (default 50000).

**Examples**:
```
# Fetch a documentation page
url: "https://docs.djangoproject.com/en/4.2/topics/http/views/"

# Fetch JSON data
url: "https://api.example.com/users"
headers: {"Authorization": "Bearer mytoken"}

# POST request
url: "https://httpbin.org/post"
method: "POST"
body: '{"test": true}'
```

---

### Tool: ApiCall
**Purpose**: Make HTTP API calls with full request control.
**When to use**: Testing API endpoints during development. Fetching data from external services.
Verifying API behavior.

**Parameters**:
- `url` (required): API endpoint URL.
- `method` (optional): GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS.
- `headers` (optional): Header key-value pairs.
- `body` (optional): Request body object (JSON-serialized automatically).
- `params` (optional): URL query parameters.
- `timeout` (optional): Seconds, default 30.

**Examples**:
```
# Test a local endpoint
url: "http://localhost:8000/api/conversations/"
headers: {"Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9..."}

# POST with body
url: "https://api.openai.com/v1/chat/completions"
method: "POST"
headers: {"Authorization": "Bearer sk-...", "Content-Type": "application/json"}
body: {"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}

# GET with query params
url: "https://api.github.com/search/repositories"
params: {"q": "language:python", "sort": "stars", "per_page": 10}
```

---

## CATEGORY 4: CODE QUALITY TOOLS

### Tool: FormatCode
**Purpose**: Format source code using language-specific formatters.
**Languages**: Python (black), JavaScript/TypeScript (prettier), JSON, HTML, CSS, SQL, Markdown.

**Parameters**:
- `code` (optional): Code string to format.
- `language` (required): Language name.
- `file_path` (optional): Format a file in-place instead.

---

### Tool: LintCode
**Purpose**: Find bugs and style issues in source code.
**Languages**: Python (ruff/pylint), JavaScript/TypeScript (eslint).

**Parameters**:
- `code` (optional): Code to lint.
- `language` (required): Language name.
- `file_path` (optional): Lint a file instead.
- `rules` (optional): Specific rule IDs to check.

---

### Tool: RunTests
**Purpose**: Execute test suites and return results.
**Frameworks**: pytest, jest, vitest, go test, mocha, rspec.

**Parameters**:
- `test_path` (required): Path to test file or directory.
- `framework` (optional): Auto-detected if omitted.
- `filter` (optional): Pattern to filter test names.
- `coverage` (optional): Include coverage report.
- `timeout` (optional): Seconds, default 60.

**Return format**: Pass/fail counts, failing test names, error messages, optional coverage.

---

### Tool: SecretScan
**Purpose**: Scan code for accidentally committed secrets, API keys, tokens.
**Detects**: Passwords, API keys (OpenAI, AWS, GitHub, Slack, Google), JWT tokens,
private keys, client secrets.

**Parameters**:
- `path` (optional): File or directory to scan.
- `code` (optional): Inline code to scan.
- `severity` (optional): Minimum severity: `all`, `high`, `critical`.

**IMPORTANT**: Always run before committing code that handles credentials.
Secrets are masked in output (first 10 chars + last 4 chars).

---

## CATEGORY 5: DATA & ANALYSIS TOOLS

### Tool: SqlQuery
**Purpose**: Execute SQL queries against a SQLite database.
**When to use**: Inspecting local database files. Testing queries. Running migrations.
Data analysis without leaving the agent loop.

**Parameters**:
- `db_path` (required): Path to .db file. Use `:memory:` for in-memory.
- `query` (required): SQL query (SELECT, INSERT, UPDATE, DELETE, CREATE, etc.).
- `params` (optional): Parameterized query parameters.

**Returns**: Formatted table for SELECT, row count for mutations.
Max 100 rows returned.

**Examples**:
```
# Inspect schema
db_path: "/tmp/workspace/app.db"
query: "SELECT name, sql FROM sqlite_master WHERE type='table'"

# Query data
query: "SELECT * FROM users WHERE created_at > '2025-01-01' LIMIT 10"

# Safe parameterized insert
query: "INSERT INTO users (email, role) VALUES (?, ?)"
params: ["user@example.com", "admin"]

# Aggregate
query: "SELECT status, COUNT(*) as count FROM orders GROUP BY status"
```

---

### Tool: JsonQuery
**Purpose**: Query and transform JSON data using jq-style expressions.
**When to use**: Extracting fields from API responses. Transforming JSON. Filtering arrays.

**Parameters**:
- `source` (required): File path or `"inline"` to use `data`.
- `expression` (required): jq expression.
- `data` (optional): Inline JSON string when source is `"inline"`.

**Supported expressions**:
- `.` — return entire document
- `.field` — extract a field
- `.a.b.c` — nested field access
- `.[]` — all values
- `length` — count elements or string length
- `keys` — object keys
- `pipe: expr1 | expr2` — chain expressions

**Examples**:
```
# Extract all user emails from API response
source: "inline"
data: '{"users": [{"email": "a@b.com"}, {"email": "c@d.com"}]}'
expression: ".users[].email"  # Note: simple .[] not array indexing yet

# Get count of items
expression: ".items | length"

# Get all keys
expression: "keys"
```

---

### Tool: RegexTest
**Purpose**: Develop and test regular expressions interactively.
**When to use**: Building complex regex patterns. Validating existing regex.
Understanding what a pattern matches.

**Parameters**:
- `pattern` (required): Regex pattern.
- `text` (required): Text to test against.
- `flags` (optional): `i` (case-insensitive), `m` (multiline), `s` (dotall).
- `language` (optional): `python` or `javascript` flavor (default python).

**Returns**: All matches with positions, capture groups, and named groups.

**Examples**:
```
# Test email regex
pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"
text: "Contact us at support@example.com or billing@company.org"

# Test URL with named groups
pattern: "(?P<scheme>https?)://(?P<host>[^/]+)(?P<path>/.*)"
text: "https://api.example.com/v1/users"

# Test date extraction
pattern: "(\d{4})-(\d{2})-(\d{2})"
text: "Created: 2025-04-01, Updated: 2025-04-04"
```

---

### Tool: Diff
**Purpose**: Show the difference between two files or text content.
**When to use**: Reviewing changes before applying. Comparing file versions.
Understanding what changed.

**Parameters**:
- `file_a` (required): First file path, or `"stdin"` to use `content_a`.
- `file_b` (required): Second file path, or `"stdin"` to use `content_b`.
- `content_a` (optional): Content when file_a is `"stdin"`.
- `content_b` (optional): Content when file_b is `"stdin"`.
- `context_lines` (optional): Lines of context around changes (default 3).

**Returns**: Unified diff format.

---

## CATEGORY 6: NOTEBOOK & GIT TOOLS

### Tool: NotebookRead
**Purpose**: Read Jupyter notebook files (.ipynb) — cells, outputs, metadata.
**When to use**: Understanding notebook structure. Reading cell code and outputs.

**Parameters**:
- `notebook_path` (required): Absolute path to .ipynb file.
- `cell_index` (optional): Specific cell to read (0-based). Omit for all cells.

---

### Tool: NotebookEdit
**Purpose**: Modify Jupyter notebook cells.
**When to use**: Fixing code in notebooks. Adding new cells. Removing old cells.

**Parameters**:
- `notebook_path` (required): Absolute path to .ipynb file.
- `cell_index` (required): Cell index (0-based).
- `new_source` (optional): New cell content.
- `cell_type` (optional): `code` or `markdown` (default code).
- `action` (optional): `replace`, `insert`, or `delete` (default replace).

---

### Tool: GitOp
**Purpose**: Structured git operations with better output than raw Bash.
**When to use**: Any git operation — especially status, diff, log, commit.

**Parameters**:
- `operation` (required): One of: `status`, `diff`, `log`, `add`, `commit`, `push`,
  `pull`, `branch`, `checkout`, `merge`, `stash`, `stash_pop`, `reset`, `clean`.
- `args` (optional): Operation-specific arguments object.

**Args by operation**:
- `commit`: `{"message": "feat: add auth", "all": true}`
- `add`: `{"files": ["src/auth.py", "tests/test_auth.py"]}`
- `branch`: `{"name": "feature/auth"}` or `{"name": "old-branch", "delete": true}`
- `checkout`: `{"branch": "main"}` or `{"branch": "feature/new", "create": true}`
- `log`: `{"n": 20, "oneline": true}`
- `diff`: `{"staged": true}` or `{"file": "src/views.py"}`
- `push`: `{"remote": "origin", "branch": "main", "force": false}`
- `stash`: `{"message": "WIP: auth refactor"}`
- `reset`: `{"hard": true, "ref": "HEAD~1"}`

**Examples**:
```
# Check status
operation: "status"

# Commit all changes
operation: "commit"
args: {"message": "fix(auth): handle expired JWT tokens", "all": true}

# Create and switch to new branch
operation: "checkout"
args: {"branch": "feature/payments", "create": true}

# View recent commits
operation: "log"
args: {"n": 10, "oneline": true}
```

---

## Appendix: Tool Selection Quick Reference

| Task | Preferred Tool | Why |
|------|---------------|-----|
| Read a file | Read | Line numbers, range selection |
| Modify a file | Edit | Exact replacement, surgical |
| Create a new file | Write | Full content control |
| Find files by name | Glob | Pattern matching, sorted by mtime |
| Find text in files | Grep | Regex, file filtering, output modes |
| Run any command | Bash | Catch-all for everything else |
| Internet search | web_search | Real-time results |
| Fetch a page | UrlFetch | Full HTTP, JSON parsing |
| Call an API | ApiCall | Full HTTP client |
| Plan multi-step work | TodoWrite | Task tracking, UI visibility |
| Remember a fact | MemoryWrite | Persists across conversations |
| Run tests | RunTests | Structured results |
| Format code | FormatCode | Language-specific formatters |
| Check for secrets | SecretScan | Credential detection |
| Query a database | SqlQuery | Safe, parameterized |
| Query JSON | JsonQuery | jq-style expressions |
| Test a regex | RegexTest | Interactive pattern testing |
| Compare files | Diff | Unified diff output |
| Git operations | GitOp | Structured git |
| Jupyter notebooks | NotebookRead/Edit | Cell-level access |
| Focused subtask | Task | Clean context, parallel work |
