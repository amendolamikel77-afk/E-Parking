create table reports (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('free', 'taken')),
  location_label text not null default 'Main St Lot',
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now()
);

alter table reports enable row level security;

create policy "Anyone can read reports"
  on reports for select
  using (true);

create policy "Anyone can insert reports"
  on reports for insert
  with check (true);

-- Migration for existing tables created before lat/lng existed:
-- alter table reports add column lat double precision;
-- alter table reports add column lng double precision;
