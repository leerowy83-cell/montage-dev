-- MontageDev AI Complete Database Schema
-- Run in Supabase SQL Editor
-- Includes: tables, indexes, RLS policies, triggers, functions

-- ─────────────────────────────────────────────────────────────────────────────
-- EXTENSIONS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for full-text search
CREATE EXTENSION IF NOT EXISTS "vector";   -- for embeddings (optional)

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────────────────────────────────────

-- User profiles (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'pro')),
    plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
    api_calls_today INTEGER NOT NULL DEFAULT 0,
    api_calls_total INTEGER NOT NULL DEFAULT 0,
    settings JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New Chat',
    project_instructions TEXT,
    model TEXT NOT NULL DEFAULT 'llama-3.3-70b-versatile',
    message_count INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER NOT NULL DEFAULT 0,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    tool_calls JSONB,
    tool_call_id TEXT,
    model TEXT,
    token_count INTEGER,
    finish_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Todos (task lists per conversation)
CREATE TABLE IF NOT EXISTS todos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    items JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(conversation_id)
);

-- Workspace files (optional: persisted sandbox files)
CREATE TABLE IF NOT EXISTS workspace_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    language TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(conversation_id, file_path)
);

-- Memory (persistent key-value store per user)
CREATE TABLE IF NOT EXISTS user_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, key)
);

-- API usage logs
CREATE TABLE IF NOT EXISTS api_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id),
    conversation_id UUID REFERENCES conversations(id),
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

-- Conversations
CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_user_archived ON conversations(user_id, is_archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_title_trgm ON conversations USING gin(title gin_trgm_ops);

-- Messages
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(conversation_id, role);

-- Todos
CREATE INDEX IF NOT EXISTS idx_todos_conversation ON todos(conversation_id);
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);

-- Workspace files
CREATE INDEX IF NOT EXISTS idx_workspace_files_conversation ON workspace_files(conversation_id);
CREATE INDEX IF NOT EXISTS idx_workspace_files_path ON workspace_files(conversation_id, file_path);

-- Memory
CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_user_memory_key ON user_memory(user_id, key);

-- API logs
CREATE INDEX IF NOT EXISTS idx_api_logs_user_date ON api_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_model ON api_logs(model, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, display_name)
    VALUES (
        NEW.id,
        NEW.email,
        SPLIT_PART(NEW.email, '@', 1)
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER touch_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER touch_profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER touch_workspace_files_updated_at
    BEFORE UPDATE ON workspace_files
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER touch_user_memory_updated_at
    BEFORE UPDATE ON user_memory
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Auto-increment conversation message_count
CREATE OR REPLACE FUNCTION increment_message_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    UPDATE conversations
    SET message_count = message_count + 1,
        updated_at = NOW()
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_message_inserted
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION increment_message_count();

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_logs ENABLE ROW LEVEL SECURITY;

-- Profiles: users see/update own profile, admins see all
CREATE POLICY "profiles_own" ON profiles
    FOR ALL USING (auth.uid() = id);

CREATE POLICY "profiles_admin_read" ON profiles
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
    );

-- Conversations: users own their conversations
CREATE POLICY "conversations_owner" ON conversations
    FOR ALL USING (auth.uid() = user_id);

-- Messages: users own their messages (via conversation ownership)
CREATE POLICY "messages_owner" ON messages
    FOR ALL USING (auth.uid() = user_id);

-- Todos: users own their todos
CREATE POLICY "todos_owner" ON todos
    FOR ALL USING (auth.uid() = user_id);

-- Workspace files: users own their files
CREATE POLICY "workspace_files_owner" ON workspace_files
    FOR ALL USING (auth.uid() = user_id);

-- Memory: users own their memory
CREATE POLICY "user_memory_owner" ON user_memory
    FOR ALL USING (auth.uid() = user_id);

-- API logs: users see their own logs, admins see all
CREATE POLICY "api_logs_owner" ON api_logs
    FOR SELECT USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER FUNCTIONS
-- ─────────────────────────────────────────────────────────────────────────────

-- Get conversation with message count
CREATE OR REPLACE FUNCTION get_conversations(p_user_id UUID, p_limit INT DEFAULT 50)
RETURNS TABLE (
    id UUID,
    title TEXT,
    message_count INTEGER,
    last_message_role TEXT,
    last_message_preview TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT
        c.id,
        c.title,
        c.message_count,
        (SELECT role FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1),
        (SELECT LEFT(content, 100) FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1),
        c.created_at,
        c.updated_at
    FROM conversations c
    WHERE c.user_id = p_user_id
      AND c.is_archived = FALSE
    ORDER BY c.updated_at DESC
    LIMIT p_limit;
$$;

-- Search conversations by title
CREATE OR REPLACE FUNCTION search_conversations(p_user_id UUID, p_query TEXT)
RETURNS SETOF conversations LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT * FROM conversations
    WHERE user_id = p_user_id
      AND title ILIKE '%' || p_query || '%'
    ORDER BY updated_at DESC
    LIMIT 20;
$$;

-- Get user statistics
CREATE OR REPLACE FUNCTION get_user_stats(p_user_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT jsonb_build_object(
        'conversation_count', (SELECT COUNT(*) FROM conversations WHERE user_id = p_user_id),
        'message_count', (SELECT COUNT(*) FROM messages WHERE user_id = p_user_id),
        'total_tokens', (SELECT COALESCE(SUM(total_tokens), 0) FROM api_logs WHERE user_id = p_user_id),
        'member_since', (SELECT created_at FROM profiles WHERE id = p_user_id)
    );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- REALTIME
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable realtime for live message updates
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE todos;
-- MontageDev AI Complete Database Schema
-- Run in Supabase SQL Editor
-- Includes: tables, indexes, RLS policies, triggers, functions

-- ─────────────────────────────────────────────────────────────────────────────
-- EXTENSIONS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for full-text search
CREATE EXTENSION IF NOT EXISTS "vector";   -- for embeddings (optional)

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────────────────────────────────────

-- User profiles (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'pro')),
    plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
    api_calls_today INTEGER NOT NULL DEFAULT 0,
    api_calls_total INTEGER NOT NULL DEFAULT 0,
    settings JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New Chat',
    project_instructions TEXT,
    model TEXT NOT NULL DEFAULT 'llama-3.3-70b-versatile',
    message_count INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER NOT NULL DEFAULT 0,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    tool_calls JSONB,
    tool_call_id TEXT,
    model TEXT,
    token_count INTEGER,
    finish_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Todos (task lists per conversation)
CREATE TABLE IF NOT EXISTS todos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    items JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(conversation_id)
);

