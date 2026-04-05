# MontageDev AI — Extended Coding Philosophy Corpus

This file contains extended reasoning traces, anti-patterns, debugging examples,
and architectural decision logs used to train MontageDev's code intelligence.

═══════════════════════════════════════════════════════════════════════════════
PART 1: ANTI-PATTERNS AND WHY THEY FAIL
═══════════════════════════════════════════════════════════════════════════════

## Anti-Pattern 1: The God Function

BAD:
```python
def process_user_request(user_id, action, data, db, cache, mailer, logger, config):
    # validates user, checks permissions, reads from DB, updates cache,
    # sends email, logs everything, and returns response — all in one function
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        logger.warning(f"User {user_id} not found")
        return {"error": "User not found"}
    if action == "update_email":
        if not data.get("email"):
            return {"error": "Email required"}
        if "@" not in data["email"]:
            return {"error": "Invalid email"}
        old_email = user.email
        user.email = data["email"]
        db.commit()
        cache.delete(f"user:{user_id}")
        mailer.send(user.email, "Email changed", f"Your email was changed from {old_email}")
        logger.info(f"User {user_id} email updated to {data['email']}")
        return {"ok": True}
    elif action == "update_name":
        # ... 200 more lines
```

WHY IT FAILS:
- Untestable in isolation — requires all 7 dependencies to test anything
- Single change breaks unrelated behavior
- The function name lies — it does 12 things
- Adding a new action adds to an already-huge conditional chain
- Business logic tangled with infrastructure concerns

GOOD:
```python
# Separate concerns into focused functions
def get_user_or_404(user_id: str, db: Session) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise NotFound(f"User {user_id}")
    return user

def validate_email(email: str) -> None:
    if not email or "@" not in email:
        raise ValidationError("Valid email required")

def update_user_email(user: User, new_email: str, db: Session) -> None:
    validate_email(new_email)
    old_email = user.email
    user.email = new_email
    db.commit()
    return old_email

# In the view/controller:
def handle_update_email(user_id: str, data: dict, db: Session, events: EventBus):
    user = get_user_or_404(user_id, db)
    old_email = update_user_email(user, data.get("email", ""), db)
    events.emit("user.email_changed", {"user_id": user_id, "old": old_email, "new": user.email})
    return {"ok": True}
```

WHY IT'S BETTER:
- Each function does exactly one thing and can be tested alone
- Events decouple email sending from email updating
- Validation is reusable
- Adding new user actions doesn't touch existing code


## Anti-Pattern 2: The Mysterious Boolean

BAD:
```python
def render_user(user, True, False, True):
    ...

def create_file(path, True):
    ...

send_email(user, True, False)
```

WHY IT FAILS:
- Call sites are unreadable — what do True/False mean?
- Boolean parameters often indicate the function does two things
- Adding a third option requires a breaking change

GOOD:
```python
def render_user(user, *, show_avatar: bool = True, is_admin_view: bool = False):
    ...

def create_file(path, *, overwrite: bool = False):
    ...

send_email(user, include_unsubscribe_link=True, is_transactional=False)

# Or use an enum when behavior diverges:
class EmailType(Enum):
    TRANSACTIONAL = "transactional"
    MARKETING = "marketing"

send_email(user, email_type=EmailType.TRANSACTIONAL)
```


## Anti-Pattern 3: Stringly Typed Code

BAD:
```python
user.role = "admni"  # typo — won't be caught until runtime
if user.role == "admin":
    ...

def set_status(order, status: str):
    order.status = status  # what are the valid values?
```

GOOD:
```python
from enum import Enum

class UserRole(str, Enum):
    ADMIN = "admin"
    EDITOR = "editor"
    VIEWER = "viewer"

class OrderStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    SHIPPED = "shipped"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"

user.role = UserRole.ADMIN  # typos caught at import time
if user.role == UserRole.ADMIN:
    ...

def set_status(order: Order, status: OrderStatus) -> None:
    order.status = status
    # IDE completes valid values, type checker validates
```


## Anti-Pattern 4: Swallowed Exceptions

BAD:
```python
try:
    result = do_something_risky()
except:
    pass  # 🔥 worst line in Python

try:
    user = get_user(user_id)
except Exception as e:
    print(e)  # prints and continues with user = None?
    user = None
```

WHY IT FAILS:
- Silently hides bugs that should crash
- Makes debugging impossible — no stack trace
- Caller gets None/None back and fails mysteriously elsewhere

GOOD:
```python
# Catch what you can handle. Let the rest propagate.
try:
    result = fetch_from_cache(key)
except CacheMiss:
    result = fetch_from_db(key)
    cache.set(key, result)
except CacheConnectionError:
    logger.warning("Cache unavailable, falling back to DB")
    result = fetch_from_db(key)
# Other exceptions propagate — they're bugs, let them crash loudly

# In Django views, unhandled exceptions return 500 (good! you'll see them in Sentry)
```


## Anti-Pattern 5: N+1 Query

BAD:
```python
# Django view
conversations = Conversation.objects.filter(user=user)
for conv in conversations:
    print(conv.title, conv.messages.count())  # N+1: 1 query for convs + N for messages
```

GOOD:
```python
# Annotate with count in a single query
from django.db.models import Count

conversations = (
    Conversation.objects
    .filter(user=user)
    .annotate(message_count=Count('messages'))
    .order_by('-updated_at')
)
for conv in conversations:
    print(conv.title, conv.message_count)  # No extra queries
```


## Anti-Pattern 6: Mutation of Function Arguments

BAD:
```python
def process_items(items: list) -> list:
    items.append(sentinel_item)  # mutates caller's list!
    for i, item in enumerate(items):
        items[i] = transform(item)  # mutates while iterating
    return items

def merge_configs(base: dict, overrides: dict) -> dict:
    base.update(overrides)  # destroys base config for caller
    return base
```

GOOD:
```python
def process_items(items: list) -> list:
    return [transform(item) for item in items] + [sentinel_item]

def merge_configs(base: dict, overrides: dict) -> dict:
    return {**base, **overrides}  # new dict, originals untouched
```


## Anti-Pattern 7: Magic Numbers

BAD:
```python
if len(password) < 8:
    raise ValueError("Too short")

time.sleep(0.5)

if user.plan_id in [1, 2, 3]:
    enable_premium_features()

max_retries = 3
for i in range(3):  # should be max_retries
    ...
```

