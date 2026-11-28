-- Statistik chat untuk panel admin. Jalankan di Supabase > SQL Editor (aman dijalankan ulang).
-- Hanya menghitung jumlah. Isi percakapan pengguna tidak bisa dibaca admin lewat panel.

drop function if exists public.admin_user_stats();
create or replace function public.admin_user_stats()
returns table (user_id uuid, total bigint, recent bigint, last_at timestamptz, convs bigint, msgs bigint)
language plpgsql security definer set search_path = public stable as $$
begin
  if not public.is_admin() then raise exception 'tidak diizinkan'; end if;
  return query
    select p.id,
      coalesce((select count(*) from public.usage u where u.user_id = p.id), 0),
      coalesce((select count(*) from public.usage u where u.user_id = p.id and u.created_at > now() - interval '30 minutes'), 0),
      (select max(m.created_at) from public.messages m where m.user_id = p.id and m.role = 'user'),
      coalesce((select count(*) from public.conversations c where c.user_id = p.id), 0),
      coalesce((select count(*) from public.messages m where m.user_id = p.id and m.role = 'user'), 0)
    from public.profiles p;
end $$;

create or replace function public.admin_overview() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not public.is_admin() then raise exception 'tidak diizinkan'; end if;
  return json_build_object(
    'users', (select count(*) from public.profiles),
    'convs', (select count(*) from public.conversations),
    'msgs', (select count(*) from public.messages where role = 'user'),
    'replies', (select count(*) from public.messages where role = 'model'),
    'msgs_today', (select count(*) from public.messages where role = 'user'
                   and created_at >= (date_trunc('day', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta')),
    'active_24h', (select count(distinct user_id) from public.messages where role = 'user' and created_at > now() - interval '24 hours'),
    'ai_calls', (select count(*) from public.usage));
end $$;

revoke all on function public.admin_user_stats(), public.admin_overview() from public, anon;
grant execute on function public.admin_user_stats(), public.admin_overview() to authenticated;
notify pgrst, 'reload schema';
