-- Sky AI: jalankan seluruh isi file ini di Supabase > SQL Editor.

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  name text not null default '',
  plan text not null default 'free' check (plan in ('free','pro','ultra')),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.announcements (
  id bigint generated always as identity primary key,
  active boolean not null default false,
  title text not null default '',
  body text not null default '',
  image text not null default '',
  updated_at timestamptz not null default now()
);
create table if not exists public.ai_keys (
  id bigint generated always as identity primary key,
  key text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.settings (
  key text primary key,
  value jsonb not null
);

alter table public.profiles enable row level security;
alter table public.announcements enable row level security;
alter table public.ai_keys enable row level security;
alter table public.settings enable row level security;

create or replace function public.is_admin() returns boolean
language sql security definer set search_path = public stable as
$$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;

-- Profil dibuat otomatis saat pengguna mendaftar.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, left(coalesce(
    nullif(new.raw_user_meta_data->>'name',''),
    nullif(new.raw_user_meta_data->>'full_name',''),
    split_part(new.email,'@',1)), 40))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Pengguna biasa tidak boleh mengubah paket atau status admin.
create or replace function public.protect_profile() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null and not public.is_admin()
     and (new.plan <> old.plan or new.is_admin <> old.is_admin or new.email is distinct from old.email) then
    raise exception 'tidak diizinkan';
  end if;
  return new;
end $$;
drop trigger if exists protect_profile on public.profiles;
create trigger protect_profile before update on public.profiles
  for each row execute function public.protect_profile();

-- Kebijakan akses (RLS)
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

drop policy if exists ann_select on public.announcements;
create policy ann_select on public.announcements for select to anon, authenticated
  using (active or public.is_admin());
drop policy if exists ann_write on public.announcements;
create policy ann_write on public.announcements for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists keys_admin on public.ai_keys;
create policy keys_admin on public.ai_keys for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists settings_admin on public.settings;
create policy settings_admin on public.settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select on public.announcements to anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.announcements, public.ai_keys, public.settings to authenticated;
grant usage, select on all sequences in schema public to authenticated;

insert into public.settings (key, value) values
  ('models', '{"lite":"gemini-2.5-flash-lite","med":"gemini-2.5-flash","pro":"gemini-2.5-pro","ultra":"gemini-2.5-pro"}')
on conflict (key) do nothing;

-- Penyimpanan foto pengumuman (publik dibaca, hanya admin yang mengunggah)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('announce', 'announce', true, 1048576, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;
drop policy if exists announce_admin_write on storage.objects;
create policy announce_admin_write on storage.objects for insert to authenticated
  with check (bucket_id = 'announce' and public.is_admin());
drop policy if exists announce_admin_delete on storage.objects;
create policy announce_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'announce' and public.is_admin());

-- Setelah Anda mendaftar di website, jadikan akun Anda admin (ganti emailnya):
-- update public.profiles set is_admin = true where email = 'emailanda@contoh.com';
