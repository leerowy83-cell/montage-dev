"""
MontageDev — Supabase client helpers.
Uses user JWT for RLS-enforced queries + minted service-role JWT for admin ops.
"""
import time
from functools import wraps

from django.conf import settings
from django.http import JsonResponse
from jose import jwt, JWTError
from supabase import create_client, Client


def mint_service_role_token() -> str:
    """
    Mint a service_role JWT from the project JWT secret.
    Supabase validates this exactly the same as the pre-issued service_role key.
    """
    now = int(time.time())
    payload = {
        "role": "service_role",
        "iss": "supabase",
        "iat": now,
        "exp": now + 3600,
    }
    return jwt.encode(payload, settings.SUPABASE_JWT_SECRET, algorithm="HS256")


def get_supabase_for_user(token: str) -> Client:
    """Supabase client authenticated as the user — RLS enforced."""
    client = create_client(settings.SUPABASE_URL, settings.SUPABASE_ANON_KEY)
    client.postgrest.auth(token)
    return client


def get_supabase_admin() -> Client:
    """Supabase client with service-role permissions — bypasses RLS."""
    service_token = mint_service_role_token()
    client = create_client(settings.SUPABASE_URL, settings.SUPABASE_ANON_KEY)
    client.postgrest.auth(service_token)
    return client


def verify_token(token: str) -> dict | None:
    """Verify a Supabase JWT and return its payload, or None on failure."""
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
    """
    Decorator: checks Authorization: Bearer <token>.
    Injects request.token, request.user_id, request.user_email.
    """
    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JsonResponse({"error": "Unauthorized"}, status=401)
        token = auth_header[7:]
        payload = verify_token(token)
        if not payload:
            return JsonResponse({"error": "Invalid or expired token"}, status=401)
        request.token      = token
        request.user_id    = payload.get("sub")
        request.user_email = payload.get("email", "")
        return view_func(request, *args, **kwargs)
    return wrapper
