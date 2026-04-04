"""
Auto-creates all required Supabase tables on first cold-start.
Uses a minted service-role JWT (from the JWT secret we already have)
to call Supabase's postgres REST/RPC layer.

Called once from wsgi.py at cold-start — subsequent calls are no-ops
because we check for table existence first.
"""
import time
import logging
import os

log = logging.getLogger(__name__)

# Full schema — mirrors what was described in the README
SCHEMA_SQL = """
-- Extensions
create extension if not exists "uuid-ossp";

-- profiles: extended user info (auto-created on signup via trigger)
create table if not exists public.profiles (
  id            uuid references auth.users(id) on delete cascade primary key,
  email         text,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz default now()
);

-- conversations: chat sessions
create table if not exists public.conversations (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references auth.users(id) on delete cascade not null,
  title       text default 'New Chat',
  claude_md   text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- messages: individual messages in a conversation
create table if not exists public.messages (
  id                  uuid default gen_random_uuid() primary key,
  conversation_id     uuid references public.conversations(id) on delete cascade not null,
  user_id             uuid references auth.users(id) on delete cascade not null,
  role                text not null check (role in ('user','assistant','system')),
  content             text not null,
  created_at          timestamptz default now()
);

-- todos: per-conversation task lists
create table if not exists public.todos (
  id                  uuid default gen_random_uuid() primary key,
  conversation_id     uuid references public.conversations(id) on delete cascade not null,
  user_id             uuid references auth.users(id) on delete cascade not null,
  items               jsonb default '[]'::jsonb,
  updated_at          timestamptz default now()
);

-- RLS
alter table public.profiles      enable row level security;
alter table public.conversations  enable row level security;
alter table public.messages       enable row level security;
alter table public.todos          enable row level security;

-- Policies (create if not exists pattern)
do $$ begin
  if not exists (select 1 from pg_policies where tablename='profiles' and policyname='own profiles') then
    create policy "own profiles" on public.profiles for all
      using (auth.uid()=id) with check (auth.uid()=id);
  end if;
  if not exists (select 1 from pg_policies where tablename='conversations' and policyname='own conversations') then
    create policy "own conversations" on public.conversations for all
      using (auth.uid()=user_id) with check (auth.uid()=user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='messages' and policyname='own messages') then
    create policy "own messages" on public.messages for all
      using (auth.uid()=user_id) with check (auth.uid()=user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename='todos' and policyname='own todos') then
    create policy "own todos" on public.todos for all
      using (auth.uid()=user_id) with check (auth.uid()=user_id);
  end if;
end $$;

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles(id, email, display_name)
  values (new.id, new.email, split_part(new.email,'@',1))
  on conflict(id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Auto-bump updated_at on new messages
create or replace function public.touch_conversation()
returns trigger language plpgsql as $$
begin
  update public.conversations set updated_at=now() where id=new.conversation_id;
  return new;
end; $$;

drop trigger if exists messages_touch_conv on public.messages;
create trigger messages_touch_conv
  after insert on public.messages
  for each row execute function public.touch_conversation();
"""


def _mint_service_role_token(jwt_secret: str) -> str:
    """
    Mint a Supabase service_role JWT from the JWT secret.
    This is exactly how Supabase's service role key works —
    it's a HS256 JWT with role='service_role' signed by the project's JWT secret.
    """
    from jose import jwt
    now = int(time.time())
    payload = {
        "role": "service_role",
        "iss": "supabase",
        "iat": now,
        "exp": now + 3600,
    }
    return jwt.encode(payload, jwt_secret, algorithm="HS256")


def run_db_init():
    """
    Attempt to auto-create the schema.
    Works if DATABASE_URL env var is set (psycopg2 direct connection).
    Falls back gracefully if unavailable.
    """
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        # Try to connect directly to Supabase postgres using known host
        try:
            from django.conf import settings
            # Build URL from project ref extracted from SUPABASE_URL
            supabase_url = getattr(settings, "SUPABASE_URL", "")
            if "supabase.co" in supabase_url:
                project_ref = supabase_url.replace("https://", "").split(".")[0]
                db_pw = os.environ.get("SUPABASE_DB_PASSWORD", "")
                if db_pw:
                    database_url = f"postgresql://postgres:{db_pw}@db.{project_ref}.supabase.co:5432/postgres"
        except Exception:
            pass

    if not database_url:
        log.info("db_init: DATABASE_URL not set — skipping auto-schema creation. Run SUPABASE_SETUP.sql manually.")
        return

    try:
        import psycopg2
        conn = psycopg2.connect(database_url, connect_timeout=10)
        conn.autocommit = True
        cur = conn.cursor()

        # Check if already initialized
        cur.execute("select to_regclass('public.conversations')")
        exists = cur.fetchone()[0]
        if exists:
            log.info("db_init: schema already present — skipping.")
            cur.close()
            conn.close()
            return

        log.info("db_init: creating schema...")
        cur.execute(SCHEMA_SQL)
        cur.close()
        conn.close()
        log.info("db_init: schema created successfully.")
    except ImportError:
        log.info("db_init: psycopg2 not available — skipping auto-schema.")
    except Exception as e:
        log.warning(f"db_init: failed ({e}) — run SUPABASE_SETUP.sql manually in Supabase SQL Editor.")


_init_done = False

def ensure_db_initialized():
    """Call once at cold-start. Thread-safe via module-level flag."""
    global _init_done
    if _init_done:
        return
    _init_done = True
    try:
        run_db_init()
    except Exception as e:
        log.warning(f"db_init: unexpected error: {e}")
