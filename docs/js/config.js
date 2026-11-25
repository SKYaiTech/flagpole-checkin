// =====================================================================
// ตั้งค่าที่ต้องแก้ก่อนใช้งาน (ดูขั้นตอนใน README.md)
// ค่าในไฟล์นี้เปิดเผยต่อสาธารณะได้ — ห้ามใส่ service_role key เด็ดขาด
// =====================================================================
window.APP_CONFIG = {
  // Supabase → Project Settings → API
  SUPABASE_URL: "https://tispnkkvxcyryfwoyykc.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_iFULhelqzeBvWWcupBv4FA_UVk4XxKI",

  // LINE Developers → LINE Login channel → LIFF → LIFF ID  (เช่น 1234567890-AbCdEfGh)
  // เว้นว่างไว้ = ไม่ใช้ LINE (เหมาะกับทดสอบบนคอมพิวเตอร์ และต้องปิด "ต้องยืนยัน LINE" ในหน้าตั้งค่าแอดมินด้วย)
  LIFF_ID: "2012772435-Vl8yEnTQ",

  SCHOOL_NAME: "โรงเรียนอุดรพิชัยรักษ์พิทยา",
  APP_TITLE: "เช็กชื่อครูหน้าเสาธง",
};