GOOD:
```python
MIN_PASSWORD_LENGTH = 8
CACHE_WARM_DELAY_SECONDS = 0.5
PREMIUM_PLAN_IDS = frozenset({1, 2, 3})
MAX_API_RETRIES = 3

if len(password) < MIN_PASSWORD_LENGTH:
    raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")

time.sleep(CACHE_WARM_DELAY_SECONDS)

if user.plan_id in PREMIUM_PLAN_IDS:
    enable_premium_features()

for attempt in range(MAX_API_RETRIES):
    ...
```


## Anti-Pattern 8: Pyramid of Doom

BAD:
```python
def process(request):
    if request.user:
        if request.user.is_authenticated:
            if request.user.has_permission("write"):
                if request.data:
                    if validate(request.data):
                        result = save(request.data)
                        if result:
                            return {"ok": True, "id": result.id}
                        else:
                            return {"error": "Save failed"}
                    else:
                        return {"error": "Invalid data"}
                else:
                    return {"error": "No data"}
            else:
                return {"error": "No permission"}
        else:
            return {"error": "Not authenticated"}
    else:
        return {"error": "No user"}
```

GOOD — guard clauses flatten the pyramid:
```python
def process(request):
    if not request.user:
        return {"error": "No user"}
    if not request.user.is_authenticated:
        return {"error": "Not authenticated"}
    if not request.user.has_permission("write"):
        return {"error": "No permission"}
    if not request.data:
        return {"error": "No data"}
    if not validate(request.data):
        return {"error": "Invalid data"}

    result = save(request.data)
    if not result:
        return {"error": "Save failed"}

    return {"ok": True, "id": result.id}
```


═══════════════════════════════════════════════════════════════════════════════
PART 2: DEBUGGING DECISION TREES
═══════════════════════════════════════════════════════════════════════════════

## Decision Tree: HTTP 500 in Django

```
500 Internal Server Error
│
├─ Check DEBUG=True in dev?
│   ├─ YES → Read the traceback shown in browser
│   └─ NO → Check server logs (journalctl, Vercel logs, etc.)
│
├─ Is it a database error?
│   ├─ OperationalError: no such table → Run migrations
│   ├─ IntegrityError: UNIQUE constraint → Duplicate data, check constraints
│   ├─ ProgrammingError → ORM query syntax error
│   └─ OperationalError: too many connections → Connection pool exhausted
│
├─ Is it a template error?
│   ├─ TemplateSyntaxError → Fix template tag syntax
│   └─ TemplateDoesNotExist → Check DIRS and APP_DIRS in TEMPLATES setting
│
├─ Is it an import error?
│   └─ Run: python manage.py check → Shows all configuration errors
│
└─ Is it a custom code error?
    └─ Read the stack trace bottom-up. Find YOUR file in the trace.
```

## Decision Tree: React Component Not Updating

```
Component Not Re-rendering
│
├─ Is state actually changing?
│   └─ Add console.log in setState callback or useEffect
│
├─ Mutating state directly?
│   ├─ arr.push(item) → Should be setArr([...arr, item])
│   └─ obj.key = val → Should be setObj({...obj, key: val})
│
├─ useEffect not running?
│   ├─ Missing dependencies in dependency array
│   ├─ Adding deps causes infinite loop → Logic error in effect
│   └─ [] means run once — correct for mount-only effects
│
├─ Parent not passing new props?
│   └─ Check if parent is re-rendering — add console.log there
│
└─ Component memoized?
    ├─ React.memo: shallow comparison — check if props are new references
    └─ useMemo/useCallback: check dependency arrays
```

## Decision Tree: SQL Query Too Slow

```
Slow Query
│
├─ Run EXPLAIN ANALYZE <your query>
│   └─ Look for: Seq Scan (bad on large tables), high Actual Rows, high cost
│
├─ Seq Scan on large table?
│   └─ CREATE INDEX ON table(column_in_where_clause)
│
├─ Join returning too many rows before filtering?
│   └─ Filter earlier — move WHERE conditions, use subquery
│
├─ N+1 pattern?
│   ├─ Python: use select_related() / prefetch_related()
│   └─ Raw SQL: use JOIN instead of separate queries in a loop
│
├─ Fetching too many columns?
│   └─ SELECT only columns you need: SELECT id, name vs SELECT *
│
├─ No LIMIT on large table?
│   └─ Always paginate. Add LIMIT and OFFSET or cursor-based pagination.
│
└─ Still slow after indexing?
    ├─ Check index usage: EXPLAIN shows "Index Scan" vs "Seq Scan"
    ├─ Partial index: CREATE INDEX ... WHERE status = 'active'
    └─ Covering index: include all columns in SELECT
```


═══════════════════════════════════════════════════════════════════════════════
PART 3: ARCHITECTURE DECISION RECORDS (ADRs)
═══════════════════════════════════════════════════════════════════════════════

## ADR-001: SSE vs WebSocket vs Polling for Streaming AI Responses

### Context
MontageDev AI needs to stream partial responses from Groq to the browser.
Three options: Server-Sent Events (SSE), WebSocket, or long-polling.

### Decision: Server-Sent Events (SSE)

### Rationale

**SSE chosen because:**
- One-directional: server → browser. AI responses are unidirectional.
- Works over HTTP/1.1 and HTTP/2. No special infrastructure.
- Browser auto-reconnects on connection drop.
- Django supports via StreamingHttpResponse.
- Built-in with standard fetch() API — no library needed.

**WebSocket rejected because:**
- Bidirectional — overkill for one-way streaming.
- Requires connection upgrade handshake (slightly more latency).
- Vercel serverless doesn't support persistent WebSocket connections.
- More complex state management (connection lifecycle).

**Polling rejected because:**
- High latency (poll interval creates delay).
- Wastes bandwidth and server resources.
- Complex to implement properly (tracking position, handling gaps).

### SSE Implementation Notes
```python
# Django
def stream_view(request):
    def event_stream():
        yield 'data: {"type": "ping"}

'  # keepalive immediately
        for chunk in generate_response():
            yield f'data: {json.dumps({"type": "token", "text": chunk})}

'
        yield 'data: {"type": "done"}

'
    
    resp = StreamingHttpResponse(event_stream(), content_type='text/event-stream')
    resp['Cache-Control'] = 'no-cache'
    resp['X-Accel-Buffering'] = 'no'  # Disable nginx buffering!
    return resp

# JavaScript
const res = await fetch('/api/stream/');
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('

');
    buffer = lines.pop();
    for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));
        handleEvent(event);
    }
}
```

### Known Issues
- Vercel serverless functions timeout at 10-60 seconds.
  Solution: Yield a `ping` immediately. For long AI responses, consider edge functions.
