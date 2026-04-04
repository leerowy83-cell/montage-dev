"""
MontageDev v2 — Views
Multi-turn agentic loop with full Claude Code tool suite.
Brain: brain.py (system prompt philosophy from Claude Code)
Tools: Bash, Read, Write, Edit, Glob, Grep, TodoWrite, web_search
"""

import json
import os
import re

from django.conf import settings
from django.http import JsonResponse, StreamingHttpResponse, HttpResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from groq import Groq

from .supabase_client import get_supabase_for_user, auth_required
from .file_processor import process_file
from .brain import build_system_prompt
from .tool_schemas import ALL_TOOLS, WEB_SEARCH_TOOL
from .tools_impl import execute_tool

GROQ_MODELS = {
    "llama-3.3-70b-versatile":      {"label": "LLaMA 3.3 70B",         "vision": False},
    "llama-3.1-8b-instant":         {"label": "LLaMA 3.1 8B (Fast)",    "vision": False},
    "llama3-70b-8192":              {"label": "LLaMA 3 70B",            "vision": False},
    "mixtral-8x7b-32768":           {"label": "Mixtral 8x7B",           "vision": False},
    "gemma2-9b-it":                 {"label": "Gemma 2 9B",             "vision": False},
    "llama-3.2-11b-vision-preview": {"label": "LLaMA 3.2 Vision 11B",  "vision": True},
    "llama-3.2-90b-vision-preview": {"label": "LLaMA 3.2 Vision 90B",  "vision": True},
}
DEFAULT_MODEL = settings.GROQ_MODEL
MAX_AGENTIC_ROUNDS = 12   # mirrors Claude Code's maxTurns default


# ─────────────────────────────────────────────────────────────────────────────
# Pages
# ─────────────────────────────────────────────────────────────────────────────

def index(request):
    context = {
        "SUPABASE_URL":      settings.SUPABASE_URL,
        "SUPABASE_ANON_KEY": settings.SUPABASE_ANON_KEY,
        "GROQ_MODELS_JSON":  json.dumps({k: v["label"] for k, v in GROQ_MODELS.items()}),
        "DEFAULT_MODEL":     DEFAULT_MODEL,
    }
    return render(request, "chat/index.html", context)


# ─────────────────────────────────────────────────────────────────────────────
# File Upload / Download
# ─────────────────────────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["POST"])
@auth_required
def upload_file(request):
    if "file" not in request.FILES:
        return JsonResponse({"error": "No file provided"}, status=400)
    f    = request.FILES["file"]
    data = f.read()
    if len(data) > 50 * 1024 * 1024:
        return JsonResponse({"error": "File too large (max 50 MB)"}, status=400)
    return JsonResponse(process_file(data, f.name))


@csrf_exempt
@require_http_methods(["POST"])
@auth_required
def download_file(request):
    body     = json.loads(request.body)
    filename = body.get("filename", "montagedev_output.txt")
    content  = body.get("content", "")
    ext      = os.path.splitext(filename.lower())[1]
    mime_map = {
        ".txt":"text/plain",".md":"text/markdown",".py":"text/x-python",
        ".js":"text/javascript",".ts":"text/typescript",".html":"text/html",
        ".css":"text/css",".json":"application/json",".csv":"text/csv",
        ".sql":"text/plain",".xml":"application/xml",".yaml":"text/yaml",
        ".yml":"text/yaml",".sh":"text/x-shellscript",
    }
    ct   = mime_map.get(ext, "text/plain")
    resp = HttpResponse(content.encode("utf-8"), content_type=ct)
    resp["Content-Disposition"] = f'attachment; filename="{filename}"'
    return resp


# ─────────────────────────────────────────────────────────────────────────────
# Export Conversation
# ─────────────────────────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["GET"])
@auth_required
def export_conversation(request, conversation_id):
    sb   = get_supabase_for_user(request.token)
    conv = sb.table("conversations").select("title").eq("id", conversation_id).execute()
    if not conv.data:
        return JsonResponse({"error": "Not found"}, status=404)
    msgs  = sb.table("messages").select("role, content, created_at").eq(
        "conversation_id", conversation_id).order("created_at").execute()
    title = conv.data[0]["title"]
    lines = [f"# {title}\n\n*Exported from MontageDev AI*\n\n---\n"]
    for m in msgs.data:
        label = "**You**" if m["role"] == "user" else "**MontageDev AI**"
        lines.append(f"{label}\n\n{m['content']}\n\n---\n")
    md    = "\n".join(lines)
    safe  = re.sub(r"[^\w\s-]", "", title)[:50].strip().replace(" ", "_")
    fname = f"{safe or 'conversation'}.md"
    resp  = HttpResponse(md.encode("utf-8"), content_type="text/markdown")
    resp["Content-Disposition"] = f'attachment; filename="{fname}"'
    return resp


