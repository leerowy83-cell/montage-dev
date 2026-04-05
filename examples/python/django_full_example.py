"""
Complete MontageDev AI Example: Django REST API with Supabase Auth
Demonstrates: auth, conversations, messages, streaming, RLS integration
"""

# ── models.py ──────────────────────────────────────────────────────────────
from django.db import models
import uuid

class Conversation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user_id = models.UUIDField(db_index=True)
    title = models.CharField(max_length=255, default="New Chat")
    project_instructions = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["user_id", "-updated_at"]),
        ]

    def __str__(self):
        return f"{self.title} ({self.user_id})"


class Message(models.Model):
    ROLE_CHOICES = [("user", "User"), ("assistant", "Assistant"), ("system", "System")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="messages")
    user_id = models.UUIDField()
    role = models.CharField(max_length=20, choices=ROLE_CHOICES)
    content = models.TextField()
    token_count = models.IntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["conversation", "created_at"]),
        ]

    def __str__(self):
        return f"{self.role}: {self.content[:50]}"


class TodoList(models.Model):
    conversation = models.OneToOneField(Conversation, on_delete=models.CASCADE, related_name="todos")
    user_id = models.UUIDField()
    items = models.JSONField(default=list)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"Todos for {self.conversation.title}"


# ── serializers.py (Django REST Framework) ─────────────────────────────────
from rest_framework import serializers

class MessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = Message
        fields = ["id", "role", "content", "created_at"]
        read_only_fields = ["id", "created_at"]


class ConversationSerializer(serializers.ModelSerializer):
    message_count = serializers.IntegerField(read_only=True)
    last_message = serializers.SerializerMethodField()

    class Meta:
        model = Conversation
        fields = ["id", "title", "created_at", "updated_at", "message_count", "last_message"]

    def get_last_message(self, obj):
        last = obj.messages.last()
        if last:
            return {"role": last.role, "content": last.content[:100]}
        return None


# ── views.py ───────────────────────────────────────────────────────────────
import json
import os
from django.conf import settings
from django.http import JsonResponse, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from groq import Groq
from .auth import auth_required
from .brain import build_system_prompt

@csrf_exempt
@require_http_methods(["GET"])
@auth_required
def list_conversations(request):
    """GET /api/conversations/ — list user's conversations"""
    convs = (
        Conversation.objects
        .filter(user_id=request.user_id)
        .order_by("-updated_at")[:50]
    )
    data = [
        {
            "id": str(c.id),
            "title": c.title,
            "created_at": c.created_at.isoformat(),
            "updated_at": c.updated_at.isoformat(),
        }
        for c in convs
    ]
    return JsonResponse({"conversations": data})


@csrf_exempt
@require_http_methods(["POST"])
@auth_required
def send_message(request, conversation_id):
    """POST /api/conversations/<id>/send/ — stream AI response"""
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        return JsonResponse({"error": "Invalid JSON body"}, status=400)

    user_text = body.get("content", "").strip()
    model = body.get("model", settings.GROQ_MODEL)
    enable_tools = body.get("enable_tools", True)

    if not user_text:
        return JsonResponse({"error": "Empty message"}, status=400)

    try:
        conv = Conversation.objects.get(id=conversation_id, user_id=request.user_id)
    except Conversation.DoesNotExist:
        return JsonResponse({"error": "Conversation not found"}, status=404)

    # Save user message
    Message.objects.create(
        conversation=conv,
        user_id=request.user_id,
        role="user",
        content=user_text,
    )

    # Auto-title on first message
    if conv.title == "New Chat":
        conv.title = user_text[:60] + ("…" if len(user_text) > 60 else "")
        conv.save(update_fields=["title", "updated_at"])

    # Build message history (last 40)
    history = list(
        Message.objects.filter(conversation=conv)
        .order_by("created_at")
        .values("role", "content")
    )[-40:]

    system_prompt = build_system_prompt(
        project_instructions=conv.project_instructions or None
    )

    def event_stream():
        client = Groq(api_key=settings.GROQ_API_KEY)
        full_reply = []

        try:
            # Keepalive — prevents proxy/browser timeout before first Groq response
            yield 'data: {"type": "ping"}\n\n'

            messages = [{"role": "system", "content": system_prompt}] + list(history)
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=4096,
                temperature=0.7,
                stream=False,
            )
            text = response.choices[0].message.content or ""

            yield 'data: {"type": "start"}\n\n'
            for i in range(0, len(text), 8):
                chunk = text[i:i+8]
                full_reply.append(chunk)
                yield "data: " + json.dumps({"type": "token", "text": chunk}) + "\n\n"

            # Save assistant message
            Message.objects.create(
                conversation=conv,
                user_id=request.user_id,
                role="assistant",
                content="".join(full_reply),
            )
            conv.save(update_fields=["updated_at"])

            yield 'data: {"type": "done"}\n\n'

        except Exception as e:
            yield "data: " + json.dumps({"type": "error", "message": str(e)}) + "\n\n"

    resp = StreamingHttpResponse(event_stream(), content_type="text/event-stream")
    resp["Cache-Control"] = "no-cache"
    resp["X-Accel-Buffering"] = "no"
    return resp


# ── urls.py ────────────────────────────────────────────────────────────────
from django.urls import path
from . import views

urlpatterns = [
    path("api/conversations/", views.list_conversations),
    path("api/conversations/create/", views.create_conversation),
    path("api/conversations/<uuid:conversation_id>/", views.update_conversation),
    path("api/conversations/<uuid:conversation_id>/delete/", views.delete_conversation),
    path("api/conversations/<uuid:conversation_id>/messages/", views.list_messages),
    path("api/conversations/<uuid:conversation_id>/send/", views.send_message),
    path("api/conversations/<uuid:conversation_id>/regenerate/", views.regenerate_message),
]


# ── auth.py ────────────────────────────────────────────────────────────────
from functools import wraps
from django.conf import settings
from django.http import JsonResponse
from jose import jwt, JWTError

def verify_supabase_token(token: str) -> dict | None:
    """Verify a Supabase JWT and return its payload."""
    try:
        return jwt.decode(
            token,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
    except JWTError:
        return None

def auth_required(view_func):
    """Decorator that injects request.token, request.user_id, request.user_email."""
    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JsonResponse({"error": "Unauthorized — Bearer token required"}, status=401)
        token = auth_header[7:]
        payload = verify_supabase_token(token)
        if not payload:
            return JsonResponse({"error": "Invalid or expired token"}, status=401)
        request.token = token
        request.user_id = payload.get("sub")
        request.user_email = payload.get("email", "")
        return view_func(request, *args, **kwargs)
    return wrapper


# ── settings.py (relevant parts) ──────────────────────────────────────────
import os

SECRET_KEY = os.environ["SECRET_KEY"]
DEBUG = os.environ.get("DEBUG", "False") == "True"
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "django.contrib.staticfiles",
    "rest_framework",
    "corsheaders",
    "chat",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
SUPABASE_JWT_SECRET = os.environ["SUPABASE_JWT_SECRET"]
GROQ_API_KEY = os.environ["GROQ_API_KEY"]
GROQ_MODEL = "llama-3.3-70b-versatile"

CORS_ALLOWED_ORIGINS = ["http://localhost:3000", "https://myapp.vercel.app"]
CORS_ALLOW_CREDENTIALS = True

DATABASES = {}  # All data in Supabase

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
    }
}

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_STORAGE = "whitenoise.storage.CompressedManifestStaticFilesStorage"
