// =====================================================================
// Edge Function: teacher  (ต้องเข้าสู่ระบบเป็นครู)
//   me | checkin | report_status | cancel_status | add_note
//   change_password | accept_pdpa | password_reset_done | bind_line
//
// Secrets ที่ต้องตั้ง: LINE_CHANNEL_ID  (ใช้ยืนยันบัญชี LINE ตอนเช็กชื่อ)
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LINE_CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STATUS_LABEL: Record<string, string> = {
  present: "มา", late: "สาย", personal: "ลากิจ", sick: "ลาป่วย",
  official: "ราชการ", maternity: "ลาคลอด", note: "หมายเหตุ",
};
const TEACHER_STATUSES = ["personal", "sick", "official", "maternity", "note"];
const MAX_RANGE_DAYS = 130;

// <pure>
function bkkNow(d: Date = new Date()) {
  const t = new Date(d.getTime() + 7 * 3600 * 1000);
  const iso = t.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19), dow: ((t.getUTCDay() + 6) % 7) + 1 };
}
function isoDow(dateStr: string): number {
  const d = new Date(dateStr + "T00:00:00Z");
  return ((d.getUTCDay() + 6) % 7) + 1;
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isDateStr(s: unknown): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function datesInRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
function toSec(t: string): number {
  const [h, m, s] = String(t).split(":").map(Number);
  return h * 3600 + (m || 0) * 60 + (s || 0);
}
function decideCheckin(time: string, s: { open_time: string; ontime_until: string; close_time: string }) {
  const t = toSec(time);
  if (t < toSec(s.open_time)) return { ok: false, code: "TOO_EARLY" };
  if (t <= toSec(s.ontime_until)) return { ok: true, status: "present" };
  if (t <= toSec(s.close_time)) return { ok: true, status: "late" };
  return { ok: false, code: "CLOSED" };
}
function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function validatePassword(pw: string): string | null {
  if (pw.length < 8) return "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร";
  if (pw.length > 72) return "รหัสผ่านยาวเกินไป (ไม่เกิน 72 ตัวอักษร)";
  if (/^\d{13}$/.test(pw)) return "ห้ามใช้เลขบัตรประชาชนเป็นรหัสผ่าน";
  return null;
}
// </pure>

const hhmm = (t: string) => String(t).slice(0, 5);
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const ok = (data: Record<string, unknown> = {}) => json({ ok: true, ...data });
const fail = (error: string, code = "ERROR", extra: Record<string, unknown> = {}, status = 200) =>
  json({ ok: false, error, code, ...extra }, status);

const mkAdmin = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const mkAnon = () => createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function verifyLine(idToken: string) {
  if (!LINE_CHANNEL_ID) return { ok: false, code: "CONFIG", message: "ระบบยังไม่ได้ตั้งค่า LINE_CHANNEL_ID ใน Secrets" };
  if (!idToken) return { ok: false, code: "LINE_TOKEN", message: "ไม่พบข้อมูลบัญชี LINE กรุณาเปิดระบบผ่านแอป LINE แล้วลองใหม่" };
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const expired = String(j.error_description ?? "").toLowerCase().includes("expired");
    return {
      ok: false,
      code: expired ? "LINE_TOKEN_EXPIRED" : "LINE_TOKEN",
      message: expired ? "เซสชัน LINE หมดอายุ กรุณาเปิดระบบใหม่อีกครั้ง" : "ตรวจสอบบัญชี LINE ไม่ผ่าน",
    };
  }
  return { ok: true, sub: String(j.sub), name: String(j.name ?? "") };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method !== "POST") return fail("Method not allowed", "METHOD", {}, 405);
    const admin = mkAdmin();

    // ---- ยืนยันตัวตนจาก token ของ Supabase Auth
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u, error: uErr } = token ? await admin.auth.getUser(token) : { data: null, error: true };
    if (uErr || !u?.user) return fail("กรุณาเข้าสู่ระบบใหม่", "UNAUTHORIZED", {}, 401);
    const user = u.user;
    const { data: t } = await admin.from("teachers").select("*").eq("auth_user_id", user.id).maybeSingle();
    if (!t || !t.active) return fail("ไม่พบบัญชีครูที่ใช้งานอยู่", "UNAUTHORIZED", {}, 401);

    const body = await req.json().catch(() => ({}));
    const now = bkkNow();
    const getSettings = async () => (await admin.from("settings").select("*").eq("id", 1).single()).data!;

    switch (body.action) {
      // ---------------------------------------------------------- me
      case "me": {
        const s = await getSettings();
        const { data: record } = await admin.from("attendance").select("*").eq("teacher_id", t.id).eq("date", now.date).maybeSingle();
        const { data: hol } = await admin.from("holidays").select("name").eq("date", now.date).maybeSingle();
        return ok({
          teacher: {
            id: t.id, prefix: t.prefix, first_name: t.first_name, last_name: t.last_name,
            job_title: t.job_title, department: t.department, email: t.email,
            national_id_masked: t.national_id_masked, password_set: t.password_set,
            pdpa_accepted: !!t.pdpa_accepted_at, line_bound: !!t.line_user_id,
            line_display_name: t.line_display_name,
            start_date: t.start_date, end_date: t.end_date,
          },
          settings: {
            school_name: s.school_name, lat: s.lat, lng: s.lng, radius_m: s.radius_m,
            max_accuracy_m: s.max_accuracy_m, open_time: hhmm(s.open_time),
            ontime_until: hhmm(s.ontime_until), close_time: hhmm(s.close_time),
            work_days: s.work_days, require_line: s.require_line,
          },
          record: record ?? null,
          holiday: hol?.name ?? (hol ? "วันหยุด" : null),
          is_workday: !hol && s.work_days.includes(now.dow),
          today: now.date,
          server_time: new Date().toISOString(),
        });
      }

      // ---------------------------------------------------------- checkin
      case "checkin": {
        const s = await getSettings();
        if (s.lat == null || s.lng == null) return fail("ผู้ดูแลระบบยังไม่ได้ตั้งจุดเสาธง กรุณาแจ้งผู้ดูแลระบบ", "NO_LOCATION");

        const { data: hol } = await admin.from("holidays").select("name").eq("date", now.date).maybeSingle();
        if (hol) return fail(`วันนี้เป็นวันหยุด${hol.name ? ` (${hol.name})` : ""} ไม่ต้องเช็กชื่อ`, "HOLIDAY");
        if (!s.work_days.includes(now.dow)) return fail("วันนี้ไม่ใช่วันทำการ ไม่ต้องเช็กชื่อ", "NOT_WORKDAY");

        const decision = decideCheckin(now.time, s);
        if (!decision.ok) {
          return decision.code === "TOO_EARLY"
            ? fail(`ยังไม่ถึงเวลาเช็กชื่อ (เปิดเวลา ${hhmm(s.open_time)} น.)`, "TOO_EARLY")
            : fail(`หมดเวลาเช็กชื่อแล้ว (ปิดเวลา ${hhmm(s.close_time)} น.) หากมาปฏิบัติงานให้แจ้งผู้ดูแลระบบบันทึกให้`, "CLOSED");
        }

        const { data: ex } = await admin.from("attendance").select("*").eq("teacher_id", t.id).eq("date", now.date).maybeSingle();
        if (ex && (ex.status === "present" || ex.status === "late")) return ok({ already: true, record: ex });
        if (ex && !(ex.source === "teacher" && ex.status === "note")) {
          return fail(`วันนี้มีบันทึกสถานะ "${STATUS_LABEL[ex.status]}" อยู่แล้ว หากต้องการแก้ไขให้ติดต่อผู้ดูแลระบบ`, "HAS_RECORD");
        }

        const lat = Number(body.lat), lng = Number(body.lng), acc = Number(body.accuracy);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          return fail("อ่านตำแหน่ง GPS ไม่ได้ กรุณาเปิดตำแหน่งแล้วลองใหม่", "BAD_LOCATION");
        }
        const accuracy = Number.isFinite(acc) && acc >= 0 ? acc : 9999;
        if (accuracy > s.max_accuracy_m) {
          return fail(`สัญญาณ GPS ยังไม่แม่นพอ (คลาดเคลื่อนประมาณ ${Math.round(accuracy)} ม. ต้องไม่เกิน ${s.max_accuracy_m} ม.) ลองเดินไปที่โล่งแล้วกดใหม่`, "LOW_ACCURACY");
        }
        const dist = distanceM(lat, lng, s.lat, s.lng);
        if (dist > s.radius_m) {
          return fail(`คุณอยู่นอกพื้นที่เช็กชื่อ (ห่างจุดเสาธงประมาณ ${Math.round(dist)} ม. อนุญาตไม่เกิน ${s.radius_m} ม.)`, "OUT_OF_RANGE", { distance: Math.round(dist) });
        }

        if (s.require_line) {
          if (!t.line_user_id) return fail("บัญชีนี้ยังไม่ได้ผูกกับ LINE กรุณาเปิดระบบผ่านแอป LINE แล้วเข้าสู่ระบบอีกครั้ง", "LINE_NOT_BOUND");
          const v = await verifyLine(String(body.id_token ?? ""));
          if (!v.ok) return fail(v.message!, v.code!);
          if (v.sub !== t.line_user_id) return fail("บัญชี LINE นี้ไม่ตรงกับบัญชีครูที่เข้าสู่ระบบ", "LINE_MISMATCH");
        }

        const { data: record, error } = await admin.from("attendance").upsert({
          teacher_id: t.id, date: now.date, status: decision.status,
          checkin_at: new Date().toISOString(),
          lat, lng, accuracy_m: accuracy, distance_m: dist,
          note: ex?.note ?? "", source: "gps", updated_by: user.id,
        }, { onConflict: "teacher_id,date" }).select().single();
        if (error) { console.error(error); return fail("บันทึกการเช็กชื่อไม่สำเร็จ กรุณาลองใหม่", "SERVER", {}, 500); }
        return ok({ record });
      }

      // ---------------------------------------------------------- report_status
      case "report_status": {
        const status = String(body.status ?? "");
        if (!TEACHER_STATUSES.includes(status)) return fail("สถานะไม่ถูกต้อง", "INVALID");
        const note = String(body.note ?? "").trim().slice(0, 300);
        if (status === "note" && !note) return fail("กรุณาพิมพ์หมายเหตุ", "INVALID");
        const from = String(body.date_from ?? now.date);
        const to = String(body.date_to || from);
        if (!isDateStr(from) || !isDateStr(to)) return fail("รูปแบบวันที่ไม่ถูกต้อง", "INVALID");
        if (from < now.date) return fail("แจ้งย้อนหลังไม่ได้ หากต้องการแก้ไขข้อมูลย้อนหลังให้ติดต่อผู้ดูแลระบบ", "INVALID");
        if (to < from) return fail("วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น", "INVALID");
        if (to > addDays(from, MAX_RANGE_DAYS)) return fail(`เลือกช่วงวันที่ได้ไม่เกิน ${MAX_RANGE_DAYS} วันต่อครั้ง`, "INVALID");

        const s = await getSettings();
        const { data: hols } = await admin.from("holidays").select("date").gte("date", from).lte("date", to);
        const holSet = new Set((hols ?? []).map((h: any) => h.date));
        const days = datesInRange(from, to).filter((d) => s.work_days.includes(isoDow(d)) && !holSet.has(d));
        if (!days.length) return fail("ช่วงวันที่ที่เลือกไม่มีวันทำการ", "INVALID");

        const { data: existing } = await admin.from("attendance").select("date,status,source").eq("teacher_id", t.id).gte("date", from).lte("date", to);
        const exMap = new Map((existing ?? []).map((r: any) => [r.date, r]));
        const skipped: { date: string; reason: string }[] = [];
        const rows: Record<string, unknown>[] = [];
        for (const d of days) {
          const e: any = exMap.get(d);
          if (e && e.source !== "teacher") {
            skipped.push({ date: d, reason: `มีบันทึก "${STATUS_LABEL[e.status]}" อยู่แล้ว` });
            continue;
          }
          rows.push({
            teacher_id: t.id, date: d, status, note, source: "teacher", updated_by: user.id,
            checkin_at: null, lat: null, lng: null, accuracy_m: null, distance_m: null,
          });
        }
        if (rows.length) {
          const { error } = await admin.from("attendance").upsert(rows, { onConflict: "teacher_id,date" });
          if (error) { console.error(error); return fail("บันทึกไม่สำเร็จ กรุณาลองใหม่", "SERVER", {}, 500); }
        }
        return ok({ saved: rows.length, skipped });
      }

      // ---------------------------------------------------------- cancel_status
      case "cancel_status": {
        const from = String(body.date_from ?? body.date ?? "");
        const to = String(body.date_to ?? from);
        if (!isDateStr(from) || !isDateStr(to) || from < now.date || to < from) return fail("ยกเลิกได้เฉพาะรายการของวันนี้หรือล่วงหน้า", "INVALID");
        if (to > addDays(from, MAX_RANGE_DAYS + 30)) return fail("ช่วงวันที่ยาวเกินไป", "INVALID");
        const { data, error } = await admin.from("attendance").delete()
          .eq("teacher_id", t.id).gte("date", from).lte("date", to).eq("source", "teacher").select("id");
        if (error) { console.error(error); return fail("ยกเลิกไม่สำเร็จ กรุณาลองใหม่", "SERVER", {}, 500); }
        if (!data?.length) return fail("ไม่พบรายการที่ยกเลิกได้ (ยกเลิกได้เฉพาะรายการที่ครูแจ้งเอง)", "NOT_FOUND");
        return ok({});
      }

      // ---------------------------------------------------------- add_note
      case "add_note": {
        const date = String(body.date ?? "");
        const note = String(body.note ?? "").trim().slice(0, 300);
        if (!isDateStr(date) || date > now.date || date < addDays(now.date, -7)) {
          return fail("เพิ่มหมายเหตุได้เฉพาะวันนี้และย้อนหลังไม่เกิน 7 วัน", "INVALID");
        }
        const { data: rec } = await admin.from("attendance").select("id,status").eq("teacher_id", t.id).eq("date", date).maybeSingle();
        if (!rec) return fail("ยังไม่มีบันทึกของวันนั้น หากต้องการแจ้งเหตุให้ใช้เมนู \"แจ้งสถานะ\" แล้วเลือก \"หมายเหตุ\"", "NOT_FOUND");
        if (rec.status === "note" && !note) return fail("รายการนี้เป็นหมายเหตุ ต้องมีข้อความ", "INVALID");
        const { error } = await admin.from("attendance").update({ note, updated_by: user.id }).eq("id", rec.id);
        if (error) { console.error(error); return fail("บันทึกไม่สำเร็จ กรุณาลองใหม่", "SERVER", {}, 500); }
        return ok({});
      }

      // ---------------------------------------------------------- change_password
      // ใช้ทั้งตอนตั้งรหัสครั้งแรก (ยังไม่ต้องใส่รหัสเดิม) และตอนเปลี่ยนในหน้าโปรไฟล์
      case "change_password": {
        const np = String(body.new_password ?? "");
        const msg = validatePassword(np);
        if (msg) return fail(msg, "INVALID");
        if (!t.password_set && body.accept_pdpa !== true) return fail("กรุณายอมรับข้อตกลงการใช้ข้อมูลส่วนบุคคลก่อน", "INVALID");
        if (t.password_set) {
          const cur = String(body.current_password ?? "");
          const { error } = await mkAnon().auth.signInWithPassword({ email: t.email, password: cur });
          if (error) return fail("รหัสผ่านปัจจุบันไม่ถูกต้อง", "BAD_CREDENTIALS");
        }
        const same = await mkAnon().auth.signInWithPassword({ email: t.email, password: np });
        if (!same.error) return fail("รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิมหรือรหัสชั่วคราว", "INVALID");

        const { error: upErr } = await admin.auth.admin.updateUserById(user.id, { password: np });
        if (upErr) { console.error(upErr); return fail("เปลี่ยนรหัสผ่านไม่สำเร็จ กรุณาลองใหม่", "SERVER", {}, 500); }
        const patch: Record<string, unknown> = { password_set: true, failed_attempts: 0, locked_until: null };
        if (!t.pdpa_accepted_at && body.accept_pdpa === true) patch.pdpa_accepted_at = new Date().toISOString();
        await admin.from("teachers").update(patch).eq("id", t.id);
        return ok({});
      }

      // ---------------------------------------------------------- accept_pdpa
      case "accept_pdpa": {
        if (body.accept !== true) return fail("กรุณายอมรับข้อตกลงก่อน", "INVALID");
        if (!t.pdpa_accepted_at) await admin.from("teachers").update({ pdpa_accepted_at: new Date().toISOString() }).eq("id", t.id);
        return ok({});
      }

      // ---------------------------------------------------------- password_reset_done
      // เรียกจากหน้า reset.html หลังครูตั้งรหัสใหม่ผ่านลิงก์อีเมลสำเร็จ
      case "password_reset_done": {
        await admin.from("teachers").update({ password_set: true, failed_attempts: 0, locked_until: null }).eq("id", t.id);
        return ok({});
      }

      // ---------------------------------------------------------- bind_line
      case "bind_line": {
        if (t.line_user_id) return ok({ already: true });
        const v = await verifyLine(String(body.id_token ?? ""));
        if (!v.ok) return fail(v.message!, v.code!);
        const { data: other } = await admin.from("teachers").select("id").eq("line_user_id", v.sub).maybeSingle();
        if (other) return fail("บัญชี LINE นี้ถูกผูกกับครูท่านอื่นไปแล้ว ติดต่อผู้ดูแลระบบ", "LINE_TAKEN");
        await admin.from("teachers").update({ line_user_id: v.sub, line_display_name: v.name, line_bound_at: new Date().toISOString() }).eq("id", t.id);
        return ok({});
      }

      default:
        return fail("ไม่รู้จักคำสั่ง", "UNKNOWN_ACTION", {}, 400);
    }
  } catch (e) {
    console.error(e);
    return fail("เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่อีกครั้ง", "SERVER", {}, 500);
  }
});