- nginx buffers by default: add `X-Accel-Buffering: no` header.
- iOS Safari has SSE quirks — use EventSource polyfill if targeting.


## ADR-002: JWT Authentication via Supabase

### Context
MontageDev needs user authentication for conversation storage.
Options: Session-based, JWT, API keys.

### Decision: Supabase Auth JWT

### Rationale
- Users already have Supabase projects — zero extra setup.
- JWT is stateless: backend verifies without a DB query.
- Supabase handles registration, email verification, OAuth.
- Row-Level Security (RLS) allows DB-level auth enforcement.
- Token refresh handled automatically by Supabase JS client.

### Implementation
```python
# Backend: verify JWT on every request
from jose import jwt, JWTError

def verify_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(
            token,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
        return payload
    except JWTError:
        return None

def auth_required(view_func):
    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return JsonResponse({"error": "Unauthorized"}, status=401)
        payload = verify_token(auth[7:])
        if not payload:
            return JsonResponse({"error": "Invalid token"}, status=401)
        request.token = auth[7:]
        request.user_id = payload["sub"]
        return view_func(request, *args, **kwargs)
    return wrapper
```

```javascript
// Frontend: include token in every request
const { data: { session } } = await supabase.auth.getSession();
const token = session?.access_token;

// On 401, refresh:
supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'TOKEN_REFRESHED') {
        tok = session.access_token;
    }
});
```

### Token Expiry Handling
Supabase tokens expire every 1 hour. The JS client auto-refreshes.
When the backend returns 401:
1. Client calls supabase.auth.refreshSession()
2. Waits for new token via onAuthStateChange
3. Retries the failed request

---

## ADR-003: Per-Conversation Workspace Isolation

### Context
MontageDev AI runs Bash commands and writes files. Users shouldn't affect each other.

### Decision: Per-conversation directory in /tmp

### Implementation
```python
WORKSPACE_BASE = "/tmp/montagedev_workspaces"

def _workspace(conversation_id: str) -> str:
    d = os.path.join(WORKSPACE_BASE, str(conversation_id)[:8])
    os.makedirs(d, exist_ok=True)
    return d
```

### Tradeoffs
- ✅ Simple, zero-config isolation
- ✅ Automatic cleanup when /tmp is cleared (serverless cold starts)
- ✅ No cross-user file access
- ❌ Files lost on server restart / cold start
- ❌ Not suitable for large files or long-term storage
- ❌ On multi-instance deployments, different requests may hit different /tmp

### For Persistent Storage
Instruct AI to write files and tell user to download via the download button,
or write output to Supabase Storage for true persistence.


═══════════════════════════════════════════════════════════════════════════════
PART 4: LANGUAGE IDIOMS REFERENCE
═══════════════════════════════════════════════════════════════════════════════

## Python Idioms

### Unpacking
```python
# Bad
first = items[0]
second = items[1]
rest = items[2:]

# Good
first, second, *rest = items

# Swap without temp
a, b = b, a

# Unpack dict
config = {"host": "localhost", "port": 5432}
host, port = config["host"], config["port"]
# Or: host = config.get("host", "localhost")
```

### Context Managers
```python
# Any resource that needs cleanup: files, DB connections, locks, timing
with open(path) as f:
    data = f.read()

# Custom context manager
from contextlib import contextmanager

@contextmanager
def timer(label: str):
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed = time.perf_counter() - start
        print(f"{label}: {elapsed:.3f}s")

with timer("db query"):
    results = db.execute(query)
```

### Generator Expressions
```python
# Bad: builds entire list in memory
total = sum([x ** 2 for x in range(1_000_000)])

# Good: streams values
total = sum(x ** 2 for x in range(1_000_000))

# Bad: double iteration
emails = [u.email for u in users if u.email]

# Good: filter during iteration  
emails = (u.email for u in users if u.email)
```

### Dataclasses vs Dicts
```python
# Bad: dict with no type safety
user = {"id": "123", "emal": "x@y.com"}  # typo not caught
print(user["email"])  # KeyError at runtime

# Good: dataclass with type safety
from dataclasses import dataclass

@dataclass
class User:
    id: str
    email: str
    role: str = "viewer"

user = User(id="123", email="x@y.com")
print(user.email)  # IDE autocompletes, typo caught by type checker
```

### TypedDict for JSON-like structures
```python
from typing import TypedDict

class ConversationData(TypedDict):
    id: str
    title: str
    user_id: str
    created_at# MontageDev AI — Extended Coding Philosophy Corpus

This file contains extended reasoning traces, anti-patterns, debugging examples,
and architectural decision logs used to train MontageDev's code intelligence.

═══════════════════════════════════════════════════════════════════════════════
PART 1: ANTI-PATTERNS AND WHY THEY FAIL
═══════════════════════════════════════════════════════════════════════════════

## Anti-Pattern 1: The God Function

BAD:
```python
def process_user_request(user_id, action, data, db, cache, mailer, logger, config):
    # validates user, checks permissions, reads from DB, updates cache,
    # sends email, logs everything, and returns response — all in one function
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        logger.warning(f"User {user_id} not found")
        return {"error": "User not found"}
    if action == "update_email":
        if not data.get("email"):
            return {"error": "Email required"}
        if "@" not in data["email"]:
            return {"error": "Invalid email"}
        old_email = user.email
        user.email = data["email"]
        db.commit()
        cache.delete(f"user:{user_id}")
        mailer.send(user.email, "Email changed", f"Your email was changed from {old_email}")
        logger.info(f"User {user_id} email updated to {data['email']}")
        return {"ok": True}
    elif action == "update_name":
        # ... 200 more lines
```

WHY IT FAILS:
- Untestable in isolation — requires all 7 dependencies to test anything
- Single change breaks unrelated behavior
- The function name lies — it does 12 things
- Adding a new action adds to an already-huge conditional chain
- Business logic tangled with infrastructure concerns

GOOD:
```python
# Separate concerns into focused functions
def get_user_or_404(user_id: str, db: Session) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise NotFound(f"User {user_id}")
    return user

def validate_email(email: str) -> None:
    if not email or "@" not in email:
        raise ValidationError("Valid email required")

def update_user_email(user: User, new_email: str, db: Session) -> None:
    validate_email(new_email)
    old_email = user.email
    user.email = new_email
    db.commit()
    return old_email

# In the view/controller:
def handle_update_email(user_id: str, data: dict, db: Session, events: EventBus):
    user = get_user_or_404(user_id, db)
    old_email = update_user_email(user, data.get("email", ""), db)
    events.emit("user.email_changed", {"user_id": user_id, "old": old_email, "new": user.email})
    return {"ok": True}
