-- Sky AI tahap 2. Jalankan seluruh isi file ini di Supabase > SQL Editor (aman dijalankan ulang).
-- Prasyarat: schema.sql, riwayat.sql, dan v2.sql sudah pernah dijalankan.

-- Kolom baru
alter table public.profiles add column if not exists banned boolean not null default false;
alter table public.profiles add column if not exists ban_reason text not null default '';
alter table public.profiles add column if not exists unban_requested_at timestamptz;
alter table public.profiles add column if not exists unban_message text not null default '';
alter table public.profiles add column if not exists ip text not null default '';
alter table public.profiles add column if not exists ip_at timestamptz;
alter table public.profiles add column if not exists plan_expires_at timestamptz;
alter table public.ai_keys add column if not exists provider text not null default 'gemini';
do $$ begin
  alter table public.ai_keys add constraint ai_keys_provider_chk check (provider in ('gemini','groq','openai'));
exception when duplicate_object then null; end $$;
alter table public.conversations add column if not exists mode text not null default 'chat';

-- Proyek
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  goal text not null default '' check (char_length(goal) <= 1000),
  created_at timestamptz not null default now()
);
alter table public.conversations add column if not exists project_id uuid references public.projects on delete set null;
alter table public.projects enable row level security;
drop policy if exists projects_own on public.projects;
create policy projects_own on public.projects for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.projects to authenticated;

-- Catatan pemakaian (tidak bisa diakses langsung oleh klien)
create table if not exists public.usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  model text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists usage_user_idx on public.usage (user_id, created_at desc);
alter table public.usage enable row level security;

-- Pengguna biasa hanya boleh mengubah nama sendiri
create or replace function public.protect_profile() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null and not public.is_admin()
     and coalesce(current_setting('sky.rpc', true), '') <> '1' then
    if (new.email, new.plan, new.is_admin, new.banned, new.ban_reason, new.unban_requested_at,
        new.unban_message, new.ip, new.ip_at, new.plan_expires_at)
       is distinct from
       (old.email, old.plan, old.is_admin, old.banned, old.ban_reason, old.unban_requested_at,
        old.unban_message, old.ip, old.ip_at, old.plan_expires_at) then
      raise exception 'tidak diizinkan';
    end if;
  end if;
  return new;
end $$;

-- Status pemakaian: 15 (Free), 25 (Pro), 40 (Ultra) pesan per 30 menit. Bisa diubah lewat tabel settings, key 'limits'.
create or replace function public.usage_status(uid uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare pl text; lim int; win int; lo jsonb; used int; newest timestamptz; tot bigint; rst timestamptz;
begin
  select case when plan <> 'free' and (plan_expires_at is null or plan_expires_at > now()) then plan else 'free' end
    into pl from public.profiles where id = uid;
  pl := coalesce(pl, 'free');
  select value into lo from public.settings where key = 'limits';
  lim := coalesce((lo->>pl)::int, case pl when 'ultra' then 40 when 'pro' then 25 else 15 end);
  win := coalesce((lo->>'window')::int, 30);
  select count(*), max(created_at) into used, newest
    from public.usage where user_id = uid and created_at > now() - make_interval(mins => win);
  select count(*) into tot from public.usage where user_id = uid;
  if used >= lim then rst := newest + make_interval(mins => win); end if;
  return json_build_object('plan', pl, 'limit', lim, 'window', win, 'used', used,
    'remaining', greatest(lim - used, 0), 'reset_at', rst, 'total', tot);
end $$;
revoke all on function public.usage_status(uuid) from public, anon, authenticated;
grant execute on function public.usage_status(uuid) to service_role;

create or replace function public.my_usage() returns json
language sql security definer set search_path = public stable as
$$ select public.usage_status(auth.uid()) $$;

-- Catat IP terakhir pengguna (dipanggil saat login)
create or replace function public.touch_me() returns void
language plpgsql security definer set search_path = public as $$
declare h json; v text;
begin
  if auth.uid() is null then return; end if;
  begin h := current_setting('request.headers', true)::json; exception when others then h := null; end;
  v := nullif(btrim(split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1)), '');
  perform set_config('sky.rpc', '1', true);
  update public.profiles set ip = coalesce(v, ip), ip_at = now() where id = auth.uid();
end $$;

create or replace function public.request_unban(msg text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  perform set_config('sky.rpc', '1', true);
  update public.profiles set unban_requested_at = now(), unban_message = left(coalesce(msg, ''), 300)
    where id = auth.uid() and banned;
end $$;

create or replace function public.admin_set_plan(uid uuid, pl text, days int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'tidak diizinkan'; end if;
  if pl not in ('free', 'pro', 'ultra') then raise exception 'paket tidak valid'; end if;
  update public.profiles set plan = pl,
    plan_expires_at = case when pl = 'free' or days is null or days <= 0 then null
                           else now() + make_interval(days => days) end
    where id = uid;
end $$;

create or replace function public.admin_ban(uid uuid, reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'tidak diizinkan'; end if;
  if uid = auth.uid() then raise exception 'tidak bisa memblokir diri sendiri'; end if;
  update public.profiles set banned = true, ban_reason = left(coalesce(reason, ''), 200) where id = uid;
end $$;

create or replace function public.admin_unban(uid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'tidak diizinkan'; end if;
  update public.profiles set banned = false, ban_reason = '', unban_requested_at = null, unban_message = '' where id = uid;
end $$;

create or replace function public.admin_reject_unban(uid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'tidak diizinkan'; end if;
  update public.profiles set unban_requested_at = null, unban_message = '' where id = uid;
end $$;

create or replace function public.admin_user_stats()
returns table (user_id uuid, total bigint, recent bigint, last_at timestamptz)
language plpgsql security definer set search_path = public stable as $$
begin
  if not public.is_admin() then raise exception 'tidak diizinkan'; end if;
  return query
    select u.user_id, count(*), count(*) filter (where u.created_at > now() - interval '30 minutes'), max(u.created_at)
    from public.usage u group by u.user_id;
end $$;

revoke all on function public.my_usage(), public.touch_me(), public.request_unban(text),
  public.admin_set_plan(uuid, text, int), public.admin_ban(uuid, text), public.admin_unban(uuid),
  public.admin_reject_unban(uuid), public.admin_user_stats() from public, anon;
grant execute on function public.my_usage(), public.touch_me(), public.request_unban(text),
  public.admin_set_plan(uuid, text, int), public.admin_ban(uuid, text), public.admin_unban(uuid),
  public.admin_reject_unban(uuid), public.admin_user_stats() to authenticated;

-- Prompt dasar dan nama model (Groq untuk Lite, Gemini untuk Med, OpenAI untuk Pro dan Ultra)
insert into public.settings (key, value) values
  ('system_prompt', to_jsonb('Kamu adalah Sky AI, asisten yang ramah, jujur, dan ringkas.'::text))
on conflict (key) do nothing;
update public.settings
  set value = value || '{"lite":"llama-3.3-70b-versatile","pro":"gpt-4o-mini","ultra":"gpt-4o"}'::jsonb
  where key = 'models' and value->>'lite' = 'gemini-2.5-flash-lite' and value->>'pro' = 'gemini-2.5-pro';

notify pgrst, 'reload schema';
