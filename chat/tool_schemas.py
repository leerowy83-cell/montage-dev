"""
MontageDev Tool Schemas — Groq JSON schemas for all tools.
Ported from Claude Code's tool prompt files:
  BashTool/prompt.ts, FileReadTool/prompt.ts, FileWriteTool/prompt.ts,
  FileEditTool/prompt.ts, GlobTool/prompt.ts, GrepTool/prompt.ts,
  TodoWriteTool, web_search (existing)
"""

BASH_TOOL = {
    "type": "function",
    "function": {
        "name": "Bash",
        "description": (
            "Execute a bash command in the shell. "
            "Use for system commands, running scripts, installing packages, git operations, "
            "and terminal operations that require shell execution. "
            "IMPORTANT: Prefer dedicated tools (Read, Write, Edit, Glob, Grep) when they apply — "
            "only use Bash when no dedicated tool covers the operation. "
            "Working directory is /tmp/workspace. Commands time out after 30s. "
            "NEVER skip git hooks (--no-verify). "
            "NEVER run destructive commands (rm -rf, drop table, etc.) without user confirmation."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The bash command to execute. Use absolute paths when referencing files.",
                },
                "description": {
                    "type": "string",
                    "description": "Brief description of what this command does (shown to user).",
                },
            },
            "required": ["command"],
        },
    },
}

READ_TOOL = {
    "type": "function",
    "function": {
        "name": "Read",
        "description": (
            "Read a file from the filesystem. Returns file contents with line numbers (cat -n format). "
            "Use this instead of cat/head/tail/sed. "
            "The file_path must be an absolute path. "
            "You can specify line_start and line_end to read a range. "
            "Reads up to 2000 lines by default — use line_start/line_end for larger files."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the file to read.",
                },
                "line_start": {
                    "type": "integer",
                    "description": "First line to read (1-indexed). Omit to start from beginning.",
                },
                "line_end": {
                    "type": "integer",
                    "description": "Last line to read (inclusive). Omit to read to end (max 2000 lines).",
                },
            },
            "required": ["file_path"],
        },
    },
}

WRITE_TOOL = {
    "type": "function",
    "function": {
        "name": "Write",
        "description": (
            "Write a file to the filesystem. Overwrites existing file if present. "
            "IMPORTANT: If this is an existing file, you MUST use the Read tool first. "
            "Prefer the Edit tool for modifying existing files — it only sends the diff. "
            "Only use Write to create new files or for complete rewrites. "
            "NEVER create documentation (*.md / README) files unless explicitly asked. "
            "Only use emojis in files if the user explicitly requests it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the file to write.",
                },
                "content": {
                    "type": "string",
                    "description": "Full content to write to the file.",
                },
            },
            "required": ["file_path", "content"],
        },
    },
}

EDIT_TOOL = {
    "type": "function",
    "function": {
        "name": "Edit",
        "description": (
            "Perform exact string replacements in a file. "
            "You MUST use the Read tool at least once before editing. "
            "The old_string must match the file content exactly (including whitespace/indentation). "
            "old_string must be unique in the file — if it isn't, provide more surrounding context or use replace_all. "
            "ALWAYS prefer editing existing files. NEVER write new files unless explicitly required. "
            "Only add emojis if the user explicitly requests it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the file to edit.",
                },
                "old_string": {
                    "type": "string",
                    "description": "Exact string to find and replace. Must be unique in the file.",
                },
                "new_string": {
                    "type": "string",
                    "description": "String to replace old_string with.",
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "If true, replace all occurrences of old_string. Default false.",
                },
            },
            "required": ["file_path", "old_string", "new_string"],
        },
    },
}

GLOB_TOOL = {
    "type": "function",
    "function": {
        "name": "Glob",
        "description": (
            "Fast file pattern matching. Supports glob patterns like '**/*.js' or 'src/**/*.ts'. "
            "Returns matching file paths sorted by modification time. "
            "Use this instead of find or ls when searching for files by name pattern."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern to match files (e.g. '**/*.py', 'src/**/*.ts').",
                },
                "cwd": {
                    "type": "string",
                    "description": "Directory to search from. Defaults to /tmp/workspace.",
                },
            },
            "required": ["pattern"],
        },
    },
}

GREP_TOOL = {
    "type": "function",
    "function": {
        "name": "Grep",
        "description": (
            "Search file contents using regex. "
            "ALWAYS use Grep for search tasks — never invoke grep or rg as a Bash command. "
            "Supports full regex syntax (e.g. 'log.*Error', r'function\\s+\\w+'). "
            "Filter files with glob_pattern (e.g. '*.js') or file_type (e.g. 'py', 'js'). "
            "Output modes: 'content' shows matching lines, 'files' shows file paths only, 'count' shows match counts."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regex pattern to search for.",
                },
                "cwd": {
                    "type": "string",
                    "description": "Directory to search. Defaults to /tmp/workspace.",
                },
                "glob_pattern": {
                    "type": "string",
                    "description": "Glob pattern to filter files (e.g. '*.py').",
                },
                "output_mode": {
                    "type": "string",
                    "enum": ["content", "files", "count"],
                    "description": "Output mode. Default 'content'.",
                },
                "case_insensitive": {
                    "type": "boolean",
                    "description": "Case-insensitive search. Default false.",
                },
            },
            "required": ["pattern"],
        },
    },
}

TODO_TOOL = {
    "type": "function",
    "function": {
        "name": "TodoWrite",
        "description": (
            "Create and manage a todo list for the current task. "
            "Use this to break down complex tasks, track progress, and communicate your plan to the user. "
            "Mark tasks as 'in_progress' when you start them, 'done' when complete. "
            "Only have one task 'in_progress' at a time. "
            "Use for tasks with 3+ steps, multiple components, or when you want to show your plan."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "Complete list of todos (replaces existing list).",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Unique id for this todo item."},
                            "content": {"type": "string", "description": "Description of the task."},
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "done"],
                                "description": "Current status of the task.",
                            },
                            "priority": {
                                "type": "string",
                                "enum": ["high", "medium", "low"],
                                "description": "Priority level.",
                            },
                        },
                        "required": ["id", "content", "status"],
                    },
                },
            },
            "required": ["todos"],
        },
    },
}

WEB_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "Search the internet for current, real-time information. "
            "Use this when the user asks about recent events, current prices, "
            "news, live data, or anything that may have changed after your training cutoff."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query. Be concise and specific.",
                }
            },
            "required": ["query"],
        },
    },
}

ALL_TOOLS = [BASH_TOOL, READ_TOOL, WRITE_TOOL, EDIT_TOOL, GLOB_TOOL, GREP_TOOL, TODO_TOOL, WEB_SEARCH_TOOL]

TOOL_NAMES = {t["function"]["name"] for t in ALL_TOOLS}