```

WHY IT'S BETTER:
- Each function does exactly one thing and can be tested alone
- Events decouple email sending from email updating
- Validation is reusable
- Adding new user actions doesn't touch existing code


## Anti-Pattern 2: The Mysterious Boolean

BAD:
```python
def render_user(user, True, False, True):
    ...

def create_file(path, True):
    ...

send_email(user, True, False)
```

WHY IT FAILS:
- Call sites are unreadable — what do True/False mean?
- Boolean parameters often indicate the function does two things
- Adding a third option requires a breaking change

GOOD:
```python
def render_user(user, *, show_avatar: bool = True, is_admin_view: bool = False):
    ...

def create_file(path, *, overwrite: bool = False):
    ...

send_email(user, include_unsubscribe_link=True, is_transactional=False)

# Or use an enum when behavior diverges:
class EmailType(Enum):
    TRANSACTIONAL = "transactional"
    MARKETING = "marketing"

send_email(user, email_type=EmailType.TRANSACTIONAL)
```


## Anti-Pattern 3: Stringly Typed Code

BAD:
```python
user.role = "admni"  # typo — won't be caught until runtime
if user.role == "admin":
    ...

def set_status(order, status: str):
    order.status = status  # what are the valid values?
```

GOOD:
```python
from enum import Enum

class UserRole(str, Enum):
    ADMIN = "admin"
    EDITOR = "editor"
    VIEWER = "viewer"

class OrderStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    SHIPPED = "shipped"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"

user.role = UserRole.ADMIN  # typos caught at import time
if user.role == UserRole.ADMIN:
    ...

def set_status(order: Order, status: OrderStatus) -> None:
    order.status = status
    # IDE completes valid values, type checker validates
```


## Anti-Pattern 4: Swallowed Exceptions

BAD:
```python
try:
    result = do_something_risky()
except:
    pass  # 🔥 worst line in Python

try:
    user = get_user(user_id)
except Exception as e:
    print(e)  # prints and continues with user = None?
    user = None
```

WHY IT FAILS:
- Silently hides bugs that should crash
- Makes debugging impossible — no stack trace
- Caller gets None/None back and fails mysteriously elsewhere

GOOD:
```python
# Catch what you can handle. Let the rest propagate.
try:
    result = fetch_from_cache(key)
except CacheMiss:
    result = fetch_from_db(key)
    cache.set(key, result)
except CacheConnectionError:
    logger.warning("Cache unavailable, falling back to DB")
    result = fetch_from_db(key)
# Other exceptions propagate — they're bugs, let them crash loudly

# In Django views, unhandled exceptions return 500 (good! you'll see them in Sentry)
```


## Anti-Pattern 5: N+1 Query

BAD:
```python
# Django view
conversations = Conversation.objects.filter(user=user)
for conv in conversations:
    print(conv.title, conv.messages.count())  # N+1: 1 query for convs + N for messages
```

GOOD:
```python
# Annotate with count in a single query
from django.db.models import Count

conversations = (
    Conversation.objects
    .filter(user=user)
    .annotate(message_count=Count('messages'))
    .order_by('-updated_at')
)
for conv in conversations:
    print(conv.title, conv.message_count)  # No extra queries
```


## Anti-Pattern 6: Mutation of Function Arguments

BAD:
```python
def process_items(items: list) -> list:
    items.append(sentinel_item)  # mutates caller's list!
    for i, item in enumerate(items):
        items[i] = transform(item)  # mutates while iterating
    return items

def merge_configs(base: dict, overrides: dict) -> dict:
    base.update(overrides)  # destroys base config for caller
    return base
```

GOOD:
```python
def process_items(items: list) -> list:
    return [transform(item) for item in items] + [sentinel_item]

def merge_configs(base: dict, overrides: dict) -> dict:
    return {**base, **overrides}  # new dict, originals untouched
```


## Anti-Pattern 7: Magic Numbers

BAD:
```python
if len(password) < 8:
    raise ValueError("Too short")

time.sleep(0.5)

if user.plan_id in [1, 2, 3]:
    enable_premium_features()

max_retries = 3
for i in range(3):  # should be max_retries
    ...
```

GOOD:
```python
MIN_PASSWORD_LENGTH = 8
CACHE_WARM_DELAY_SECONDS = 0.5
PREMIUM_PLAN_IDS = frozenset({1, 2, 3})
MAX_API_RETRIES = 3

if len(password) < MIN_PASSWORD_LENGTH:
    raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")

time.sleep(CACHE_WARM_DELAY_SECONDS)

if user.plan_id in PREMIUM_PLAN_IDS:
    enable_premium_features()

for attempt in range(MAX_API_RETRIES):
    ...
```


## Anti-Pattern 8: Pyramid of Doom

BAD:
```python
def process(request):
    if request.user:
        if request.user.is_authenticated:
            if request.user.has_permission("write"):
                if request.data:
                    if validate(request.data):
                        result = save(request.data)
                        if result:
                            return {"ok": True, "id": result.id}
                        else:
                            return {"error": "Save failed"}
                    else:
                        return {"error": "Invalid data"}
                else:
                    return {"error": "No data"}
            else:
                return {"error": "No permission"}
        else:
            return {"error": "Not authenticated"}
    else:
        return {"error": "No user"}
```

GOOD — guard clauses flatten the pyramid:
```python
def process(request):
    if not request.user:
        return {"error": "No user"}
    if not request.user.is_authenticated:
        return {"error": "Not authenticated"}
    if not request.user.has_permission("write"):
        return {"error": "No permission"}
    if not request.data:
        return {"error": "No data"}
    if not validate(request.data):
        return {"error": "Invalid data"}

    result = save(request.data)
    if not result:
        return {"error": "Save failed"}

    return {"ok": True, "id": result.id}
```


═══════════════════════════════════════════════════════════════════════════════
PART 2: DEBUGGING DECISION TREES
═══════════════════════════════════════════════════════════════════════════════

## Decision Tree: HTTP 500 in Django

```
500 Internal Server Error
│
├─ Check DEBUG=True in dev?
│   ├─ YES → Read the traceback shown in browser
│   └─ NO → Check server logs (journalctl, Vercel logs, etc.)
│
├─ Is it a database error?
│   ├─ OperationalError: no such table → Run migrations
│   ├─ IntegrityError: UNIQUE constraint → Duplicate data, check constraints
│   ├─ ProgrammingError → ORM query syntax error
│   └─ OperationalError: too many connections → Connection pool exhausted
│
├─ Is it a template error?
│   ├─ TemplateSyntaxError → Fix template tag syntax
│   └─ TemplateDoesNotExist → Check DIRS and APP_DIRS in TEMPLATES setting
│
├─ Is it an import error?
│   └─ Run: python manage.py check → Shows all configuration errors
│
└─ Is it a custom code error?
    └─ Read the stack trace bottom-up. Find YOUR file in the trace.
