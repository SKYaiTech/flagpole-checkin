// =====================================================================
// Edge Function: admin  (ต้องเข้าสู่ระบบเป็นผู้ดูแล — ตรวจจากตาราง admins)
//   teacher_create | teacher_import | teacher_update | teacher_reset_password
//   teacher_unbind_line | teacher_set_active | teacher_delete
//   attendance_set | attendance_bulk_set | attendance_delete
//   settings_save | holiday_add | holiday_delete | backup_export
//
// Secrets ที่ต้องตั้ง: ID_PEPPER  (ต้องเป็นค่าเดียวกับฟังก์ชัน auth และห้ามเปลี่ยนภายหลัง)
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PEPPER = Deno.env.get("ID_PEPPER") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STATUSES = ["present", "late", "personal", "sick", "official", "maternity", "note"];
const BACKUP_TABLES: Record<string, { select: string; order: string[] }> = {
  teachers: { select: "*", order: ["created_at", "id"] },
  attendance: { select: "*", order: ["id"] },
  holidays: { select: "*", order: ["date"] },
  settings: { select: "*", order: ["id"] },
  admins: { select: "auth_user_id,email,display_name,created_at", order: ["created_at"] },
  audit_logs: { select: "*", order: ["id"] },
};

// <pure>
function normalizeId(s: unknown): string {
  return String(s ?? "").replace(/\D/g, "");
}
async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// ตรวจเลขตรวจสอบของบัตรประชาชนไทย (หลักที่ 13)
function validThaiId(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}
function maskId(id: string): string {
  return `x-xxxx-xxxxx-${id.slice(10, 12)}-${id[12]}`;
}
// รหัสผ่านชั่วคราว 8 ตัว ตัดตัวที่สับสนง่าย (0 o 1 l i) ออก
function genTempPassword(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < 8) {
    for (const b of rand(16)) {
      if (b < limit && out.length < 8) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}
function isDateStr(s: unknown): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function bkkToday(d: Date = new Date()): string {
  return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}
function isHHMM(s: unknown): boolean {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}
// </pure>

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const ok = (data: Record<string, unknown> = {}) => json({ ok: true, ...data });
const fail = (error: string, code = "ERROR", status = 200) => json({ ok: false, error, code }, status);
const clean = (v: unknown, max = 120) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);

