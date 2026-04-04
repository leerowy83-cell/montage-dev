# MontageDev AI

Claude Code's brain inside a Django chat app — deployed on Vercel, auth + DB on Supabase, AI on Groq.

## Deploy in 2 steps

### Step 1 — Run the SQL (once)
Open **Supabase Dashboard → SQL Editor → New Query**, paste `SUPABASE_SETUP.sql`, click Run.

### Step 2 — Push to Vercel
```bash
# From this folder
vercel --prod
```
That's it. All credentials are baked in. No env vars needed.

## What's inside

| File | Purpose |
|---|---|
| `chat/brain.py` | Claude Code system prompt — doing tasks, actions with care, tool philosophy, tone, output efficiency, cyber risk |
| `chat/tool_schemas.py` | Groq tool schemas: Bash, Read, Write, Edit, Glob, Grep, TodoWrite, web_search |
| `chat/tools_impl.py` | Python tool implementations |
| `chat/views.py` | Multi-turn agentic loop (up to 12 rounds of tool use before final answer) |
| `chat/supabase_client.py` | JWT auth + service-role minting from JWT secret (no extra keys needed) |
| `chat/db_init.py` | Auto schema creation (runs at cold-start if DATABASE_URL is set) |
| `SUPABASE_SETUP.sql` | Manual schema — run once in Supabase SQL Editor |

## Agentic loop

When Tools mode is on, the AI can call up to 12 rounds of:
`Bash → Read → Write → Edit → Glob → Grep → TodoWrite → web_search`

Each round streams tool-use and tool-result events to the browser in real time.

## URLs

| Route | Description |
|---|---|
| `/` | Chat UI |
| `/api/setup/` | DB auto-init status |
| `/api/setup/sql/` | Returns raw SQL to run in Supabase |
| `/api/conversations/` | List conversations |
| `/api/conversations/create/` | New conversation |
| `/api/conversations/<id>/send/` | Send message → SSE stream |
| `/api/conversations/<id>/claude-md/` | Get/set per-conversation instructions |
| `/api/conversations/<id>/todos/` | Get current todo list |