# ─────────────────────────────────────────────────────────────────────────────
# Conversations
# ─────────────────────────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["GET"])
@auth_required
def list_conversations(request):
    query  = request.GET.get("q", "").strip()
    sb     = get_supabase_for_user(request.token)
    result = sb.table("conversations").select(
        "id, title, created_at, updated_at").order(
        "updated_at", desc=True).limit(200).execute()
    convs  = result.data
    if query:
        ql    = query.lower()
        convs = [c for c in convs if ql in c["title"].lower()]
    return JsonResponse({"conversations": convs})


@csrf_exempt
@require_http_methods(["POST"])
@auth_required
def create_conversation(request):
    sb     = get_supabase_for_user(request.token)
    result = sb.table("conversations").insert(
        {"user_id": request.user_id, "title": "New Chat"}).execute()
    return JsonResponse({"conversation": result.data[0]})


@csrf_exempt
@require_http_methods(["PATCH"])
@auth_required
def update_conversation(request, conversation_id):
    body  = json.loads(request.body)
    title = body.get("title", "Untitled")
    sb    = get_supabase_for_user(request.token)
    sb.table("conversations").update({"title": title}).eq("id", conversation_id).execute()
    return JsonResponse({"ok": True})


@csrf_exempt
@require_http_methods(["DELETE"])
@auth_required
def delete_conversation(request, conversation_id):
    sb = get_supabase_for_user(request.token)
    sb.table("conversations").delete().eq("id", conversation_id).execute()
    return JsonResponse({"ok": True})


# ─────────────────────────────────────────────────────────────────────────────
# Messages
# ─────────────────────────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["GET"])
@auth_required
def list_messages(request, conversation_id):
    sb     = get_supabase_for_user(request.token)
    result = sb.table("messages").select("id, role, content, created_at").eq(
        "conversation_id", conversation_id).order("created_at").execute()
    return JsonResponse({"messages": result.data})


