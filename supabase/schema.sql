create table reports (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('free', 'taken')),
  location_label text not null default 'Main St Lot',
  lat double precision,
  lng double precision,
  reporter_id text,
  user_id uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table reports enable row level security;

create policy "Anyone can read reports"
  on reports for select
  using (true);

create policy "Logged-in users can insert their own reports"
  on reports for insert
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Profiles: one row per authenticated user, holding the reliability score.
-- ---------------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  reliability_score integer not null default 0,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "Anyone can read profiles"
  on profiles for select
  using (true);

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ===========================================================================
-- Migrations for tables created before these columns/objects existed.
-- Run only the lines you still need.
-- ===========================================================================
-- alter table reports add column lat double precision;
-- alter table reports add column lng double precision;
-- alter table reports add column reporter_id text;
-- alter table reports add column user_id uuid references auth.users (id);
--
-- -- Replace the old open insert policy with a logged-in-only one:
-- drop policy if exists "Anyone can insert reports" on reports;
-- create policy "Logged-in users can insert their own reports"
--   on reports for insert
--   with check (auth.uid() = user_id);
--
-- -- Then create the profiles table, its policy, the handle_new_user function,
-- -- and the on_auth_user_created trigger exactly as defined above.