const mkAdmin = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method !== "POST") return fail("Method not allowed", "METHOD", 405);
    if (!PEPPER) return fail("ระบบยังไม่ได้ตั้งค่า ID_PEPPER ใน Secrets", "CONFIG", 500);
    const db = mkAdmin();

    // ---- ต้องเป็นผู้ดูแลเท่านั้น
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u, error: uErr } = token ? await db.auth.getUser(token) : { data: null, error: true };
    if (uErr || !u?.user) return fail("กรุณาเข้าสู่ระบบใหม่", "UNAUTHORIZED", 401);
    const user = u.user;
    const { data: adm } = await db.from("admins").select("auth_user_id").eq("auth_user_id", user.id).maybeSingle();
    if (!adm) return fail("บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ", "FORBIDDEN", 403);

    const body = await req.json().catch(() => ({}));
    const audit = async (action: string, target: string | null, detail: unknown = null) => {
      await db.from("audit_logs").insert({ actor_id: user.id, actor_email: user.email, action, target, detail });
    };

    // ---------------------------------------------------------------
    // สร้างครู 1 คน (ใช้ร่วมกันทั้งเพิ่มทีละคนและนำเข้า)
    // ---------------------------------------------------------------
    async function createTeacher(r: any, allowBadChecksum: boolean) {
      const nid = normalizeId(r.national_id);
      if (nid.length !== 13) return { ok: false, error: "เลขบัตรประชาชนต้องมี 13 หลัก" };
      if (!allowBadChecksum && !validThaiId(nid)) return { ok: false, error: "เลขบัตรประชาชนไม่ผ่านการตรวจเลขตรวจสอบ (ตรวจว่าพิมพ์ถูกต้องหรือไม่)" };
      const first = clean(r.first_name), last = clean(r.last_name);
      if (!first || !last) return { ok: false, error: "กรอกชื่อและนามสกุล" };
      const email = String(r.email ?? "").trim().toLowerCase();
      if (!isEmail(email)) return { ok: false, error: "อีเมลไม่ถูกต้อง" };
      let startDate = bkkToday();
      if (r.start_date) {
        if (!isDateStr(r.start_date)) return { ok: false, error: "วันที่เริ่มนับไม่ถูกต้อง (รูปแบบ ค.ศ. YYYY-MM-DD)" };
        startDate = r.start_date;
      }
      const sortOrder = Number.isFinite(Number(r.sort_order)) ? Math.trunc(Number(r.sort_order)) : 0;

      const hash = await hmacHex(PEPPER, nid);
      const { data: d1 } = await db.from("teachers").select("first_name,last_name").eq("national_id_hash", hash).maybeSingle();
      if (d1) return { ok: false, error: `เลขบัตรนี้มีในระบบแล้ว (${d1.first_name} ${d1.last_name})` };
      const { data: d2 } = await db.from("teachers").select("first_name,last_name").eq("email", email).maybeSingle();
      if (d2) return { ok: false, error: `อีเมลนี้ถูกใช้แล้วโดย ${d2.first_name} ${d2.last_name}` };

      const temp = genTempPassword();
      const { data: cu, error: ce } = await db.auth.admin.createUser({ email, password: temp, email_confirm: true });
      if (ce || !cu?.user) {
        const exists = /already|registered|exists/i.test(ce?.message ?? "");
        return { ok: false, error: exists ? "อีเมลนี้มีบัญชีผู้ใช้อยู่ในระบบแล้ว (อาจเป็นบัญชีผู้ดูแล)" : `สร้างบัญชีไม่สำเร็จ: ${ce?.message ?? ""}` };
      }
      const { data: t, error: te } = await db.from("teachers").insert({
        auth_user_id: cu.user.id, national_id_hash: hash, national_id_masked: maskId(nid),
        prefix: clean(r.prefix, 30), first_name: first, last_name: last,
        job_title: clean(r.job_title), department: clean(r.department), email,
        start_date: startDate, sort_order: sortOrder,
      }).select().single();
      if (te) {
        await db.auth.admin.deleteUser(cu.user.id);
        return { ok: false, error: `บันทึกข้อมูลครูไม่สำเร็จ: ${te.message}` };
      }
      return { ok: true, teacher: { id: t.id, prefix: t.prefix, first_name: t.first_name, last_name: t.last_name, job_title: t.job_title, national_id_masked: t.national_id_masked, email: t.email }, temp_password: temp };
    }

    async function getTeacher(id: unknown) {
      const { data } = await db.from("teachers").select("*").eq("id", String(id ?? "")).maybeSingle();
      return data;
    }

    switch (body.action) {
      // ------------------------------------------------------- teacher_create
      case "teacher_create": {
        const r = await createTeacher(body.teacher ?? {}, body.allow_bad_checksum === true);
        if (!r.ok) return fail(r.error!, "INVALID");
        await audit("teacher_create", r.teacher!.id, { name: `${r.teacher!.first_name} ${r.teacher!.last_name}`, email: r.teacher!.email });
        return ok({ teacher: r.teacher, temp_password: r.temp_password });
      }

      // ------------------------------------------------------- teacher_import
      case "teacher_import": {
        const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
        if (!rows.length) return fail("ไม่มีข้อมูลให้นำเข้า", "INVALID");
        if (rows.length > 50) return fail("นำเข้าได้ไม่เกิน 50 รายการต่อครั้ง", "INVALID");
        const seenId = new Set<string>(), seenMail = new Set<string>();
        const results: any[] = new Array(rows.length);
        const work: number[] = [];
        rows.forEach((r, i) => {
          const nid = normalizeId(r.national_id), mail = String(r.email ?? "").trim().toLowerCase();
          if (nid && seenId.has(nid)) results[i] = { ok: false, error: "เลขบัตรซ้ำกับแถวก่อนหน้าในไฟล์" };
          else if (mail && seenMail.has(mail)) results[i] = { ok: false, error: "อีเมลซ้ำกับแถวก่อนหน้าในไฟล์" };
          else { seenId.add(nid); seenMail.add(mail); work.push(i); }
        });
        for (let k = 0; k < work.length; k += 4) {
          await Promise.all(work.slice(k, k + 4).map(async (i) => {
            results[i] = await createTeacher(rows[i], body.allow_bad_checksum === true);
          }));
        }
        const created = results.filter((r) => r?.ok).length;
        await audit("teacher_import", null, { requested: rows.length, created });
        return ok({ results, created });
      }

      // ------------------------------------------------------- teacher_update
      case "teacher_update": {
        const t = await getTeacher(body.id);
        if (!t) return fail("ไม่พบครูที่เลือก", "NOT_FOUND");
        const f = body.fields ?? {};
        const patch: Record<string, unknown> = {};
        if ("prefix" in f) patch.prefix = clean(f.prefix, 30);
        if ("first_name" in f) { patch.first_name = clean(f.first_name); if (!patch.first_name) return fail("กรอกชื่อ", "INVALID"); }
        if ("last_name" in f) { patch.last_name = clean(f.last_name); if (!patch.last_name) return fail("กรอกนามสกุล", "INVALID"); }
        if ("job_title" in f) patch.job_title = clean(f.job_title);
        if ("department" in f) patch.department = clean(f.department);
        if ("sort_order" in f) patch.sort_order = Number.isFinite(Number(f.sort_order)) ? Math.trunc(Number(f.sort_order)) : 0;
        if ("start_date" in f) {
          if (!isDateStr(f.start_date)) return fail("วันที่เริ่มนับไม่ถูกต้อง", "INVALID");
          patch.start_date = f.start_date;
        }
        if ("end_date" in f) {
          if (f.end_date && !isDateStr(f.end_date)) return fail("วันที่สิ้นสุดไม่ถูกต้อง", "INVALID");
          patch.end_date = f.end_date || null;
        }
        if (f.email !== undefined && String(f.email).trim().toLowerCase() !== t.email) {
          const email = String(f.email).trim().toLowerCase();
          if (!isEmail(email)) return fail("อีเมลไม่ถูกต้อง", "INVALID");
          const { data: dup } = await db.from("teachers").select("id").eq("email", email).neq("id", t.id).maybeSingle();
          if (dup) return fail("อีเมลนี้ถูกใช้โดยครูท่านอื่นแล้ว", "INVALID");
          if (t.auth_user_id) {
            const { error } = await db.auth.admin.updateUserById(t.auth_user_id, { email, email_confirm: true });
            if (error) return fail(`เปลี่ยนอีเมลไม่สำเร็จ: ${error.message}`, "INVALID");
          }
          patch.email = email;
        }
        if (f.national_id) {
          const nid = normalizeId(f.national_id);
          if (nid.length !== 13) return fail("เลขบัตรประชาชนต้องมี 13 หลัก", "INVALID");
          if (!validThaiId(nid) && body.allow_bad_checksum !== true) return fail("เลขบัตรประชาชนไม่ผ่านการตรวจเลขตรวจสอบ", "INVALID");
          const hash = await hmacHex(PEPPER, nid);
          const { data: dup } = await db.from("teachers").select("id").eq("national_id_hash", hash).neq("id", t.id).maybeSingle();
          if (dup) return fail("เลขบัตรนี้มีอยู่ในระบบแล้ว", "INVALID");
          patch.national_id_hash = hash;
          patch.national_id_masked = maskId(nid);
        }
        if (!Object.keys(patch).length) return ok({});
        const { error } = await db.from("teachers").update(patch).eq("id", t.id);
        if (error) return fail(`บันทึกไม่สำเร็จ: ${error.message}`, "INVALID");
        const changed = Object.keys(patch).filter((k) => k !== "national_id_hash");
        await audit("teacher_update", t.id, { name: `${t.first_name} ${t.last_name}`, changed });
        return ok({});
      }

      // ------------------------------------------------------- teacher_reset_password
      case "teacher_reset_password": {
        const t = await getTeacher(body.id);
        if (!t || !t.auth_user_id) return fail("ไม่พบครูที่เลือก", "NOT_FOUND");
        const temp = genTempPassword();
        const { error } = await db.auth.admin.updateUserById(t.auth_user_id, { password: temp });
        if (error) return fail(`รีเซ็ตรหัสผ่านไม่สำเร็จ: ${error.message}`, "SERVER", 500);
        await db.from("teachers").update({ password_set: false, failed_attempts: 0, locked_until: null }).eq("id", t.id);
        await audit("teacher_reset_password", t.id, { name: `${t.first_name} ${t.last_name}` });
        return ok({ temp_password: temp, teacher: { id: t.id, prefix: t.prefix, first_name: t.first_name, last_name: t.last_name, job_title: t.job_title, national_id_masked: t.national_id_masked, email: t.email } });
      }

      // ------------------------------------------------------- teacher_unbind_line
      case "teacher_unbind_line": {
        const t = await getTeacher(body.id);
        if (!t) return fail("ไม่พบครูที่เลือก", "NOT_FOUND");
        await db.from("teachers").update({ line_user_id: null, line_display_name: null, line_bound_at: null }).eq("id", t.id);
        await audit("teacher_unbind_line", t.id, { name: `${t.first_name} ${t.last_name}` });
        return ok({});
      }

      // ------------------------------------------------------- teacher_set_active
      case "teacher_set_active": {
        const t = await getTeacher(body.id);
        if (!t) return fail("ไม่พบครูที่เลือก", "NOT_FOUND");
        const active = body.active === true;
        const patch: Record<string, unknown> = { active };
        if (!active && !t.end_date) patch.end_date = bkkToday();
        if (active) patch.end_date = null;
        await db.from("teachers").update(patch).eq("id", t.id);
        await audit(active ? "teacher_activate" : "teacher_deactivate", t.id, { name: `${t.first_name} ${t.last_name}` });
        return ok({});
      }

      // ------------------------------------------------------- teacher_delete
      case "teacher_delete": {
        const t = await getTeacher(body.id);
        if (!t) return fail("ไม่พบครูที่เลือก", "NOT_FOUND");
        if (t.active) return fail("ต้องปิดการใช้งานครูก่อนจึงจะลบได้", "INVALID");
        if (body.confirm !== true) return fail("ต้องยืนยันการลบ", "INVALID");
        const { count } = await db.from("attendance").select("id", { count: "exact", head: true }).eq("teacher_id", t.id);
        const { error } = await db.from("teachers").delete().eq("id", t.id);
        if (error) return fail(`ลบไม่สำเร็จ: ${error.message}`, "SERVER", 500);
        if (t.auth_user_id) await db.auth.admin.deleteUser(t.auth_user_id);
        await audit("teacher_delete", t.id, { name: `${t.first_name} ${t.last_name}`, attendance_deleted: count ?? 0 });
        return ok({});
      }

      // ------------------------------------------------------- attendance_set
      case "attendance_set": {
        const t = await getTeacher(body.teacher_id);
        if (!t) return fail("ไม่พบครูที่เลือก", "NOT_FOUND");
        const date = String(body.date ?? "");
        if (!isDateStr(date)) return fail("วันที่ไม่ถูกต้อง", "INVALID");
        const status = String(body.status ?? "");
        if (!STATUSES.includes(status)) return fail("สถานะไม่ถูกต้อง", "INVALID");
        const note = clean(body.note, 300);
        if (status === "note" && !note) return fail("สถานะ \"หมายเหตุ\" ต้องพิมพ์ข้อความ", "INVALID");
        const reason = clean(body.reason, 200);
        if (reason.length < 2) return fail("กรุณาระบุเหตุผลในการแก้ไข", "INVALID");

        const { data: before } = await db.from("attendance").select("status,note,checkin_at,source").eq("teacher_id", t.id).eq("date", date).maybeSingle();
        const isIn = status === "present" || status === "late";
        let checkinAt: string | null = null;
        if (isIn) {
          if (body.checkin_time) {
            if (!isHHMM(body.checkin_time)) return fail("เวลาไม่ถูกต้อง", "INVALID");
            checkinAt = new Date(`${date}T${body.checkin_time}:00+07:00`).toISOString();
          } else checkinAt = before?.checkin_at ?? null;
        }
        const row: Record<string, unknown> = {
          teacher_id: t.id, date, status, note, source: "admin", updated_by: user.id, checkin_at: checkinAt,
        };
        if (!isIn) Object.assign(row, { lat: null, lng: null, accuracy_m: null, distance_m: null });
        const { error } = await db.from("attendance").upsert(row, { onConflict: "teacher_id,date" });
        if (error) return fail(`บันทึกไม่สำเร็จ: ${error.message}`, "SERVER", 500);
        await audit("attendance_set", t.id, { name: `${t.first_name} ${t.last_name}`, date, before: before ?? null, after: { status, note, checkin_at: checkinAt }, reason });
        return ok({});
      }

      // ------------------------------------------------------- attendance_bulk_set
      case "attendance_bulk_set": {
        const ids: string[] = Array.isArray(body.teacher_ids) ? body.teacher_ids.map(String) : [];
        if (!ids.length) return fail("ยังไม่ได้เลือกครู", "INVALID");
        if (ids.length > 300) return fail("เลือกได้ไม่เกิน 300 คนต่อครั้ง", "INVALID");
        const date = String(body.date ?? "");
        if (!isDateStr(date)) return fail("วันที่ไม่ถูกต้อง", "INVALID");
        const status = String(body.status ?? "");
        if (!STATUSES.includes(status) || status === "present" || status === "late") {
          return fail("การบันทึกหลายคนพร้อมกันใช้ได้กับสถานะลา/ราชการ/หมายเหตุเท่านั้น", "INVALID");
        }
        const note = clean(body.note, 300);
        if (status === "note" && !note) return fail("สถานะ \"หมายเหตุ\" ต้องพิมพ์ข้อความ", "INVALID");
        const reason = clean(body.reason, 200);
        if (reason.length < 2) return fail("กรุณาระบุเหตุผล", "INVALID");
        const { data: found } = await db.from("teachers").select("id").in("id", ids);
        const valid = (found ?? []).map((x: any) => x.id);
        if (!valid.length) return fail("ไม่พบครูที่เลือก", "NOT_FOUND");
        const rows = valid.map((id: string) => ({
          teacher_id: id, date, status, note, source: "admin", updated_by: user.id,
          checkin_at: null, lat: null, lng: null, accuracy_m: null, distance_m: null,
        }));
        const { error } = await db.from("attendance").upsert(rows, { onConflict: "teacher_id,date" });
        if (error) return fail(`บันทึกไม่สำเร็จ: ${error.message}`, "SERVER", 500);
        await audit("attendance_bulk_set", null, { date, status, note, reason, count: valid.length });
        return ok({ saved: valid.length });
      }

      // ------------------------------------------------------- attendance_delete
      case "attendance_delete": {
        const t = await getTeacher(body.teacher_id);
        if (!t) return fail("ไม่พบครูที่เลือก", "NOT_FOUND");
        const date = String(body.date ?? "");
        if (!isDateStr(date)) return fail("วันที่ไม่ถูกต้อง", "INVALID");
        const reason = clean(body.reason, 200);
        if (reason.length < 2) return fail("กรุณาระบุเหตุผลในการลบ", "INVALID");
        const { data: before } = await db.from("attendance").select("status,note,checkin_at,source").eq("teacher_id", t.id).eq("date", date).maybeSingle();
        if (!before) return fail("ไม่พบบันทึกของวันนั้น", "NOT_FOUND");
        await db.from("attendance").delete().eq("teacher_id", t.id).eq("date", date);
        await audit("attendance_delete", t.id, { name: `${t.first_name} ${t.last_name}`, date, before, reason });
        return ok({});
      }

      // ------------------------------------------------------- settings_save
      case "settings_save": {
        const s = body.settings ?? {};
        const patch: Record<string, unknown> = {};
        for (const k of ["school_name", "org_name", "director_name", "director_title", "inspector_title"]) {
          if (k in s) patch[k] = clean(s[k], 200);
        }
        if (patch.school_name === "") return fail("กรอกชื่อโรงเรียน", "INVALID");
        if ("logo_url" in s) {
          const v = String(s.logo_url ?? "").trim();
          if (v && (v.includes("..") || !/^(https:\/\/\S+|[A-Za-z0-9_\-\/.]+)$/.test(v))) return fail("ที่อยู่โลโก้ไม่ถูกต้อง", "INVALID");
          patch.logo_url = v;
        }
        if ("lat" in s || "lng" in s) {
          const hasLat = s.lat !== null && s.lat !== "" && s.lat !== undefined;
          const hasLng = s.lng !== null && s.lng !== "" && s.lng !== undefined;
          if (hasLat !== hasLng) return fail("ต้องกรอกละติจูดและลองจิจูดพร้อมกัน", "INVALID");
          if (hasLat) {
            const lat = Number(s.lat), lng = Number(s.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return fail("พิกัดไม่ถูกต้อง", "INVALID");
            patch.lat = lat; patch.lng = lng;
          } else { patch.lat = null; patch.lng = null; }
        }
        if ("radius_m" in s) {
          const v = Math.trunc(Number(s.radius_m));
          if (!(v >= 10 && v <= 5000)) return fail("รัศมีต้องอยู่ระหว่าง 10 - 5000 เมตร", "INVALID");
          patch.radius_m = v;
        }
        if ("max_accuracy_m" in s) {
          const v = Math.trunc(Number(s.max_accuracy_m));
          if (!(v >= 10 && v <= 1000)) return fail("ค่าความคลาดเคลื่อน GPS ต้องอยู่ระหว่าง 10 - 1000 เมตร", "INVALID");
          patch.max_accuracy_m = v;
        }
        const times = ["open_time", "ontime_until", "close_time"].filter((k) => k in s);
        if (times.length) {
          const cur = (await db.from("settings").select("open_time,ontime_until,close_time").eq("id", 1).single()).data!;
          const merged: Record<string, string> = {
            open_time: String(cur.open_time).slice(0, 5), ontime_until: String(cur.ontime_until).slice(0, 5), close_time: String(cur.close_time).slice(0, 5),
          };
          for (const k of times) {
            if (!isHHMM(s[k])) return fail("รูปแบบเวลาไม่ถูกต้อง (HH:MM)", "INVALID");
            merged[k] = s[k]; patch[k] = s[k];
          }
          if (!(merged.open_time < merged.ontime_until && merged.ontime_until < merged.close_time)) {
            return fail("ลำดับเวลาต้องเป็น เริ่มรับเช็กชื่อ < ตรงเวลาถึง < ปิดรับเช็กชื่อ", "INVALID");
          }
        }
        if ("work_days" in s) {
          const wd = Array.isArray(s.work_days) ? [...new Set(s.work_days.map(Number))].filter((n) => n >= 1 && n <= 7).sort() : [];
          if (!wd.length) return fail("เลือกวันทำการอย่างน้อย 1 วัน", "INVALID");
          patch.work_days = wd;
        }
        if ("require_line" in s) patch.require_line = s.require_line === true;
        if (!Object.keys(patch).length) return ok({});
        const { error } = await db.from("settings").update(patch).eq("id", 1);
        if (error) return fail(`บันทึกไม่สำเร็จ: ${error.message}`, "INVALID");
        await audit("settings_save", null, patch);
        return ok({});
      }

      // ------------------------------------------------------- holiday_add / holiday_delete
      case "holiday_add": {
        const from = String(body.date_from ?? ""), to = String(body.date_to || from);
        if (!isDateStr(from) || !isDateStr(to) || to < from) return fail("ช่วงวันที่ไม่ถูกต้อง", "INVALID");
        if (to > addDays(from, 366)) return fail("เพิ่มได้ไม่เกิน 1 ปีต่อครั้ง", "INVALID");
        const name = clean(body.name, 100);
        const rows: { date: string; name: string }[] = [];
        for (let d = from; d <= to; d = addDays(d, 1)) rows.push({ date: d, name });
        const { error } = await db.from("holidays").upsert(rows, { onConflict: "date" });
        if (error) return fail(`บันทึกไม่สำเร็จ: ${error.message}`, "SERVER", 500);
        await audit("holiday_add", null, { from, to, name });
        return ok({ added: rows.length });
      }
      case "holiday_delete": {
        const date = String(body.date ?? "");
        if (!isDateStr(date)) return fail("วันที่ไม่ถูกต้อง", "INVALID");
        await db.from("holidays").delete().eq("date", date);
        await audit("holiday_delete", null, { date });
        return ok({});
      }

      // ------------------------------------------------------- backup_export
      case "backup_export": {
        const spec = BACKUP_TABLES[String(body.table ?? "")];
        if (!spec) return fail("ตารางไม่ถูกต้อง", "INVALID");
        const offset = Math.max(0, Math.trunc(Number(body.offset) || 0));
        const limit = Math.min(5000, Math.max(1, Math.trunc(Number(body.limit) || 1000)));
        let q = db.from(String(body.table)).select(spec.select);
        for (const o of spec.order) q = q.order(o, { ascending: true });
        const { data, error } = await q.range(offset, offset + limit - 1);
        if (error) return fail(`อ่านข้อมูลไม่สำเร็จ: ${error.message}`, "SERVER", 500);
        return ok({ rows: data ?? [], next: offset + (data?.length ?? 0), done: (data?.length ?? 0) < limit });
      }

      default:
        return fail("ไม่รู้จักคำสั่ง", "UNKNOWN_ACTION", 400);
    }
  } catch (e) {
    console.error(e);
    return fail("เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่อีกครั้ง", "SERVER", 500);
  }
});