@csrf_exempt
@require_http_methods(["POST"])
@auth_required
def send_message(request, conversation_id):
    """
    Multi-turn agentic loop — mirrors Claude Code's query.ts runTools() logic.
    Body: { content, model, files, enable_search, enable_tools }
    Returns: SSE stream with typed events.
    """
    body           = json.loads(request.body)
    user_content   = body.get("content", "").strip()
    selected_model = body.get("model") or DEFAULT_MODEL
    files          = body.get("files", [])
    enable_search  = body.get("enable_search", False)
    enable_tools   = body.get("enable_tools", True)   # full tool suite on by default

    if not user_content and not files:
        return JsonResponse({"error": "Empty message"}, status=400)
    if selected_model not in GROQ_MODELS:
        selected_model = DEFAULT_MODEL

    sb   = get_supabase_for_user(request.token)
    # Try fetching with claude_md; fall back if column doesn't exist yet
    try:
        conv = sb.table("conversations").select("id, title, claude_md").eq(
            "id", conversation_id).execute()
    except Exception:
        conv = sb.table("conversations").select("id, title").eq(
            "id", conversation_id).execute()
    if not conv.data:
        return JsonResponse({"error": "Conversation not found"}, status=404)

    conv_data = conv.data[0]

    # Save user message
    sb.table("messages").insert({
        "conversation_id": conversation_id,
        "user_id": request.user_id,
        "role": "user",
        "content": user_content or "[File upload]",
    }).execute()

    # Auto-title
    if conv_data["title"] == "New Chat":
        first_text  = user_content or (files[0]["filename"] if files else "New Chat")
        short_title = first_text[:60].rstrip() + ("…" if len(first_text) > 60 else "")
        sb.table("conversations").update({"title": short_title}).eq(
            "id", conversation_id).execute()

    # Load todos from Supabase (safe — table may not exist yet)
    try:
        todos_result = sb.table("todos").select("items").eq(
            "conversation_id", conversation_id).execute()
        current_todos = todos_result.data[0]["items"] if todos_result.data else []
    except Exception:
        current_todos = []

    # Build history (last 40 msgs)
    hist_raw = sb.table("messages").select("role, content").eq(
        "conversation_id", conversation_id).order("created_at").limit(40).execute().data
    history  = [{"role": m["role"], "content": m["content"]} for m in hist_raw]

    # Enrich last user turn with file context
    groq_content = _build_groq_content(user_content, files, selected_model)
    if history and history[-1]["role"] == "user":
        history[-1]["content"] = groq_content

    # Build system prompt — Claude Code brain
    system_prompt = build_system_prompt(
        tool_names=[t["function"]["name"] for t in ALL_TOOLS],
        claude_md=conv_data.get("claude_md"),
        todos=current_todos or None,
    )

    # Tool selection
    if enable_tools:
        tools = ALL_TOOLS
    elif enable_search:
        tools = [WEB_SEARCH_TOOL]
    else:
        tools = []

    # Capture for closure
    _token   = request.token
    _user_id = request.user_id
    _conv_id = str(conversation_id)

    def stream_response():
        client     = Groq(api_key=settings.GROQ_API_KEY)
        full_reply = []
        todos      = list(current_todos)
        _sb        = get_supabase_for_user(_token)

        try:
            messages = [{"role": "system", "content": system_prompt}] + history

            # ── Multi-turn agentic loop (mirrors query.ts runTools()) ──────────
            for round_num in range(MAX_AGENTIC_ROUNDS):
                kw = dict(
                    model=selected_model,
                    messages=messages,
                    max_tokens=4096,
                    temperature=0.7,
                    stream=False,
                )
                if tools:
                    kw["tools"]       = tools
                    kw["tool_choice"] = "auto"

                response    = client.chat.completions.create(**kw)
                assistant_msg = response.choices[0].message

                # ── No tool calls → final answer ───────────────────────────
                if not getattr(assistant_msg, "tool_calls", None):
                    yield "data: {\"type\": \"start\"}\n\n"
                    text = assistant_msg.content or ""
                    for i in range(0, len(text), 8):
                        piece = text[i:i+8]
                        full_reply.append(piece)
                        yield "data: " + json.dumps({"type": "token", "text": piece}) + "\n\n"
                    break

                # ── Tool calls → execute each, inject results, loop ────────
                tool_calls   = assistant_msg.tool_calls
                tool_results = []
                active_tool_names = []

                for tc in tool_calls:
                    fn_name = tc.function.name
                    active_tool_names.append(fn_name)
                    try:
                        fn_args = json.loads(tc.function.arguments)
                    except Exception:
                        fn_args = {}

                    # Stream tool-use event to browser
                    yield "data: " + json.dumps({
                        "type":    "tool_use",
                        "tool":    fn_name,
                        "args":    fn_args,
                        "call_id": tc.id,
                    }) + "\n\n"

                    # Execute
                    result_str, todos = execute_tool(
                        fn_name, fn_args,
                        conversation_id=_conv_id,
                        current_todos=todos,
                    )

                    # Stream tool result to browser
                    yield "data: " + json.dumps({
                        "type":    "tool_result",
                        "tool":    fn_name,
                        "result":  result_str[:500],   # preview only
                        "call_id": tc.id,
                    }) + "\n\n"

                    tool_results.append({
                        "role":         "tool",
                        "tool_call_id": tc.id,
                        "content":      result_str,
                    })

                    # Persist updated todos
                    if fn_name == "TodoWrite":
                        existing = _sb.table("todos").select("id").eq(
                            "conversation_id", _conv_id).execute()
                        if existing.data:
                            _sb.table("todos").update({"items": todos}).eq(
                                "conversation_id", _conv_id).execute()
                        else:
                            _sb.table("todos").insert({
                                "conversation_id": _conv_id,
                                "user_id": _user_id,
                                "items": todos,
                            }).execute()

                # Append assistant turn + tool results to messages for next round
                messages.append(assistant_msg)
                messages.extend(tool_results)

                # Special: if search happened, tell browser
                search_queries = [
                    json.loads(tc.function.arguments).get("query", "")
                    for tc in tool_calls
                    if tc.function.name == "web_search"
                ]
                if search_queries:
                    yield "data: " + json.dumps({"type": "search", "queries": search_queries}) + "\n\n"

            else:
                # Exhausted rounds — ask model for a final summary
                messages.append({"role": "user", "content":
                    "[System: max tool rounds reached. Summarize what you found and any remaining steps.]"})
                yield "data: {\"type\": \"start\"}\n\n"
                final = client.chat.completions.create(
                    model=selected_model, messages=messages, max_tokens=1024, temperature=0.5, stream=False
                )
                text = final.choices[0].message.content or ""
                for i in range(0, len(text), 8):
                    piece = text[i:i+8]
                    full_reply.append(piece)
                    yield "data: " + json.dumps({"type": "token", "text": piece}) + "\n\n"

            # Persist full assistant reply
            complete = "".join(full_reply)
            if complete:
                _sb.table("messages").insert({
                    "conversation_id": _conv_id,
                    "user_id":         _user_id,
                    "role":            "assistant",
                    "content":         complete,
                }).execute()

            yield "data: {\"type\": \"done\"}\n\n"

        except Exception as e:
            yield "data: " + json.dumps({"type": "error", "message": str(e)}) + "\n\n"

    resp = StreamingHttpResponse(stream_response(), content_type="text/event-stream")
    resp["Cache-Control"]     = "no-cache"
    resp["X-Accel-Buffering"] = "no"
    return resp


