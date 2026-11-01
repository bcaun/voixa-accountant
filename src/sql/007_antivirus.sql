-- Virus scan result of every file version: clean, infected, pending (scanner was down) or off (no scanner configured).
alter table versions add column scan_status text not null default 'off' check (scan_status in ('clean', 'infected', 'pending', 'off'));
alter table versions add column scan_signature text;
alter table versions add column scanned_at timestamptz;
create index versions_scan_pending_idx on versions (uploaded_at) where scan_status = 'pending';
