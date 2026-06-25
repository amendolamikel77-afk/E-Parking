-- ===========================================================================
-- ParkQuest schema. Safe to re-run: every policy/trigger is dropped before
-- being recreated, and tables use "create table if not exists".
-- Paste the whole file into the Supabase SQL editor and run it.
-- ===========================================================================

-- ===== REPORTS =============================================================
create table if not exists reports (
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

drop policy if exists "Anyone can read reports" on reports;
create policy "Anyone can read reports" on reports for select using (true);

drop policy if exists "Logged-in users can insert their own reports" on reports;
create policy "Logged-in users can insert their own reports"
  on reports for insert with check (auth.uid() = user_id);

-- Anyone logged in can flip a report from free to taken when they claim it
-- by parking there (see the "parked_confirm" photo-claim flow below).
drop policy if exists "Logged-in users can claim a free spot as taken" on reports;
create policy "Logged-in users can claim a free spot as taken"
  on reports for update using (status = 'free') with check (status = 'taken');

-- ===== PROFILES ============================================================
-- One row per authenticated user, holding the reliability score.
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  reliability_score integer not null default 0,
  created_at timestamptz not null default now()
);
alter table profiles enable row level security;

drop policy if exists "Anyone can read profiles" on profiles;
create policy "Anyone can read profiles" on profiles for select using (true);

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ===== REPORT VOTES ========================================================
-- confirm/dispute/parked_confirm feedback that drives the reporter's score.
create table if not exists report_votes (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports (id) on delete cascade,
  voter_id uuid not null references auth.users (id),
  vote text not null check (vote in ('confirm', 'dispute', 'parked_confirm')),
  photo_url text,
  created_at timestamptz not null default now(),
  unique (report_id, voter_id)
);
alter table report_votes enable row level security;

drop policy if exists "Anyone can read votes" on report_votes;
create policy "Anyone can read votes" on report_votes for select using (true);

drop policy if exists "Logged-in users can vote" on report_votes;
create policy "Logged-in users can vote"
  on report_votes for insert with check (auth.uid() = voter_id);

-- Adjust the reporter's reliability score whenever someone votes on their report.
-- +1 confirm, +2 parked_confirm (photo-verified), -1 dispute.
create or replace function handle_new_vote()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  report_owner uuid;
  delta integer;
begin
  select user_id into report_owner from reports where id = new.report_id;
  if report_owner is null or report_owner = new.voter_id then
    return new;
  end if;
  delta := case
    when new.vote = 'confirm' then 1
    when new.vote = 'parked_confirm' then 2
    else -1
  end;
  update profiles set reliability_score = reliability_score + delta where id = report_owner;
  return new;
end;
$$;

drop trigger if exists on_report_vote_created on report_votes;
create trigger on_report_vote_created
  after insert on report_votes
  for each row execute function handle_new_vote();

-- ===== STORAGE (verification photos) =======================================
-- Public bucket for the "I parked here" verification photos.
insert into storage.buckets (id, name, public)
values ('parking-photos', 'parking-photos', true)
on conflict (id) do nothing;

drop policy if exists "Anyone can view parking photos" on storage.objects;
create policy "Anyone can view parking photos"
  on storage.objects for select using (bucket_id = 'parking-photos');

drop policy if exists "Logged-in users can upload parking photos" on storage.objects;
create policy "Logged-in users can upload parking photos"
  on storage.objects for insert
  with check (bucket_id = 'parking-photos' and auth.uid() is not null);
