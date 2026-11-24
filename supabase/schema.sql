-- =====================================================================
-- ระบบเช็กชื่อครูหน้าเสาธง — โรงเรียนอุดรพิชัยรักษ์พิทยา
-- วิธีใช้: Supabase Dashboard → SQL Editor → วางทั้งไฟล์ → กด Run
-- รันซ้ำได้อย่างปลอดภัย (ไม่ลบข้อมูลเดิม)
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1) ตั้งค่าระบบ (มีแถวเดียว)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id              int primary key default 1,
  school_name     text not null default 'โรงเรียนอุดรพิชัยรักษ์พิทยา',
  org_name        text not null default '',                       -- สังกัด (แสดงหัวรายงาน ไม่บังคับ)
  director_name   text not null default '',
  director_title  text not null default 'ผู้อำนวยการโรงเรียนอุดรพิชัยรักษ์พิทยา',
  inspector_title text not null default 'ผู้ตรวจ',
  logo_url        text not null default '',                       -- เช่น assets/logo.png
  lat             double precision,                               -- จุดเสาธง
  lng             double precision,
  radius_m        int  not null default 100,                      -- รัศมีที่ยอมรับ (เมตร)
  max_accuracy_m  int  not null default 100,                      -- ความคลาดเคลื่อน GPS สูงสุดที่ยอมรับ (เมตร)
  open_time       time not null default '08:00',                  -- เริ่มรับเช็กชื่อ
  ontime_until    time not null default '08:40',                  -- เช็กก่อนเวลานี้ = มา, หลังจากนี้ = สาย
  close_time      time not null default '12:00',                  -- ปิดรับเช็กชื่อ
  work_days       int[] not null default '{1,2,3,4,5}',           -- 1=จันทร์ ... 7=อาทิตย์
  require_line    boolean not null default true,                  -- ต้องยืนยันบัญชี LINE ตอนเช็กชื่อ
  updated_at      timestamptz not null default now(),
  constraint settings_single check (id = 1),
  constraint settings_times  check (open_time < ontime_until and ontime_until < close_time),
  constraint settings_radius check (radius_m between 10 and 5000),
  constraint settings_acc    check (max_accuracy_m between 10 and 1000)
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2) ครู
--    เลขบัตรประชาชนเก็บเป็นค่าแฮช (HMAC) เท่านั้น ไม่เก็บเลขจริง
-- ---------------------------------------------------------------------
create table if not exists public.teachers (
  id                 uuid primary key default gen_random_uuid(),
  auth_user_id       uuid unique references auth.users(id) on delete set null,
  national_id_hash   text not null unique,
  national_id_masked text not null,
  prefix             text not null default '',
  first_name         text not null,
  last_name          text not null,
  job_title          text not null default '',
  department         text not null default '',
  email              text not null unique,
  active             boolean not null default true,
  password_set       boolean not null default false,    -- ครูตั้งรหัสผ่านเองแล้วหรือยัง
  pdpa_accepted_at   timestamptz,
  line_user_id       text unique,
  line_display_name  text,
  line_bound_at      timestamptz,
  failed_attempts    int  not null default 0,
  locked_until       timestamptz,
  sort_order         int  not null default 0,
  start_date         date not null default ((now() at time zone 'Asia/Bangkok')::date),
  end_date           date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3) บันทึกการเช็กชื่อ (1 แถวต่อครู 1 วัน)
--    present=มา late=สาย personal=ลากิจ sick=ลาป่วย
--    official=ราชการ maternity=ลาคลอด note=หมายเหตุ(ครูพิมพ์แจ้ง)
-- ---------------------------------------------------------------------
create table if not exists public.attendance (
  id          bigint generated always as identity primary key,
  teacher_id  uuid not null references public.teachers(id) on delete cascade,
  date        date not null,
  status      text not null check (status in ('present','late','personal','sick','official','maternity','note')),
  checkin_at  timestamptz,
  lat         double precision,
  lng         double precision,
  accuracy_m  real,
  distance_m  real,
  note        text not null default '',
  source      text not null default 'gps' check (source in ('gps','teacher','admin')),
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (teacher_id, date)
);
create index if not exists attendance_date_idx on public.attendance (date);