@csrf_exempt
@require_http_methods(["POST"])
@auth_required
def regenerate_message(request, conversation_id):
    body           = json.loads(request.body)
    selected_model = body.get("model") or DEFAULT_MODEL

    sb   = get_supabase_for_user(request.token)
    last = sb.table("messages").select("id, role").eq(
        "conversation_id", conversation_id).order(
        "created_at", desc=True).limit(1).execute().data
    if not last or last[0]["role"] != "assistant":
        return JsonResponse({"error": "Nothing to regenerate"}, status=400)
    sb.table("messages").delete().eq("id", last[0]["id"]).execute()

    history = [{"role": m["role"], "content": m["content"]} for m in
               sb.table("messages").select("role, content").eq(
                   "conversation_id", conversation_id).order(
                   "created_at").limit(40).execute().data]

    try:
        _c = sb.table("conversations").select("claude_md").eq("id", conversation_id).execute()
        claude_md = _c.data[0].get("claude_md") if _c.data else None
    except Exception:
        claude_md = None
    system_prompt = build_system_prompt(tool_names=[], claude_md=claude_md)

    _token = request.token; _user_id = request.user_id; _conv_id = str(conversation_id)

    def stream_response():
        client = Groq(api_key=settings.GROQ_API_KEY); full_reply = []; _sb = get_supabase_for_user(_token)
        try:
            yield "data: {\"type\": \"start\"}\n\n"
            msgs = [{"role": "system", "content": system_prompt}] + history
            resp = client.chat.completions.create(model=selected_model, messages=msgs,
                max_tokens=4096, temperature=0.8, stream=False)
            text = resp.choices[0].message.content or ""
            for i in range(0, len(text), 8):
                piece = text[i:i+8]; full_reply.append(piece)
                yield "data: " + json.dumps({"type": "token", "text": piece}) + "\n\n"
            _sb.table("messages").insert({"conversation_id": _conv_id, "user_id": _user_id,
                "role": "assistant", "content": "".join(full_reply)}).execute()
            yield "data: {\"type\": \"done\"}\n\n"
        except Exception as e:
            yield "data: " + json.dumps({"type": "error", "message": str(e)}) + "\n\n"

    resp = StreamingHttpResponse(stream_response(), content_type="text/event-stream")
    resp["Cache-Control"] = "no-cache"; resp["X-Accel-Buffering"] = "no"
    return resp


@csrf_exempt
@require_http_methods(["POST"])
@auth_required
def edit_message(request, conversation_id):
    body        = json.loads(request.body)
    message_id  = body.get("message_id")
    new_content = body.get("content", "").strip()
    model       = body.get("model") or DEFAULT_MODEL
    if not new_content or not message_id:
        return JsonResponse({"error": "Missing fields"}, status=400)

    sb     = get_supabase_for_user(request.token)
    target = sb.table("messages").select("id, created_at").eq("id", message_id).execute().data
    if not target:
        return JsonResponse({"error": "Message not found"}, status=404)
    created_at = target[0]["created_at"]
    sb.table("messages").delete().eq("conversation_id", conversation_id).gte(
        "created_at", created_at).execute()
    sb.table("messages").insert({"conversation_id": conversation_id,
        "user_id": request.user_id, "role": "user", "content": new_content}).execute()

    history = [{"role": m["role"], "content": m["content"]} for m in
               sb.table("messages").select("role, content").eq(
                   "conversation_id", conversation_id).order(
                   "created_at").limit(40).execute().data]

    try:
        _c = sb.table("conversations").select("claude_md").eq("id", conversation_id).execute()
        claude_md = _c.data[0].get("claude_md") if _c.data else None
    except Exception:
        claude_md = None
    system_prompt = build_system_prompt(tool_names=[], claude_md=claude_md)

    _token = request.token; _user_id = request.user_id; _conv_id = str(conversation_id)

    def stream_response():
        client = Groq(api_key=settings.GROQ_API_KEY); full_reply = []; _sb = get_supabase_for_user(_token)
        try:
            yield "data: {\"type\": \"start\"}\n\n"
            msgs = [{"role": "system", "content": system_prompt}] + history
            resp = client.chat.completions.create(model=model, messages=msgs,
                max_tokens=4096, temperature=0.7, stream=False)
            text = resp.choices[0].message.content or ""
            for i in range(0, len(text), 8):
                piece = text[i:i+8]; full_reply.append(piece)
                yield "data: " + json.dumps({"type": "token", "text": piece}) + "\n\n"
            _sb.table("messages").insert({"conversation_id": _conv_id, "user_id": _user_id,
                "role": "assistant", "content": "".join(full_reply)}).execute()
            yield "data: {\"type\": \"done\"}\n\n"
        except Exception as e:
            yield "data: " + json.dumps({"type": "error", "message": str(e)}) + "\n\n"

    resp = StreamingHttpResponse(stream_response(), content_type="text/event-stream")
    resp["Cache-Control"] = "no-cache"; resp["X-Accel-Buffering"] = "no"
    return resp


