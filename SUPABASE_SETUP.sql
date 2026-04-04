-- ============================================================
-- MontageDev AI — Supabase Schema
-- Run this ONCE in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

create extension if not exists "uuid-ossp";

create table if not exists public.profiles (
  id            uuid references auth.users(id) on delete cascade primary key,
  email         text,
  display_name  text,
  avatar_url    text,
  created_at    timestamptz default now()
);

create table if not exists public.conversations (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references auth.users(id) on delete cascade not null,
  title       text default 'New Chat',
  claude_md   text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists public.messages (
  id                  uuid default gen_random_uuid() primary key,
  conversation_id     uuid references public.conversations(id) on delete cascade not null,
  user_id             uuid references auth.users(id) on delete cascade not null,
  role                text not null check (role in ('user','assistant','system')),
  content             text not null,
  created_at          timestamptz default now()
);

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

create policy "own profiles"      on public.profiles      for all using (auth.uid()=id)          with check (auth.uid()=id);
create policy "own conversations" on public.conversations  for all using (auth.uid()=user_id)     with check (auth.uid()=user_id);
create policy "own messages"      on public.messages       for all using (auth.uid()=user_id)     with check (auth.uid()=user_id);
create policy "own todos"         on public.todos          for all using (auth.uid()=user_id)     with check (auth.uid()=user_id);

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

-- Auto-bump updated_at when messages are added
create or replace function public.touch_conversation()
returns trigger language plpgsql as $$
begin
  update public.conversations set updated_at = now() where id = new.conversation_id;
  return new;
end; $$;

drop trigger if exists messages_touch_conv on public.messages;
create trigger messages_touch_conv
  after insert on public.messages
  for each row execute function public.touch_conversation();