```

## Decision Tree: React Component Not Updating

```
Component Not Re-rendering
│
├─ Is state actually changing?
│   └─ Add console.log in setState callback or useEffect
│
├─ Mutating state directly?
│   ├─ arr.push(item) → Should be setArr([...arr, item])
│   └─ obj.key = val → Should be setObj({...obj, key: val})
│
├─ useEffect not running?
│   ├─ Missing dependencies in dependency array
│   ├─ Adding deps causes infinite loop → Logic error in effect
│   └─ [] means run once — correct for mount-only effects
│
├─ Parent not passing new props?
│   └─ Check if parent is re-rendering — add console.log there
│
└─ Component memoized?
    ├─ React.memo: shallow comparison — check if props are new references
    └─ useMemo/useCallback: check dependency arrays
```

## Decision Tree: SQL Query Too Slow

```
Slow Query
│
├─ Run EXPLAIN ANALYZE <your query>
│   └─ Look for: Seq Scan (bad on large tables), high Actual Rows, high cost
│
├─ Seq Scan on large table?
│   └─ CREATE INDEX ON table(column_in_where_clause)
│
├─ Join returning too many rows before filtering?
│   └─ Filter earlier — move WHERE conditions, use subquery
│
├─ N+1 pattern?
│   ├─ Python: use select_related() / prefetch_related()
│   └─ Raw SQL: use JOIN instead of separate queries in a loop
│
├─ Fetching too many columns?
│   └─ SELECT only columns you need: SELECT id, name vs SELECT *
│
├─ No LIMIT on large table?
│   └─ Always paginate. Add LIMIT and OFFSET or cursor-based pagination.
│
└─ Still slow after indexing?
    ├─ Check index usage: EXPLAIN shows "Index Scan" vs "Seq Scan"
    ├─ Partial index: CREATE INDEX ... WHERE status = 'active'
    └─ Covering index: include all columns in SELECT
```


═══════════════════════════════════════════════════════════════════════════════
PART 3: ARCHITECTURE DECISION RECORDS (ADRs)
═══════════════════════════════════════════════════════════════════════════════

## ADR-001: SSE vs WebSocket vs Polling for Streaming AI Responses

### Context
MontageDev AI needs to stream partial responses from Groq to the browser.
Three options: Server-Sent Events (SSE), WebSocket, or long-polling.

### Decision: Server-Sent Events (SSE)

### Rationale

**SSE chosen because:**
- One-directional: server → browser. AI responses are unidirectional.
- Works over HTTP/1.1 and HTTP/2. No special infrastructure.
- Browser auto-reconnects on connection drop.
- Django supports via StreamingHttpResponse.
- Built-in with standard fetch() API — no library needed.

**WebSocket rejected because:**
- Bidirectional — overkill for one-way streaming.
- Requires connection upgrade handshake (slightly more latency).
- Vercel serverless doesn't support persistent WebSocket connections.
- More complex state management (connection lifecycle).

**Polling rejected because:**
- High latency (poll interval creates delay).
- Wastes bandwidth and server resources.
- Complex to implement properly (tracking position, handling gaps).

### SSE Implementation Notes
```python
# Django
def stream_view(request):
    def event_stream():
        yield 'data: {"type": "ping"}

'  # keepalive immediately
        for chunk in generate_response():
            yield f'data: {json.dumps({"type": "token", "text": chunk})}

'
        yield 'data: {"type": "done"}

'
    
    resp = StreamingHttpResponse(event_stream(), content_type='text/event-stream')
    resp['Cache-Control'] = 'no-cache'
    resp['X-Accel-Buffering'] = 'no'  # Disable nginx buffering!
    return resp

# JavaScript
const res = await fetch('/api/stream/');
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('

');
    buffer = lines.pop();
    for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));
        handleEvent(event);
    }
}
```

### Known Issues
- Vercel serverless functions timeout at 10-60 seconds.
  Solution: Yield a `ping` immediately. For long AI responses, consider edge functions.
- nginx buffers by default: add `X-Accel-Buffering: no` header.
- iOS Safari has SSE quirks — use EventSource polyfill if targeting.


## ADR-002: JWT Authentication via Supabase

### Context
MontageDev needs user authentication for conversation storage.
Options: Session-based, JWT, API keys.

### Decision: Supabase Auth JWT

### Rationale
- Users already have Supabase projects — zero extra setup.
- JWT is stateless: backend verifies without a DB query.
- Supabase handles registration, email verification, OAuth.
- Row-Level Security (RLS) allows DB-level auth enforcement.
- Token refresh handled automatically by Supabase JS client.

### Implementation
```python
# Backend: verify JWT on every request
from jose import jwt, JWTError

def verify_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(
            token,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
        return payload
    except JWTError:
        return None

def auth_required(view_func):
    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return JsonResponse({"error": "Unauthorized"}, status=401)
        payload = verify_token(auth[7:])
        if not payload:
            return JsonResponse({"error": "Invalid token"}, status=401)
        request.token = auth[7:]
        request.user_id = payload["sub"]
        return view_func(request, *args, **kwargs)
    return wrapper
```

```javascript
// Frontend: include token in every request
const { data: { session } } = await supabase.auth.getSession();
const token = session?.access_token;

// On 401, refresh:
supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'TOKEN_REFRESHED') {
        tok = session.access_token;
    }
});
```

### Token Expiry Handling
Supabase tokens expire every 1 hour. The JS client auto-refreshes.
When the backend returns 401:
1. Client calls supabase.auth.refreshSession()
2. Waits for new token via onAuthStateChange
3. Retries the failed request

---

## ADR-003: Per-Conversation Workspace Isolation

### Context
MontageDev AI runs Bash commands and writes files. Users shouldn't affect each other.

### Decision: Per-conversation directory in /tmp

### Implementation
```python
WORKSPACE_BASE = "/tmp/montagedev_workspaces"

def _workspace(conversation_id: str) -> str:
    d = os.path.join(WORKSPACE_BASE, str(conversation_id)[:8])
    os.makedirs(d, exist_ok=True)
    return d
