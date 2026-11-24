// ฟังก์ชันที่ใช้ร่วมกันทั้งหน้าครู หน้าแอดมิน และหน้ารีเซ็ตรหัส
(function () {
  const cfg = window.APP_CONFIG || {};

  // ---------- สถานะการเช็กชื่อ ----------
  const STATUS = {
    present:   { label: "มา",       mark: "/", cls: "s-present" },
    late:      { label: "สาย",      mark: "ส", cls: "s-late" },
    personal:  { label: "ลากิจ",    mark: "ก", cls: "s-personal" },
    sick:      { label: "ลาป่วย",   mark: "ป", cls: "s-sick" },
    official:  { label: "ราชการ",   mark: "ร", cls: "s-official" },
    maternity: { label: "ลาคลอด",   mark: "ค", cls: "s-maternity" },
    note:      { label: "หมายเหตุ", mark: "ห", cls: "s-note" },
  };
  const STATUS_KEYS = Object.keys(STATUS);
  const SOURCE_LABEL = { gps: "GPS", teacher: "ครูแจ้งเอง", admin: "ผู้ดูแลบันทึก" };

  // ---------- DOM / ข้อความ ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const pad = (n) => String(n).padStart(2, "0");
  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function toast(msg, type = "ok") {
    const box = document.getElementById("toast");
    if (!box) return;
    const el = document.createElement("div");
    el.className = "toast-item " + type;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.classList.add("show"), 10);
    setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, type === "err" ? 5000 : 2800);
  }

  // ---------- วันที่ (เวลาไทย, พ.ศ.) ----------
  const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  const TH_MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const TH_DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
  const TH_DAYS_SHORT = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];

  function bkkParts(d = new Date()) {
    const iso = new Date(d.getTime() + 7 * 3600 * 1000).toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
  }
  const bkkToday = () => bkkParts().date;
  function addDays(s, n) { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  const dowOf = (s) => new Date(s + "T00:00:00Z").getUTCDay();            // 0=อาทิตย์
  const isoDow = (s) => ((dowOf(s) + 6) % 7) + 1;                         // 1=จันทร์ ... 7=อาทิตย์
  function datesBetween(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }
  function ymd(s) { const [y, m, d] = s.split("-").map(Number); return { y, m, d }; }

  function thaiDate(s, opts = {}) {
    const { y, m, d } = ymd(s);
    const mon = opts.short ? TH_MONTHS_SHORT[m - 1] : TH_MONTHS[m - 1];
    const yr = opts.shortYear ? String((y + 543) % 100).padStart(2, "0") : y + 543;
    const wd = opts.weekday ? (opts.short ? TH_DAYS_SHORT : TH_DAYS)[dowOf(s)] + (opts.short ? " " : "ที่ ") : "";
    return `${wd}${d} ${mon} ${yr}`;
  }
  const thaiMonthYear = (y, m) => `${TH_MONTHS[m - 1]} ${y + 543}`;
  function monthRange(y, m) {
    const from = `${y}-${pad(m)}-01`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from, to: `${y}-${pad(m)}-${pad(last)}`, days: last };
  }
  function fmtTime(iso) { return iso ? bkkParts(new Date(iso)).time.slice(0, 5) : ""; }
  const hhmm = (t) => String(t ?? "").slice(0, 5);

  // รับวันที่หลายรูปแบบ (ใช้ตอนนำเข้า Excel): YYYY-MM-DD, D/M/YYYY (รองรับ พ.ศ.), เลขลำดับวันที่ของ Excel
  function parseDateFlexible(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number" && isFinite(v) && v > 20000 && v < 80000) {
      return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    let y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
    else return undefined;
    if (y > 2400) y -= 543;
    const out = `${y}-${pad(mo)}-${pad(d)}`;
    const t = new Date(out + "T00:00:00Z");
    return !isNaN(t) && t.toISOString().slice(0, 10) === out ? out : undefined;
  }

  // ---------- ชื่อครู ----------
  const fullName = (t) => `${t.prefix || ""}${t.first_name} ${t.last_name}`.trim();
  const sortTeachers = (arr) => arr.slice().sort((a, b) =>
    (a.sort_order - b.sort_order) || a.first_name.localeCompare(b.first_name, "th") || a.last_name.localeCompare(b.last_name, "th"));
  function formatNid(digits) {
    const d = String(digits).replace(/\D/g, "").slice(0, 13);
    const parts = [1, 4, 5, 2, 1]; const out = []; let i = 0;
    for (const n of parts) { if (i >= d.length) break; out.push(d.slice(i, i + n)); i += n; }
    return out.join("-");
  }

  // ---------- ไฟล์ ----------
  function download(filename, data, mime = "application/octet-stream") {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- Supabase / Edge Function ----------
  function makeClient(storageKey, detectSessionInUrl = false, persistSession = true) {
    return window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession, autoRefreshToken: persistSession, detectSessionInUrl, storageKey },
    });
  }
  async function callFn(name, body, token) {
    let res;
    try {
      res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: cfg.SUPABASE_ANON_KEY, Authorization: "Bearer " + (token || cfg.SUPABASE_ANON_KEY) },
        body: JSON.stringify(body || {}),
      });
    } catch (e) {
      return { ok: false, code: "NETWORK", error: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่" };
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!data) return { ok: false, code: "BAD_RESPONSE", error: `เซิร์ฟเวอร์ตอบกลับผิดปกติ (${res.status})` };
    if (data.ok === undefined) {
      return { ok: false, code: "GATEWAY", error: (data.message || data.error || "เรียกใช้ฟังก์ชันไม่สำเร็จ") + " (ตรวจว่าได้ปิด Verify JWT ของ Edge Function แล้ว)" };
    }
    return data;
  }

  // ---------- UI เล็ก ๆ ----------
  function setBusy(btn, busy, text) {
    if (!btn) return;
    if (busy) { btn.dataset.label = btn.textContent; btn.disabled = true; if (text) btn.textContent = text; }
    else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
  }

  window.App = {
    cfg, STATUS, STATUS_KEYS, SOURCE_LABEL, TH_MONTHS, TH_MONTHS_SHORT, TH_DAYS, TH_DAYS_SHORT,
    esc, $, $$, pad, debounce, toast, bkkParts, bkkToday, addDays, dowOf, isoDow, datesBetween, ymd,
    thaiDate, thaiMonthYear, monthRange, fmtTime, hhmm, parseDateFlexible, fullName, sortTeachers, formatNid,
    download, makeClient, callFn, setBusy,
  };
})();