# ─────────────────────────────────────────────────────────────────────────────
# CLAUDE.md — per-conversation instructions (like .claude/CLAUDE.md)
# ─────────────────────────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["GET"])
@auth_required
def get_claude_md(request, conversation_id):
    sb   = get_supabase_for_user(request.token)
    try:
        conv = sb.table("conversations").select("claude_md").eq("id", conversation_id).execute()
        if not conv.data:
            return JsonResponse({"error": "Not found"}, status=404)
        return JsonResponse({"claude_md": conv.data[0].get("claude_md") or ""})
    except Exception:
        return JsonResponse({"claude_md": ""})


@csrf_exempt
@require_http_methods(["POST"])
@auth_required
def set_claude_md(request, conversation_id):
    body      = json.loads(request.body)
    claude_md = body.get("claude_md", "")
    sb        = get_supabase_for_user(request.token)
    sb.table("conversations").update({"claude_md": claude_md}).eq(
        "id", conversation_id).execute()
    return JsonResponse({"ok": True})


# ─────────────────────────────────────────────────────────────────────────────
# Todos
# ─────────────────────────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["GET"])
@auth_required
def get_todos(request, conversation_id):
    sb = get_supabase_for_user(request.token)
    try:
        result = sb.table("todos").select("items").eq("conversation_id", conversation_id).execute()
        items  = result.data[0]["items"] if result.data else []
    except Exception:
        items = []
    return JsonResponse({"todos": items})


# ─────────────────────────────────────────────────────────────────────────────
# DB Setup endpoint (run once after first deploy)
# ─────────────────────────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["GET"])
def db_setup_status(request):
    """Returns the SQL to run in Supabase + tries auto-init if DATABASE_URL is set."""
    from .db_init import run_db_init, SCHEMA_SQL
    auto_result = "skipped"
    if os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_PASSWORD"):
        try:
            run_db_init()
            auto_result = "success"
        except Exception as e:
            auto_result = f"failed: {e}"
    return JsonResponse({
        "auto_init": auto_result,
        "manual_sql_hint": "Copy the SQL from /api/setup/sql/ and run in Supabase SQL Editor",
    })


@csrf_exempt
@require_http_methods(["GET"])
def db_setup_sql(request):
    """Returns the raw SQL to paste into Supabase SQL Editor."""
    from .db_init import SCHEMA_SQL
    return HttpResponse(SCHEMA_SQL, content_type="text/plain")


# ─────────────────────────────────────────────────────────────────────────────
# Helper
# ─────────────────────────────────────────────────────────────────────────────

def _build_groq_content(user_text: str, files: list, model: str):
    model_info = GROQ_MODELS.get(model, {})
    has_images = any(f.get("type") == "image" for f in files)
    if has_images and model_info.get("vision"):
        parts = []
        for f in files:
            if f.get("type") == "image":
                parts.append({"type": "image_url",
                               "image_url": {"url": f"data:{f['mimetype']};base64,{f['base64']}"}})
            elif f.get("type") == "text" and f.get("content"):
                parts.append({"type": "text",
                               "text": f"[File: {f['filename']}]\n{f['content']}\n"})
        if user_text:
            parts.append({"type": "text", "text": user_text})
        return parts
    else:
        parts = []
        for f in files:
            if f.get("type") == "text" and f.get("content"):
                parts.append(
                    f'<file name="{f["filename"]}" description="{f.get("summary","")}">\n'
                    f'{f["content"]}\n</file>'
                )
            elif f.get("type") == "image":
                parts.append(f"[Image: {f['filename']} — use a vision model to analyze images]")
        if user_text:
            parts.append(user_text)
        return "\n\n".join(parts)
