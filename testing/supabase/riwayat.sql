-- Riwayat percakapan Sky AI. Jalankan di Supabase > SQL Editor (aman dijalankan ulang).

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  role text not null check (role in ('user','model')),
  content text not null check (char_length(content) <= 20000),
  created_at timestamptz not null default now()
);
create index if not exists conversations_user_idx on public.conversations (user_id, updated_at desc);
create index if not exists messages_conv_idx on public.messages (conversation_id, id);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;

drop policy if exists conv_own on public.conversations;
create policy conv_own on public.conversations for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists msg_own on public.messages;
create policy msg_own on public.messages for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()));

grant select, insert, update, delete on public.conversations, public.messages to authenticated;
grant usage, select on all sequences in schema public to authenticated;

notify pgrst, 'reload schema';