```

### Tradeoffs
- ✅ Simple, zero-config isolation
- ✅ Automatic cleanup when /tmp is cleared (serverless cold starts)
- ✅ No cross-user file access
- ❌ Files lost on server restart / cold start
- ❌ Not suitable for large files or long-term storage
- ❌ On multi-instance deployments, different requests may hit different /tmp

### For Persistent Storage
Instruct AI to write files and tell user to download via the download button,
or write output to Supabase Storage for true persistence.


═══════════════════════════════════════════════════════════════════════════════
PART 4: LANGUAGE IDIOMS REFERENCE
═══════════════════════════════════════════════════════════════════════════════

## Python Idioms

### Unpacking
```python
# Bad
first = items[0]
second = items[1]
rest = items[2:]

# Good
first, second, *rest = items

# Swap without temp
a, b = b, a

# Unpack dict
config = {"host": "localhost", "port": 5432}
host, port = config["host"], config["port"]
# Or: host = config.get("host", "localhost")
```

### Context Managers
```python
# Any resource that needs cleanup: files, DB connections, locks, timing
with open(path) as f:
    data = f.read()

# Custom context manager
from contextlib import contextmanager

@contextmanager
def timer(label: str):
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed = time.perf_counter() - start
        print(f"{label}: {elapsed:.3f}s")

with timer("db query"):
    results = db.execute(query)
```

### Generator Expressions
```python
# Bad: builds entire list in memory
total = sum([x ** 2 for x in range(1_000_000)])

# Good: streams values
total = sum(x ** 2 for x in range(1_000_000))

# Bad: double iteration
emails = [u.email for u in users if u.email]

# Good: filter during iteration  
emails = (u.email for u in users if u.email)
```

### Dataclasses vs Dicts
```python
# Bad: dict with no type safety
user = {"id": "123", "emal": "x@y.com"}  # typo not caught
print(user["email"])  # KeyError at runtime

# Good: dataclass with type safety
from dataclasses import dataclass

@dataclass
class User:
    id: str
    email: str
    role: str = "viewer"

user = User(id="123", email="x@y.com")
print(user.email)  # IDE autocompletes, typo caught by type checker
```

### TypedDict for JSON-like structures
```python
from typing import TypedDict

class ConversationData(TypedDict):
    id: str
    title: str
    user_id: str
    created_at# MontageDev AI — Extended Coding Philosophy Corpus

This file contains extended reasoning traces, anti-patterns, debugging examples,
and architectural decision logs used to train MontageDev's code intelligence.

═══════════════════════════════════════════════════════════════════════════════
PART 1: ANTI-PATTERNS AND WHY THEY FAIL
═══════════════════════════════════════════════════════════════════════════════

## Anti-Pattern 1: The God Function

BAD:
```python
def process_user_request(user_id, action, data, db, cache, mailer, logger, config):
    # validates user, checks permissions, reads from DB, updates cache,
    # sends email, logs everything, and returns response — all in one function
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        logger.warning(f"User {user_id} not found")
        return {"error": "User not found"}
    if action == "update_email":
        if not data.get("email"):
            return {"error": "Email required"}
        if "@" not in data["email"]:
            return {"error": "Invalid email"}
        old_email = user.email
        user.email = data["email"]
        db.commit()
        cache.delete(f"user:{user_id}")
        mailer.send(user.email, "Email changed", f"Your email was changed from {old_email}")
        logger.info(f"User {user_id} email updated to {data['email']}")
        return {"ok": True}
    elif action == "update_name":
        # ... 200 more lines
```

WHY IT FAILS:
- Untestable in isolation — requires all 7 dependencies to test anything
- Single change breaks unrelated behavior
- The function name lies — it does 12 things
- Adding a new action adds to an already-huge conditional chain
- Business logic tangled with infrastructure concerns

GOOD:
```python
# Separate concerns into focused functions
def get_user_or_404(user_id: str, db: Session) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise NotFound(f"User {user_id}")
    return user

def validate_email(email: str) -> None:
    if not email or "@" not in email:
        raise ValidationError("Valid email required")

def update_user_email(user: User, new_email: str, db: Session) -> None:
    validate_email(new_email)
    old_email = user.email
    user.email = new_email
    db.commit()
    return old_email

# In the view/controller:
def handle_update_email(user_id: str, data: dict, db: Session, events: EventBus):
    user = get_user_or_404(user_id, db)
    old_email = update_user_email(user, data.get("email", ""), db)
    events.emit("user.email_changed", {"user_id": user_id, "old": old_email, "new": user.email})
    return {"ok": True}
```

WHY IT'S BETTER:
- Each function does exactly one thing and can be tested alone
- Events decouple email sending from email updating
- Validation is reusable
- Adding new user actions doesn't touch existing code


## Anti-Pattern 2: The Mysterious Boolean

BAD:
```python
def render_user(user, True, False, True):
    ...

def create_file(path, True):
    ...

send_email(user, True, False)
```

WHY IT FAILS:
- Call sites are unreadable — what do True/False mean?
- Boolean parameters often indicate the function does two things
- Adding a third option requires a breaking change

GOOD:
```python
def render_user(user, *, show_avatar: bool = True, is_admin_view: bool = False):
    ...

def create_file(path, *, overwrite: bool = False):
    ...

send_email(user, include_unsubscribe_link=True, is_transactional=False)

# Or use an enum when behavior diverges:
class EmailType(Enum):
    TRANSACTIONAL = "transactional"
    MARKETING = "marketing"

send_email(user, email_type=EmailType.TRANSACTIONAL)
```


## Anti-Pattern 3: Stringly Typed Code

BAD:
```python
user.role = "admni"  # typo — won't be caught until runtime
if user.role == "admin":
    ...

def set_status(order, status: str):
    order.status = status  # what are the valid values?
```

GOOD:
```python
from enum import Enum

class UserRole(str, Enum):
    ADMIN = "admin"
    EDITOR = "editor"
    VIEWER = "viewer"

class OrderStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    SHIPPED = "shipped"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"

user.role = UserRole.ADMIN  # typos caught at import time
if user.role == UserRole.ADMIN:
    ...

def set_status(order: Order, status: OrderStatus) -> None:
    order.status = status
    # IDE completes valid values, type checker validates
```


## Anti-Pattern 4: Swallowed Exceptions

BAD:
```python
try:
    result = do_something_risky()
except:
    pass  # 🔥 worst line in Python

try:
    user = get_user(user_id)
except Exception as e:
    print(e)  # prints and continues with user = None?
    user = None
```

WHY IT FAILS:
- Silently hides bugs that should crash
- Makes debugging impossible — no stack trace
- Caller gets None/None back and fails mysteriously elsewhere