-- ---------------------------------------------------------------------
-- 4) วันหยุด / ผู้ดูแล / บันทึกกิจกรรม
-- ---------------------------------------------------------------------
create table if not exists public.holidays (
  date date primary key,
  name text not null default ''
);

create table if not exists public.admins (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  display_name text not null default '',
  created_at   timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_email text,
  action      text not null,
  target      text,
  detail      jsonb
);
create index if not exists audit_logs_at_idx on public.audit_logs (at desc);

-- ---------------------------------------------------------------------
-- 5) อัปเดต updated_at อัตโนมัติ
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_settings_touch   on public.settings;
create trigger trg_settings_touch   before update on public.settings   for each row execute function public.touch_updated_at();
drop trigger if exists trg_teachers_touch   on public.teachers;
create trigger trg_teachers_touch   before update on public.teachers   for each row execute function public.touch_updated_at();
drop trigger if exists trg_attendance_touch on public.attendance;
create trigger trg_attendance_touch before update on public.attendance for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 6) ฟังก์ชันช่วยตรวจสิทธิ์ (ใช้ใน RLS)
-- ---------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.auth_user_id = auth.uid())
$$;

create or replace function public.my_teacher_id() returns uuid
language sql stable security definer set search_path = public as $$
  select t.id from public.teachers t where t.auth_user_id = auth.uid() limit 1
$$;

revoke all on function public.is_admin()      from public;
revoke all on function public.my_teacher_id() from public;
grant execute on function public.is_admin()      to authenticated;
grant execute on function public.my_teacher_id() to authenticated;

-- ฟังก์ชันว่าง ๆ ไว้ให้ GitHub Actions ยิงทุกสองสามวัน กันโปรเจกต์ฟรีถูกพักเพราะไม่มีกิจกรรม
create or replace function public.ping() returns text
language sql stable as $$ select 'ok'::text $$;
grant execute on function public.ping() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 7) Row Level Security
--    การ "เขียน" ทั้งหมดทำผ่าน Edge Function (service role) เท่านั้น
--    ฝั่งเบราว์เซอร์ทำได้แค่ "อ่าน" ข้อมูลที่ตัวเองมีสิทธิ์
-- ---------------------------------------------------------------------
alter table public.settings   enable row level security;
alter table public.teachers   enable row level security;
alter table public.attendance enable row level security;
alter table public.holidays   enable row level security;
alter table public.admins     enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists settings_read   on public.settings;
drop policy if exists holidays_read   on public.holidays;
drop policy if exists teachers_read   on public.teachers;
drop policy if exists attendance_read on public.attendance;
drop policy if exists admins_read     on public.admins;
drop policy if exists audit_read      on public.audit_logs;

create policy settings_read   on public.settings   for select to authenticated using (true);
create policy holidays_read   on public.holidays   for select to authenticated using (true);
create policy teachers_read   on public.teachers   for select to authenticated
  using (auth_user_id = auth.uid() or public.is_admin());
create policy attendance_read on public.attendance for select to authenticated
  using (teacher_id = public.my_teacher_id() or public.is_admin());
create policy admins_read     on public.admins     for select to authenticated
  using (auth_user_id = auth.uid());
create policy audit_read      on public.audit_logs for select to authenticated
  using (public.is_admin());

-- สิทธิ์ระดับตาราง: ถอนทั้งหมดก่อน แล้วให้เฉพาะ select
revoke all on public.settings, public.teachers, public.attendance,
              public.holidays, public.admins, public.audit_logs
  from anon, authenticated;

grant select on public.settings, public.holidays, public.attendance,
                public.admins, public.audit_logs
  to authenticated;

-- ตารางครู: ไม่ให้เบราว์เซอร์อ่านค่าแฮชเลขบัตรและตัวนับการล็อกอินผิด
grant select (id, auth_user_id, national_id_masked, prefix, first_name, last_name,
              job_title, department, email, active, password_set, pdpa_accepted_at,
              line_user_id, line_display_name, line_bound_at, locked_until,
              sort_order, start_date, end_date, created_at, updated_at)
  on public.teachers to authenticated;