-- Workspace files (optional: persisted sandbox files)
CREATE TABLE IF NOT EXISTS workspace_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    language TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(conversation_id, file_path)
);

-- Memory (persistent key-value store per user)
CREATE TABLE IF NOT EXISTS user_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, key)
);

-- API usage logs
CREATE TABLE IF NOT EXISTS api_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id),
    conversation_id UUID REFERENCES conversations(id),
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

-- Conversations
CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_user_archived ON conversations(user_id, is_archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_title_trgm ON conversations USING gin(title gin_trgm_ops);

-- Messages
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(conversation_id, role);

-- Todos
CREATE INDEX IF NOT EXISTS idx_todos_conversation ON todos(conversation_id);
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);

-- Workspace files
CREATE INDEX IF NOT EXISTS idx_workspace_files_conversation ON workspace_files(conversation_id);
CREATE INDEX IF NOT EXISTS idx_workspace_files_path ON workspace_files(conversation_id, file_path);

-- Memory
CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_user_memory_key ON user_memory(user_id, key);

-- API logs
CREATE INDEX IF NOT EXISTS idx_api_logs_user_date ON api_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_model ON api_logs(model, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, display_name)
    VALUES (
        NEW.id,
        NEW.email,
        SPLIT_PART(NEW.email, '@', 1)
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER touch_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER touch_profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER touch_workspace_files_updated_at
    BEFORE UPDATE ON workspace_files
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE TRIGGER touch_user_memory_updated_at
    BEFORE UPDATE ON user_memory
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Auto-increment conversation message_count
CREATE OR REPLACE FUNCTION increment_message_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    UPDATE conversations
    SET message_count = message_count + 1,
        updated_at = NOW()
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_message_inserted
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION increment_message_count();

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_logs ENABLE ROW LEVEL SECURITY;

-- Profiles: users see/update own profile, admins see all
CREATE POLICY "profiles_own" ON profiles
    FOR ALL USING (auth.uid() = id);

CREATE POLICY "profiles_admin_read" ON profiles
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
    );

-- Conversations: users own their conversations
CREATE POLICY "conversations_owner" ON conversations
    FOR ALL USING (auth.uid() = user_id);

-- Messages: users own their messages (via conversation ownership)
CREATE POLICY "messages_owner" ON messages
    FOR ALL USING (auth.uid() = user_id);

-- Todos: users own their todos
CREATE POLICY "todos_owner" ON todos
    FOR ALL USING (auth.uid() = user_id);

-- Workspace files: users own their files
CREATE POLICY "workspace_files_owner" ON workspace_files
    FOR ALL USING (auth.uid() = user_id);

-- Memory: users own their memory
CREATE POLICY "user_memory_owner" ON user_memory
    FOR ALL USING (auth.uid() = user_id);

-- API logs: users see their own logs, admins see all
CREATE POLICY "api_logs_owner" ON api_logs
    FOR SELECT USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER FUNCTIONS
-- ─────────────────────────────────────────────────────────────────────────────

-- Get conversation with message count
CREATE OR REPLACE FUNCTION get_conversations(p_user_id UUID, p_limit INT DEFAULT 50)
RETURNS TABLE (
    id UUID,
    title TEXT,
    message_count INTEGER,
    last_message_role TEXT,
    last_message_preview TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT
        c.id,
        c.title,
        c.message_count,
        (SELECT role FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1),
        (SELECT LEFT(content, 100) FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1),
        c.created_at,
        c.updated_at
    FROM conversations c
    WHERE c.user_id = p_user_id
      AND c.is_archived = FALSE
    ORDER BY c.updated_at DESC
    LIMIT p_limit;
$$;

-- Search conversations by title
CREATE OR REPLACE FUNCTION search_conversations(p_user_id UUID, p_query TEXT)
RETURNS SETOF conversations LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT * FROM conversations
    WHERE user_id = p_user_id
      AND title ILIKE '%' || p_query || '%'
    ORDER BY updated_at DESC
    LIMIT 20;
$$;

-- Get user statistics
CREATE OR REPLACE FUNCTION get_user_stats(p_user_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT jsonb_build_object(
        'conversation_count', (SELECT COUNT(*) FROM conversations WHERE user_id = p_user_id),
        'message_count', (SELECT COUNT(*) FROM messages WHERE user_id = p_user_id),
        'total_tokens', (SELECT COALESCE(SUM(total_tokens), 0) FROM api_logs WHERE user_id = p_user_id),
        'member_since', (SELECT created_at FROM profiles WHERE id = p_user_id)
    );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- REALTIME
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable realtime for live message updates
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE todos;
