-- Jalankan di Supabase > SQL Editor (aman dijalankan ulang).
alter table public.conversations add column if not exists pinned boolean not null default false;
notify pgrst, 'reload schema';
