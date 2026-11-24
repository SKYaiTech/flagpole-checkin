// =====================================================================
// Edge Function: auth
//   action = "login"   เข้าสู่ระบบด้วยเลขบัตรประชาชน + รหัสผ่าน (และผูกบัญชี LINE ครั้งแรก)
//   action = "line"    เข้าอัตโนมัติด้วยบัญชี LINE ที่เคยผูกไว้
//   action = "forgot"  ส่งลิงก์ตั้งรหัสผ่านใหม่ไปยังอีเมลของครู
//
// Secrets ที่ต้องตั้ง: ID_PEPPER, LINE_CHANNEL_ID, SITE_URL
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY มีให้อัตโนมัติ)
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PEPPER = Deno.env.get("ID_PEPPER") ?? "";
const LINE_CHANNEL_ID = Deno.env.get("LINE_CHANNEL_ID") ?? "";
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const BAD_CREDENTIALS = "เลขบัตรประชาชนหรือรหัสผ่านไม่ถูกต้อง";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
// </pure>

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const ok = (data: Record<string, unknown> = {}) => json({ ok: true, ...data });
const fail = (error: string, code = "ERROR", status = 200) => json({ ok: false, error, code }, status);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mkAdmin = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const mkAnon = () => createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function verifyLine(idToken: string) {
  if (!LINE_CHANNEL_ID) return { ok: false, code: "CONFIG", message: "ระบบยังไม่ได้ตั้งค่า LINE_CHANNEL_ID ใน Secrets" };
  if (!idToken) return { ok: false, code: "LINE_TOKEN", message: "ไม่พบข้อมูลบัญชี LINE กรุณาเปิดระบบผ่านแอป LINE" };
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

const safeTeacher = (t: any) => ({
  id: t.id,
  prefix: t.prefix,
  first_name: t.first_name,
  last_name: t.last_name,
  job_title: t.job_title,
  password_set: t.password_set,
  pdpa_accepted: !!t.pdpa_accepted_at,
  line_bound: !!t.line_user_id,
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method !== "POST") return fail("Method not allowed", "METHOD", 405);
    if (!PEPPER) return fail("ระบบยังไม่ได้ตั้งค่า ID_PEPPER ใน Secrets", "CONFIG", 500);
    const body = await req.json().catch(() => ({}));
    const admin = mkAdmin();

    // ------------------------------------------------------------ login
    if (body.action === "login") {
      const nid = normalizeId(body.national_id);
      const password = String(body.password ?? "");
      if (nid.length !== 13 || !password) return fail("กรอกเลขบัตรประชาชน 13 หลัก และรหัสผ่าน", "INVALID");

      const hash = await hmacHex(PEPPER, nid);
      const { data: t } = await admin.from("teachers").select("*").eq("national_id_hash", hash).maybeSingle();
      if (!t || !t.active) {
        await sleep(400);
        return fail(BAD_CREDENTIALS, "BAD_CREDENTIALS");
      }
      if (t.locked_until && new Date(t.locked_until) > new Date()) {
        const mins = Math.ceil((new Date(t.locked_until).getTime() - Date.now()) / 60000);
        return fail(`ใส่รหัสผิดหลายครั้ง ระบบล็อกชั่วคราว ลองใหม่ได้ในอีก ${mins} นาที หรือกด "ลืมรหัสผ่าน"`, "LOCKED");
      }

      // ตรวจ LINE ก่อนเปลี่ยนสถานะอะไรก็ตาม
      let line: { sub: string; name: string } | null = null;
      if (body.id_token) {
        const v = await verifyLine(String(body.id_token));
        if (!v.ok) return fail(v.message!, v.code!);
        line = { sub: v.sub!, name: v.name! };
        if (t.line_user_id && t.line_user_id !== line.sub) {
          return fail("บัญชีครูนี้ผูกกับ LINE อื่นไว้แล้ว หากเปลี่ยนโทรศัพท์หรือบัญชี LINE ให้ติดต่อผู้ดูแลระบบเพื่อยกเลิกการผูก", "LINE_MISMATCH");
        }
        if (!t.line_user_id) {
          const { data: other } = await admin.from("teachers").select("id").eq("line_user_id", line.sub).maybeSingle();
          if (other && other.id !== t.id) return fail("บัญชี LINE นี้ถูกผูกกับครูท่านอื่นไปแล้ว ติดต่อผู้ดูแลระบบ", "LINE_TAKEN");
        }
      }

      const anon = mkAnon();
      const { data: sess, error: signErr } = await anon.auth.signInWithPassword({ email: t.email, password });
      if (signErr || !sess?.session) {
        const fails = (t.failed_attempts ?? 0) + 1;
        const patch: Record<string, unknown> = { failed_attempts: fails };
        if (fails >= MAX_FAILS) {
          patch.failed_attempts = 0;
          patch.locked_until = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
        }
        await admin.from("teachers").update(patch).eq("id", t.id);
        await sleep(300);
        return fail(BAD_CREDENTIALS, "BAD_CREDENTIALS");
      }

      const patch: Record<string, unknown> = { failed_attempts: 0, locked_until: null };
      if (line && !t.line_user_id) {
        patch.line_user_id = line.sub;
        patch.line_display_name = line.name;
        patch.line_bound_at = new Date().toISOString();
      }
      const { error: updErr } = await admin.from("teachers").update(patch).eq("id", t.id);
      if (updErr) {
        console.error("update teacher", updErr);
        return fail("บันทึกการผูกบัญชี LINE ไม่สำเร็จ กรุณาลองใหม่", "SERVER", 500);
      }
      const s = sess.session;
      return ok({
        session: { access_token: s.access_token, refresh_token: s.refresh_token },
        teacher: safeTeacher({ ...t, line_user_id: t.line_user_id ?? line?.sub ?? null }),
      });
    }

    // ------------------------------------------------------------ line
    // ตรวจ LINE แล้วส่ง token_hash กลับ ให้โทรศัพท์ของครูเรียก verifyOtp เอง
    // (เพื่อไม่ให้ทุกคนไปชนเพดาน rate limit ของ IP ฝั่งเซิร์ฟเวอร์ร่วมกัน)
    if (body.action === "line") {
      const v = await verifyLine(String(body.id_token ?? ""));
      if (!v.ok) return fail(v.message!, v.code!);
      const { data: t } = await admin.from("teachers").select("*").eq("line_user_id", v.sub).maybeSingle();
      if (!t || !t.active) return ok({ bound: false });
      if (t.locked_until && new Date(t.locked_until) > new Date()) return ok({ bound: false });
      const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: t.email });
      const tokenHash = link?.properties?.hashed_token;
      if (error || !tokenHash) {
        console.error("generateLink", error);
        return fail("สร้างเซสชันไม่สำเร็จ กรุณาเข้าสู่ระบบด้วยรหัสผ่าน", "SERVER", 500);
      }
      return ok({ bound: true, token_hash: tokenHash, teacher: safeTeacher(t) });
    }

    // ------------------------------------------------------------ forgot
    if (body.action === "forgot") {
      const nid = normalizeId(body.national_id);
      if (nid.length !== 13) return fail("กรอกเลขบัตรประชาชน 13 หลัก", "INVALID");
      if (!SITE_URL) return fail("ระบบยังไม่ได้ตั้งค่า SITE_URL ใน Secrets", "CONFIG", 500);
      const hash = await hmacHex(PEPPER, nid);
      const { data: t } = await admin.from("teachers").select("email, active").eq("national_id_hash", hash).maybeSingle();
      if (t && t.active) {
        const { error } = await mkAnon().auth.resetPasswordForEmail(t.email, { redirectTo: `${SITE_URL}/reset.html` });
        if (error) {
          console.error("resetPasswordForEmail", error);
          return fail("ส่งอีเมลไม่สำเร็จ (อาจส่งถี่เกินไปหรือระบบอีเมลมีปัญหา) กรุณารอสักครู่แล้วลองใหม่ หรือติดต่อผู้ดูแลระบบ", "EMAIL_FAILED");
        }
      } else {
        await sleep(500);
      }
      return ok({ message: "หากข้อมูลถูกต้อง ระบบได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปยังอีเมลที่ลงทะเบียนไว้กับโรงเรียนแล้ว กรุณาตรวจสอบกล่องจดหมายและจดหมายขยะ" });
    }

    return fail("ไม่รู้จักคำสั่ง", "UNKNOWN_ACTION", 400);
  } catch (e) {
    console.error(e);
    return fail("เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่อีกครั้ง", "SERVER", 500);
  }
});