GOOD:
```python
# Catch what you can handle. Let the rest propagate.
try:
    result = fetch_from_cache(key)
except CacheMiss:
    result = fetch_from_db(key)
    cache.set(key, result)
except CacheConnectionError:
    logger.warning("Cache unavailable, falling back to DB")
    result = fetch_from_db(key)
# Other exceptions propagate — they're bugs, let them crash loudly

# In Django views, unhandled exceptions return 500 (good! you'll see them in Sentry)
```


## Anti-Pattern 5: N+1 Query

BAD:
```python
# Django view
conversations = Conversation.objects.filter(user=user)
for conv in conversations:
    print(conv.title, conv.messages.count())  # N+1: 1 query for convs + N for messages
```

GOOD:
```python
# Annotate with count in a single query
from django.db.models import Count

conversations = (
    Conversation.objects
    .filter(user=user)
    .annotate(message_count=Count('messages'))
    .order_by('-updated_at')
)
for conv in conversations:
    print(conv.title, conv.message_count)  # No extra queries
```


## Anti-Pattern 6: Mutation of Function Arguments

BAD:
```python
def process_items(items: list) -> list:
    items.append(sentinel_item)  # mutates caller's list!
    for i, item in enumerate(items):
        items[i] = transform(item)  # mutates while iterating
    return items

def merge_configs(base: dict, overrides: dict) -> dict:
    base.update(overrides)  # destroys base config for caller
    return base
```

GOOD:
```python
def process_items(items: list) -> list:
    return [transform(item) for item in items] + [sentinel_item]

def merge_configs(base: dict, overrides: dict) -> dict:
    return {**base, **overrides}  # new dict, originals untouched
```


## Anti-Pattern 7: Magic Numbers

BAD:
```python
if len(password) < 8:
    raise ValueError("Too short")

time.sleep(0.5)

if user.plan_id in [1, 2, 3]:
    enable_premium_features()

max_retries = 3
for i in range(3):  # should be max_retries
    ...
```

GOOD:
```python
MIN_PASSWORD_LENGTH = 8
CACHE_WARM_DELAY_SECONDS = 0.5
PREMIUM_PLAN_IDS = frozenset({1, 2, 3})
MAX_API_RETRIES = 3

if len(password) < MIN_PASSWORD_LENGTH:
    raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")

time.sleep(CACHE_WARM_DELAY_SECONDS)

if user.plan_id in PREMIUM_PLAN_IDS:
    enable_premium_features()

for attempt in range(MAX_API_RETRIES):
    ...
```


## Anti-Pattern 8: Pyramid of Doom

BAD:
```python
def process(request):
    if request.user:
        if request.user.is_authenticated:
            if request.user.has_permission("write"):
                if request.data:
                    if validate(request.data):
                        result = save(request.data)
                        if result:
                            return {"ok": True, "id": result.id}
                        else:
                            return {"error": "Save failed"}
                    else:
                        return {"error": "Invalid data"}
                else:
                    return {"error": "No data"}
            else:
                return {"error": "No permission"}
        else:
            return {"error": "Not authenticated"}
    else:
        return {"error": "No user"}
```

GOOD — guard clauses flatten the pyramid:
```python
def process(request):
    if not request.user:
        return {"error": "No user"}
    if not request.user.is_authenticated:
        return {"error": "Not authenticated"}
    if not request.user.has_permission("write"):
        return {"error": "No permission"}
    if not request.data:
        return {"error": "No data"}
    if not validate(request.data):
        return {"error": "Invalid data"}

    result = save(request.data)
    if not result:
        return {"error": "Save failed"}

    return {"ok": True, "id": result.id}
```


═══════════════════════════════════════════════════════════════════════════════
PART 2: DEBUGGING DECISION TREES
═══════════════════════════════════════════════════════════════════════════════

## Decision Tree: HTTP 500 in Django

```
500 Internal Server Error
│
├─ Check DEBUG=True in dev?
│   ├─ YES → Read the traceback shown in browser
│   └─ NO → Check server logs (journalctl, Vercel logs, etc.)
│
├─ Is it a database error?
│   ├─ OperationalError: no such table → Run migrations
│   ├─ IntegrityError: UNIQUE constraint → Duplicate data, check constraints
│   ├─ ProgrammingError → ORM query syntax error
│   └─ OperationalError: too many connections → Connection pool exhausted
│
├─ Is it a template error?
│   ├─ TemplateSyntaxError → Fix template tag syntax
│   └─ TemplateDoesNotExist → Check DIRS and APP_DIRS in TEMPLATES setting
│
├─ Is it an import error?
│   └─ Run: python manage.py check → Shows all configuration errors
│
└─ Is it a custom code error?
    └─ Read the stack trace bottom-up. Find YOUR file in the trace.
```

## Decision Tree: React Component Not Updating

```
Component Not Re-rendering
│
├─ Is state actually changing?
│   └─ Add console.log in setState callback or useEffect
│
├─ Mutating state directly?
│   ├─ arr.push(item) → Should be setArr([...arr, item])
│   └─ obj.key = val → Should be setObj({...obj, key: val})
│
├─ useEffect not running?
│   ├─ Missing dependencies in dependency array
│   ├─ Adding deps causes infinite loop → Logic error in effect
│   └─ [] means run once — correct for mount-only effects
│
├─ Parent not passing new props?
│   └─ Check if parent is re-rendering — add console.log there
│
└─ Component memoized?
    ├─ React.memo: shallow comparison — check if props are new references
    └─ useMemo/useCallback: check dependency arrays
```

## Decision Tree: SQL Query Too Slow

```
Slow Query
│
├─ Run EXPLAIN ANALYZE <your query>
│   └─ Look for: Seq Scan (bad on large tables), high Actual Rows, high cost
│
├─ Seq Scan on large table?
│   └─ CREATE INDEX ON table(column_in_where_clause)
│
├─ Join returning too many rows before filtering?
│   └─ Filter earlier — move WHERE conditions, use subquery
│
├─ N+1 pattern?
│   ├─ Python: use select_related() / prefetch_related()
│   └─ Raw SQL: use JOIN instead of separate queries in a loop
│
├─ Fetching too many columns?
│   └─ SELECT only columns you need: SELECT id, name vs SELECT *
│
├─ No LIMIT on large table?
│   └─ Always paginate. Add LIMIT and OFFSET or cursor-based pagination.
│
└─ Still slow after indexing?
    ├─ Check index usage: EXPLAIN shows "Index Scan" vs "Seq Scan"
    ├─ Partial index: CREATE INDEX ... WHERE status = 'active'
    └─ Covering index: include all columns in SELECT
```


