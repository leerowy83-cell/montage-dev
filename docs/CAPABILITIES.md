# MontageDev AI — Full Capability Reference

## 🧠 23 Built-in Tools

### Core File & Shell Tools
| Tool | Purpose | Key Features |
|------|---------|-------------|
| `Bash` | Execute shell commands | 30s timeout, workspace isolation, all system tools |
| `Read` | Read files with line numbers | 2000 line limit, range selection, binary detection |
| `Write` | Create/overwrite files | Auto-creates parent dirs, byte count confirmation |
| `Edit` | Exact string replacement | Uniqueness validation, replace_all mode, context hints |
| `Glob` | Pattern-match file paths | Recursive, sorted by mtime, 200 result limit |
| `Grep` | Regex search across files | content/files/count modes, case-insensitive, skips node_modules |

### AI & Planning Tools
| Tool | Purpose |
|------|---------|
| `TodoWrite` | Task list management — creates, updates, tracks multi-step plans |
| `MemoryWrite` | Persistent key-value memory across conversations |
| `Task` | Spawn focused subtask agent with isolated context |

### Web & Network Tools
| Tool | Purpose |
|------|---------|
| `web_search` | Real-time web search via DuckDuckGo |
| `UrlFetch` | Fetch URLs — HTML, JSON, APIs, docs |
| `ApiCall` | Full HTTP client — GET/POST/PUT/PATCH/DELETE with headers and body |

### Code Quality Tools
| Tool | Purpose |
|------|---------|
| `FormatCode` | Format with black/prettier — Python, JS, TS, JSON, CSS, HTML, SQL |
| `LintCode` | Lint with ruff/pylint/eslint — Python, JS, TypeScript |
| `RunTests` | Run pytest/jest/vitest/go test — with coverage option |
| `SecretScan` | Detect leaked credentials, API keys, JWTs in code |

### Data & Analysis Tools
| Tool | Purpose |
|------|---------|
| `SqlQuery` | Execute SQL against SQLite databases |
| `JsonQuery` | jq-style JSON queries with path expressions |
| `RegexTest` | Test regex patterns with match visualization |
| `Diff` | Unified diff between files or inline content |

### Notebook Tools
| Tool | Purpose |
|------|---------|
| `NotebookRead` | Read Jupyter notebooks — cells, outputs, metadata |
| `NotebookEdit` | Insert, replace, delete notebook cells |

### Dev Ops Tools
| Tool | Purpose |
|------|---------|
| `GitOp` | Structured git operations — status, diff, log, commit, push, branch, merge |

---

## 🎯 Core Capabilities by Domain

### Software Engineering
- Read, understand, modify multi-file codebases
- Debug using systematic root cause analysis
- Write and run tests (pytest, jest, vitest, go test)
- Format and lint code automatically
- Refactor with precision using exact-match editing
- Search codebases with regex (Grep) and pattern matching (Glob)
- Execute any shell command (Bash)

### AI / LLM Development
- Design and implement AI features with streaming
- Understand Groq API, OpenAI API, Anthropic API
- Build RAG pipelines with pgvector
- Debug prompt engineering issues
- Optimize context window usage
- Implement tool use / function calling
- Build evaluation harnesses

### Web Development
- Full-stack: Django, FastAPI, Express, Next.js, Remix
- Frontend: React, Vue, Svelte, vanilla JS
- Styling: Tailwind CSS, CSS-in-JS, plain CSS
- Real-time: WebSockets, SSE, Supabase Realtime
- Auth: Supabase Auth, NextAuth, JWT, OAuth
- API design: REST, GraphQL, RPC

### Database & Backend
- PostgreSQL / Supabase query optimization
- Schema design and migration planning
- Row-Level Security (RLS) policy writing
- N+1 detection and fix
- Index design and EXPLAIN ANALYZE
- SQLite operations via SqlQuery tool

### DevOps & Infrastructure
- Docker multi-stage builds
- CI/CD pipeline configuration (GitHub Actions, GitLab)
- Vercel / Netlify deployment
- Environment variable management
- Secret scanning before commits
- Git workflow automation

### Security
- OWASP Top 10 awareness and prevention
- Secret scanning across codebases
- JWT verification and rotation
- SQL injection prevention
- XSS prevention
- Rate limiting patterns
- Auth flow auditing

### Data & Analysis
- JSON data extraction and transformation
- SQL queries and database inspection
- Regex pattern development and testing
- File diff and change analysis
- Log parsing and error extraction

---

## 🧬 Brain Sections (System Prompt)

1. **System Context** — Date, platform, tool inventory, MontageDev config
2. **Cyber Risk Baseline** — Security stance and limits
3. **Identity & Personality** — Direct, code-first, collaborative style
4. **Doing Tasks** — How to approach engineering work
5. **Tool Usage Philosophy** — Decision hierarchy, sequencing patterns
6. **Coding Philosophy** — Universal principles, quality standards, testing, git, security
7. **Language-Specific Best Practices** — Python, JS/TS, React, SQL/Supabase, CSS, Bash
8. **Architecture & Design Skills** — System design, API design, DB design, caching, performance, security architecture, DevOps, AI/LLM
9. **Debugging Skills** — Systematic process, error reading, common bugs, MontageDev-specific failures
10. **Domain Workflows** — Bug fix, feature, code review, refactoring, DB migration, performance, Supabase, AI
11. **Mobile & Frontend Skills** — Mobile-first, PWA, a11y, animation, state management, performance
12. **Memory & Task Planning** — MemoryWrite, task decomposition, context management, Task spawning
13. **Proactive Communication Rules** — When to act vs ask, what not to say, progress reporting

---

## 🔧 Model Configuration

| Model | Context | Best For | Speed |
|-------|---------|---------|-------|
| LLaMA 3.3 70B | 128K | Best reasoning, complex tasks | Medium |
| LLaMA 3.1 8B | 128K | Fast responses, simple tasks | Very Fast |
| LLaMA 3 70B | 8K | General purpose | Medium |
| Mixtral 8x7B | 32K | Long context, multilingual | Medium |
| Gemma 2 9B | 8K | Efficient, creative | Fast |
| LLaMA 3.2 Vision 11B | 128K | Image analysis (small) | Medium |
| LLaMA 3.2 Vision 90B | 128K | Image analysis (best) | Slow |

---

## 🛠️ Tool Usage Examples

### Investigate a bug
```
User: My Django app throws 500 on POST /api/send/
AI: [Grep for "send" in views] → [Read views.py] → [Grep for error] → [Explain fix] → [Edit file]
```

### Build a feature
```
User: Add pagination to the messages API
AI: [TodoWrite: plan] → [Read views.py] → [Edit] → [Read back] → [RunTests]
```

### Security audit
```
User: Check my codebase for security issues
AI: [SecretScan on .] → [Grep for "eval("] → [Grep for "execute("] → [Report findings]
```

### Analyze data
```
User: What's in my database?
AI: [SqlQuery: SELECT * FROM sqlite_master] → [SqlQuery: SELECT COUNT(*) ...] → [Report]
```

### Research and implement
```
User: Add Stripe payments to my app
AI: [web_search: Stripe Python SDK] → [UrlFetch: docs] → [Write stripe_service.py] → [Edit views.py]
```
