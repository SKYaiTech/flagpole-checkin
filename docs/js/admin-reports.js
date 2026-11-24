// โมดูลรายงาน (แสดงผล พิมพ์ และส่งออก Excel) — admin.js เรียกใช้ผ่าน window.AdminReports(A)
window.AdminReports = function (A) {
  const { $, $$, esc, STATUS, thaiDate, thaiMonthYear, monthRange, bkkParts, bkkToday, datesBetween, dowOf, fmtTime, fullName, hhmm,
    TH_DAYS_SHORT, TH_MONTHS, isoDow, ymd, pad, download, toast } = App;
  const STATUS_COLS = ["present", "late", "personal", "sick", "official", "maternity", "note"];
  const R = { type: "daily", last: null };

  // ---------------------------------------------------------------- ส่วนประกอบรายงาน
  function header(title, sub) {
    const s = A.settings;
    return `<div class="rp-head">${s.logo_url ? `<img src="${esc(s.logo_url)}" alt="">` : ""}
      ${s.org_name ? `<div class="org">${esc(s.org_name)}</div>` : ""}
      <div class="school">${esc(s.school_name)}</div>
      <div class="title">${esc(title)}</div><div class="sub">${esc(sub)}</div></div>`;
  }
  function signBlock() {
    const s = A.settings, dots = "................................................";
    return `<div class="sign">
      <div>ลงชื่อ ${dots}<br>(${dots})<br>${esc(s.inspector_title)}</div>
      <div>ลงชื่อ ${dots}<br>(${s.director_name ? esc(s.director_name) : dots})<br>${esc(s.director_title)}</div></div>`;
  }
  const todayInfo = () => {
    const p = bkkParts();
    return { today: p.date, afterClose: p.time.slice(0, 5) > hhmm(A.settings.close_time) };
  };
  // สถานะของครู 1 คน ในวันหนึ่ง: status key | out (นอกช่วงที่ทำงาน) | off (วันหยุด) | none (ไม่ได้เช็ก) | pending (ยังไม่ถึงเวลา)
  function cellState(t, d, rec, ti) {
    if (rec) return rec.status;
    if ((t.start_date && d < t.start_date) || (t.end_date && d > t.end_date)) return "out";
    if (!A.isWorkday(d)) return "off";
    if (d < ti.today || (d === ti.today && ti.afterClose)) return "none";
    return "pending";
  }
  async function loadRecs(from, to) {
    const rows = await A.fetchAll(() => A.sb.from("attendance").select("teacher_id,date,status,checkin_at,note").gte("date", from).lte("date", to).order("date").order("id"));
    const m = new Map();
    for (const r of rows) m.set(r.teacher_id + "|" + r.date, r);
    return m;
  }
  const teachersIn = (from, to) => A.teachers.filter((t) => (!t.start_date || t.start_date <= to) && (!t.end_date || t.end_date >= from) && (t.active || (t.end_date && t.end_date >= from)));
  function tally(t, dates, recs, ti) {
    const c = { work: 0, none: 0 }; STATUS_COLS.forEach((k) => (c[k] = 0));
    for (const d of dates) {
      const rec = recs.get(t.id + "|" + d), st = cellState(t, d, rec, ti);
      if (STATUS_COLS.includes(st)) { c[st]++; if (A.isWorkday(d)) c.work++; }
      else if (st === "none") { c.none++; c.work++; }
    }
    return c;
  }
  const legend = `<div class="legend">สัญลักษณ์: / = มา, ส = สาย, ก = ลากิจ, ป = ลาป่วย, ร = ไปราชการ, ค = ลาคลอด, ห = หมายเหตุ, × = ไม่ได้เช็กชื่อ, แถบสีเทา = วันหยุด/ไม่ใช่วันทำการ</div>`;

  // ---------------------------------------------------------------- 1) รายวัน
  async function daily(p) {
    const date = p.date, ti = todayInfo();
    const recs = await loadRecs(date, date);
    const list = A.teachersOn(date);
    const cnt = { none: 0 }; STATUS_COLS.forEach((k) => (cnt[k] = 0));
    const off = !A.isWorkday(date);
    const rows = list.map((t, i) => {
      const rec = recs.get(t.id + "|" + date), st = cellState(t, date, rec, ti);
      let label, time = "", note = rec ? rec.note : "";
      if (rec) { cnt[rec.status]++; label = STATUS[rec.status].label; time = rec.checkin_at ? fmtTime(rec.checkin_at) : ""; }
      else if (st === "none") { cnt.none++; label = "ไม่ได้เช็กชื่อ"; }
      else if (st === "pending") label = "ยังไม่เช็กชื่อ";
      else label = "-";
      return { i: i + 1, name: fullName(t), job: t.job_title, time, label, note };
    });
    const html = `<div class="rp">${header("รายงานการเช็กชื่อครูหน้าเสาธง", `ประจำ${thaiDate(date, { weekday: true })}`)}
      ${off ? `<div class="center">(${A.holidays.has(date) ? "วันหยุด: " + esc(A.holidays.get(date) || "วันหยุด") : "ไม่ใช่วันทำการ"})</div>` : ""}
      <table><thead><tr><th style="width:36px">ที่</th><th>ชื่อ-สกุล</th><th>ตำแหน่ง</th><th style="width:60px">เวลา</th><th style="width:100px">สถานะ</th><th>หมายเหตุ</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="c">${r.i}</td><td class="l">${esc(r.name)}</td><td class="l">${esc(r.job)}</td><td class="c">${r.time}</td><td class="c">${esc(r.label)}</td><td class="l">${esc(r.note)}</td></tr>`).join("")}
      </tbody></table>
      <div class="sumline">รวม ${list.length} คน — ${STATUS_COLS.filter((k) => cnt[k]).map((k) => `${STATUS[k].label} ${cnt[k]}`).join(" · ")}${cnt.none ? ` · ไม่ได้เช็กชื่อ ${cnt.none}` : ""} คน</div>
      ${signBlock()}</div>`;
    const aoa = [["ที่", "ชื่อ-สกุล", "ตำแหน่ง", "เวลา", "สถานะ", "หมายเหตุ"], ...rows.map((r) => [r.i, r.name, r.job, r.time, r.label, r.note])];
    return { html, aoa, name: "รายวัน " + date, landscape: false, file: `รายงานรายวัน_${date}` };
  }

  // ---------------------------------------------------------------- 2) รายเดือน (ตาราง)
  async function monthly(p) {
    const [y, m] = p.month.split("-").map(Number);
    const { from, to, days } = monthRange(y, m), ti = todayInfo();
    const recs = await loadRecs(from, to), dates = datesBetween(from, to);
    const list = teachersIn(from, to);
    const head1 = dates.map((d) => `<th class="${A.isWorkday(d) ? "" : "off"}">${ymd(d).d}</th>`).join("");
    const head2 = dates.map((d) => `<th class="${A.isWorkday(d) ? "" : "off"}">${TH_DAYS_SHORT[dowOf(d)].replace(".", "")}</th>`).join("");
    const aoa = [["ที่", "ชื่อ-สกุล", ...dates.map((d) => ymd(d).d), "มา", "สาย", "ลากิจ", "ลาป่วย", "ราชการ", "ลาคลอด", "หมายเหตุ", "ไม่ได้เช็ก"]];
    const body = list.map((t, i) => {
      const c = tally(t, dates, recs, ti); const row = [i + 1, fullName(t)];
      const cells = dates.map((d) => {
        const rec = recs.get(t.id + "|" + d), st = cellState(t, d, rec, ti);
        let mark = "", cls = "";
        if (STATUS_COLS.includes(st)) mark = STATUS[st].mark;
        else if (st === "none") { mark = "×"; cls = "none"; }
        else if (st === "off" || st === "out") cls = "off";
        row.push(mark);
        return `<td class="${cls}">${mark}</td>`;
      }).join("");
      row.push(c.present, c.late, c.personal, c.sick, c.official, c.maternity, c.note, c.none); aoa.push(row);
      return `<tr><td>${i + 1}</td><td class="name">${esc(fullName(t))}</td>${cells}${[c.present, c.late, c.personal, c.sick, c.official, c.maternity, c.note, c.none].map((n) => `<td>${n || ""}</td>`).join("")}</tr>`;
    }).join("");
    const html = `<div class="rp">${header("รายงานการเช็กชื่อครูหน้าเสาธง (รายเดือน)", `ประจำเดือน${thaiMonthYear(y, m)}`)}
      <table class="matrix"><thead>
        <tr><th rowspan="2" style="width:22px">ที่</th><th rowspan="2" style="width:150px">ชื่อ-สกุล</th>${head1}<th rowspan="2">มา</th><th rowspan="2">สาย</th><th rowspan="2">ลา<br>กิจ</th><th rowspan="2">ลา<br>ป่วย</th><th rowspan="2">ราช<br>การ</th><th rowspan="2">ลา<br>คลอด</th><th rowspan="2">หมาย<br>เหตุ</th><th rowspan="2">ไม่ได้<br>เช็ก</th></tr>
        <tr>${head2}</tr></thead><tbody>${body}</tbody></table>
      ${legend}${signBlock()}</div>`;
    return { html, aoa, name: `${TH_MONTHS[m - 1]} ${y + 543}`, landscape: true, file: `รายงานรายเดือน_${p.month}` };
  }

  // ---------------------------------------------------------------- 3) สรุปตามช่วงวันที่
  async function range(p) {
    const { from, to } = p, ti = todayInfo();
    const recs = await loadRecs(from, to), dates = datesBetween(from, to);
    const list = teachersIn(from, to);
    const aoa = [["ที่", "ชื่อ-สกุล", "ตำแหน่ง", "วันทำการ", "มา", "สาย", "ลากิจ", "ลาป่วย", "ราชการ", "ลาคลอด", "หมายเหตุ", "ไม่ได้เช็ก", "ร้อยละที่มา(รวมสาย)"]];
    const rows = list.map((t, i) => {
      const c = tally(t, dates, recs, ti), pct = c.work ? Math.round(((c.present + c.late) / c.work) * 1000) / 10 : "";
      aoa.push([i + 1, fullName(t), t.job_title, c.work, c.present, c.late, c.personal, c.sick, c.official, c.maternity, c.note, c.none, pct]);
      return `<tr><td class="c">${i + 1}</td><td class="l">${esc(fullName(t))}</td><td class="c">${c.work}</td>
        ${[c.present, c.late, c.personal, c.sick, c.official, c.maternity, c.note, c.none].map((n) => `<td class="c">${n || "-"}</td>`).join("")}<td class="c">${pct === "" ? "-" : pct}</td></tr>`;
    }).join("");
    const html = `<div class="rp">${header("รายงานสรุปการเช็กชื่อครูหน้าเสาธง", `ตั้งแต่${thaiDate(from)} ถึง ${thaiDate(to)}`)}
      <table><thead><tr><th style="width:30px">ที่</th><th>ชื่อ-สกุล</th><th>วัน<br>ทำการ</th><th>มา</th><th>สาย</th><th>ลากิจ</th><th>ลาป่วย</th><th>ราชการ</th><th>ลาคลอด</th><th>หมายเหตุ</th><th>ไม่ได้<br>เช็ก</th><th>ร้อยละ<br>ที่มา</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="legend">ร้อยละที่มา = (มา + สาย) ÷ วันทำการ × 100 · "ไม่ได้เช็ก" คือวันทำการที่ไม่มีบันทึกใดเลย</div>${signBlock()}</div>`;
    return { html, aoa, name: "สรุป", landscape: false, file: `รายงานสรุป_${from}_${to}` };
  }

  // ---------------------------------------------------------------- 4) รายบุคคล
  async function person(p) {
    const t = A.tmap.get(p.teacher);
    if (!t) throw new Error("กรุณาเลือกครู");
    const { from, to } = p, ti = todayInfo();
    const recs = await loadRecs(from, to), dates = datesBetween(from, to);
    const c = tally(t, dates, recs, ti);
    const aoa = [["วันที่", "วัน", "เวลา", "สถานะ", "หมายเหตุ"]];
    const rows = dates.map((d) => {
      const rec = recs.get(t.id + "|" + d), st = cellState(t, d, rec, ti);
      let label = "", time = "", note = rec ? rec.note : "", cls = "";
      if (STATUS_COLS.includes(st)) { label = STATUS[st].label; time = rec.checkin_at ? fmtTime(rec.checkin_at) : ""; }
      else if (st === "none") label = "ไม่ได้เช็กชื่อ";
      else if (st === "pending") label = "ยังไม่ถึงเวลา";
      else { label = A.holidays.get(d) || (st === "out" ? "-" : "วันหยุด"); cls = "off"; }
      aoa.push([thaiDate(d, { short: true }), TH_DAYS_SHORT[dowOf(d)], time, label, note]);
      return `<tr style="${cls ? "background:#e5e5e5" : ""}"><td class="l">${thaiDate(d, { short: true, shortYear: true })}</td><td class="c">${TH_DAYS_SHORT[dowOf(d)]}</td><td class="c">${time}</td><td class="c">${esc(label)}</td><td class="l">${esc(note)}</td></tr>`;
    }).join("");
    const html = `<div class="rp">${header("รายงานการเช็กชื่อหน้าเสาธงรายบุคคล", `${fullName(t)}${t.job_title ? " · " + t.job_title : ""}`)}
      <div class="center sub">ตั้งแต่${thaiDate(from)} ถึง ${thaiDate(to)}</div>
      <table><thead><tr><th style="width:90px">วันที่</th><th style="width:40px">วัน</th><th style="width:60px">เวลา</th><th style="width:110px">สถานะ</th><th>หมายเหตุ</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="sumline">สรุป: วันทำการ ${c.work} วัน — ${STATUS_COLS.filter((k) => c[k]).map((k) => `${STATUS[k].label} ${c[k]}`).join(" · ") || "ไม่มีข้อมูล"}${c.none ? ` · ไม่ได้เช็กชื่อ ${c.none}` : ""} วัน</div>
      ${signBlock()}</div>`;
    return { html, aoa, name: "รายบุคคล", landscape: false, file: `รายงานรายบุคคล_${t.first_name}_${from}_${to}` };
  }

  // ---------------------------------------------------------------- หน้าจอ
  const TYPES = [["daily", "รายวัน"], ["monthly", "รายเดือน (ตาราง)"], ["range", "สรุปตามช่วงวันที่"], ["person", "รายบุคคล"]];
  function params(type) {
    const today = bkkToday(), m = today.slice(0, 7), first = today.slice(0, 7) + "-01";
    if (type === "daily") return `<label>วันที่ <input type="date" id="pDate" value="${today}"></label>`;
    if (type === "monthly") return `<label>เดือน <input type="month" id="pMonth" value="${m}"></label>`;
    if (type === "range") return `<label>ตั้งแต่ <input type="date" id="pFrom" value="${first}"></label><label>ถึง <input type="date" id="pTo" value="${today}"></label>`;
    return `<label>ครู <select id="pTeacher">${A.teachers.map((t) => `<option value="${t.id}">${esc(fullName(t))}${t.active ? "" : " (ปิดใช้งาน)"}</option>`).join("")}</select></label>
      <label>ตั้งแต่ <input type="date" id="pFrom" value="${first}"></label><label>ถึง <input type="date" id="pTo" value="${today}"></label>`;
  }
  function readParams(type) {
    const g = (id) => ($("#" + id) ? $("#" + id).value : "");
    if (type === "daily") return { date: g("pDate") };
    if (type === "monthly") return { month: g("pMonth") };
    if (type === "range") return { from: g("pFrom"), to: g("pTo") };
    return { teacher: g("pTeacher"), from: g("pFrom"), to: g("pTo") };
  }
  async function generate() {
    const out = $("#rOut"), p = readParams(R.type);
    if ((R.type === "daily" && !p.date) || (R.type === "monthly" && !p.month) || ((R.type === "range" || R.type === "person") && (!p.from || !p.to))) { toast("กรุณาเลือกวันที่ให้ครบ", "err"); return; }
    if (p.from && p.to && p.to < p.from) { toast("วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น", "err"); return; }
    if (p.from && p.to && A.addDays(p.from, 400) < p.to) { toast("เลือกช่วงวันที่ได้ไม่เกิน 400 วัน", "err"); return; }
    out.innerHTML = `<div class="muted center" style="padding:30px">กำลังสร้างรายงาน…</div>`;
    try {
      R.last = await ({ daily, monthly, range, person })[R.type](p);
      out.innerHTML = R.last.html;
      $("#rPrint").disabled = false; $("#rXlsx").disabled = false;
    } catch (e) {
      R.last = null; out.innerHTML = `<div class="alert alert-err">${esc(e.message || e)}</div>`;
      $("#rPrint").disabled = true; $("#rXlsx").disabled = true;
    }
  }
  async function exportXlsx() {
    if (!R.last) return;
    const XLSX = await A.loadXlsx();
    const ws = XLSX.utils.aoa_to_sheet(R.last.aoa), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, String(R.last.name).slice(0, 31).replace(/[\\/?*[\]:]/g, " "));
    XLSX.writeFile(wb, R.last.file + ".xlsx");
  }

  function view() {
    const main = $("#main");
    main.innerHTML = `
      <div class="page-head"><h1>รายงาน</h1></div>
      <div class="card no-print">
        <div class="tabs" id="rTabs">${TYPES.map(([k, l]) => `<button data-t="${k}" class="${R.type === k ? "on" : ""}">${l}</button>`).join("")}</div>
        <div class="toolbar" id="rParams">${params(R.type)}</div>
        <div class="toolbar mt"><button class="btn btn-primary" id="rGo">แสดงรายงาน</button>
          <button class="btn" id="rPrint" disabled>🖨️ พิมพ์ / บันทึก PDF</button>
          <button class="btn" id="rXlsx" disabled>📥 ส่งออก Excel</button></div>
        <p class="hint">รายงานเป็นรูปแบบร่างตามที่ใช้ทั่วไป หากโรงเรียนมีแบบฟอร์มเฉพาะ สามารถส่งตัวอย่างมาปรับหัวกระดาษและคอลัมน์ให้ตรงกันได้ · ตั้งชื่อโรงเรียน/โลโก้/ชื่อผู้อำนวยการได้ที่เมนู "ตั้งค่า"</p>
      </div>
      <div class="card" id="rOut" style="overflow:auto"><div class="muted center">เลือกประเภทรายงานและกด "แสดงรายงาน"</div></div>`;
    $("#rTabs").onclick = (e) => {
      const b = e.target.closest("button[data-t]"); if (!b) return;
      R.type = b.dataset.t; R.last = null; view();
    };
    $("#rGo").onclick = generate;
    $("#rXlsx").onclick = () => exportXlsx().catch((e) => toast(e.message, "err"));
    $("#rPrint").onclick = () => R.last && A.printHtml(R.last.html, { landscape: R.last.landscape });
  }

  return { view };
};