═══════════════════════════════════════════════════════════════════════════════
PART 3: ARCHITECTURE DECISION RECORDS (ADRs)
═══════════════════════════════════════════════════════════════════════════════

## ADR-001: SSE vs WebSocket vs Polling for Streaming AI Responses

### Context
MontageDev AI needs to stream partial responses from Groq to the browser.
Three options: Server-Sent Events (SSE), WebSocket, or long-polling.

### Decision: Server-Sent Events (SSE)

### Rationale

**SSE chosen because:**
- One-directional: server → browser. AI responses are unidirectional.
- Works over HTTP/1.1 and HTTP/2. No special infrastructure.
- Browser auto-reconnects on connection drop.
- Django supports via StreamingHttpResponse.
- Built-in with standard fetch() API — no library needed.

**WebSocket rejected because:**
- Bidirectional — overkill for one-way streaming.
- Requires connection upgrade handshake (slightly more latency).
- Vercel serverless doesn't support persistent WebSocket connections.
- More complex state management (connection lifecycle).

**Polling rejected because:**
- High latency (poll interval creates delay).
- Wastes bandwidth and server resources.
- Complex to implement properly (tracking position, handling gaps).

### SSE Implementation Notes
```python
# Django
def stream_view(request):
    def event_stream():
        yield 'data: {"type": "ping"}

'  # keepalive immediately
        for chunk in generate_response():
            yield f'data: {json.dumps({"type": "token", "text": chunk})}

'
        yield 'data: {"type": "done"}

'
    
    resp = StreamingHttpResponse(event_stream(), content_type='text/event-stream')
    resp['Cache-Control'] = 'no-cache'
    resp['X-Accel-Buffering'] = 'no'  # Disable nginx buffering!
    return resp

# JavaScript
const res = await fetch('/api/stream/');
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('

');
    buffer = lines.pop();
    for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));
        handleEvent(event);
    }
}
```

### Known Issues
- Vercel serverless functions timeout at 10-60 seconds.
  Solution: Yield a `ping` immediately. For long AI responses, consider edge functions.
- nginx buffers by default: add `X-Accel-Buffering: no` header.
- iOS Safari has SSE quirks — use EventSource polyfill if targeting.


## ADR-002: JWT Authentication via Supabase

### Context
MontageDev needs user authentication for conversation storage.
Options: Session-based, JWT, API keys.

### Decision: Supabase Auth JWT

### Rationale
- Users already have Supabase projects — zero extra setup.
- JWT is stateless: backend verifies without a DB query.
- Supabase handles registration, email verification, OAuth.
- Row-Level Security (RLS) allows DB-level auth enforcement.
- Token refresh handled automatically by Supabase JS client.

### Implementation
```python
# Backend: verify JWT on every request
from jose import jwt, JWTError

def verify_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(
            token,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
        return payload
    except JWTError:
        return None

def auth_required(view_func):
    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return JsonResponse({"error": "Unauthorized"}, status=401)
        payload = verify_token(auth[7:])
        if not payload:
            return JsonResponse({"error": "Invalid token"}, status=401)
        request.token = auth[7:]
        request.user_id = payload["sub"]
        return view_func(request, *args, **kwargs)
    return wrapper
```

```javascript
// Frontend: include token in every request
const { data: { session } } = await supabase.auth.getSession();
const token = session?.access_token;

// On 401, refresh:
supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'TOKEN_REFRESHED') {
        tok = session.access_token;
    }
});
```

### Token Expiry Handling
Supabase tokens expire every 1 hour. The JS client auto-refreshes.
When the backend returns 401:
1. Client calls supabase.auth.refreshSession()
2. Waits for new token via onAuthStateChange
3. Retries the failed request

---

## ADR-003: Per-Conversation Workspace Isolation

### Context
MontageDev AI runs Bash commands and writes files. Users shouldn't affect each other.

### Decision: Per-conversation directory in /tmp

### Implementation
```python
WORKSPACE_BASE = "/tmp/montagedev_workspaces"

def _workspace(conversation_id: str) -> str:
    d = os.path.join(WORKSPACE_BASE, str(conversation_id)[:8])
    os.makedirs(d, exist_ok=True)
    return d
```

### Tradeoffs
- ✅ Simple, zero-config isolation
- ✅ Automatic cleanup when /tmp is cleared (serverless cold starts)
- ✅ No cross-user file access
- ❌ Files lost on server restart / cold start
- ❌ Not suitable for large files or long-term storage
- ❌ On multi-instance deployments, different requests may hit different /tmp

### For Persistent Storage
Instruct AI to write files and tell user to download via the download button,
or write output to Supabase Storage for true persistence.


═══════════════════════════════════════════════════════════════════════════════
PART 4: LANGUAGE IDIOMS REFERENCE
═══════════════════════════════════════════════════════════════════════════════

## Python Idioms

### Unpacking
```python
# Bad
first = items[0]
second = items[1]
rest = items[2:]

# Good
first, second, *rest = items

# Swap without temp
a, b = b, a

# Unpack dict
config = {"host": "localhost", "port": 5432}
host, port = config["host"], config["port"]
# Or: host = config.get("host", "localhost")
```

### Context Managers
```python
# Any resource that needs cleanup: files, DB connections, locks, timing
with open(path) as f:
    data = f.read()

# Custom context manager
from contextlib import contextmanager

@contextmanager
def timer(label: str):
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed = time.perf_counter() - start
        print(f"{label}: {elapsed:.3f}s")

with timer("db query"):
    results = db.execute(query)
```

### Generator Expressions
```python
# Bad: builds entire list in memory
total = sum([x ** 2 for x in range(1_000_000)])

# Good: streams values
total = sum(x ** 2 for x in range(1_000_000))

# Bad: double iteration
emails = [u.email for u in users if u.email]

# Good: filter during iteration  
emails = (u.email for u in users if u.email)
```

### Dataclasses vs Dicts
```python
# Bad: dict with no type safety
user = {"id": "123", "emal": "x@y.com"}  # typo not caught
print(user["email"])  # KeyError at runtime

# Good: dataclass with type safety
from dataclasses import dataclass

@dataclass
class User:
    id: str
    email: str
    role: str = "viewer"

user = User(id="123", email="x@y.com")
print(user.email)  # IDE autocompletes, typo caught by type checker
```

### TypedDict for JSON-like structures
```python
from typing import TypedDict

class ConversationData(TypedDict):
    id: str
    title: str
    user_id: str
    created_at