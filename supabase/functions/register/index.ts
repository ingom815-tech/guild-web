// 대시보드 웹 에디터에 배포 가능하도록 의도적으로 단일 파일(자체 완결) 구성.
// 회원가입(가입 신청) — 무인증 엔드포인트. 원본 로그인 화면의 가입 탭(app.py:1769-1886) 이식.
// 신청은 registration_requests에 '대기' 상태로 저장되고 운영진 승인 후 members로 반영된다.
import { createClient } from "npm:@supabase/supabase-js@2";
import bcrypt from "npm:bcryptjs@2.4.3";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function handlePreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return null;
}

function getServiceRoleKey(): string {
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeysRaw) {
    try {
      const parsed = JSON.parse(secretKeysRaw);
      if (parsed && typeof parsed.default === "string" && parsed.default) return parsed.default;
    } catch {
      // 폴백
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("서비스 롤 키를 찾을 수 없습니다.");
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, getServiceRoleKey());

const EQUIPMENT_SLOTS = [
  "주무기", "특화무기", "투구", "상의", "망토", "허리띠", "바지", "신발", "장갑",
  "반지 1", "반지 2", "귀걸이 1", "귀걸이 2", "팔찌", "목걸이", "브로치", "가더",
  "2층 부적", "3층 부적",
];
const EQUIPMENT_GRADES = ["희귀", "영웅", "전설", "신화", "절대자"];
const AQUI_IDS = new Set(
  ["A", "B", "C"].flatMap((g) => [
    `${g}1`, `${g}2`, `${g}3`, `${g}4`, `${g}5`, `${g}6`,
    `${g}_pot`, `${g}_s1`, `${g}_s2`, `${g}_s3`, `${g}_s4`, `${g}_s5`, `${g}_s6`,
  ]),
);
// 원본 가입 폼의 권한 선택지 그대로 (결사원/운영진 — 관리자는 불가)
const REG_ROLES = ["결사원", "운영진"];

function validateEquipmentInfo(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "equipment_info 형식이 잘못됐습니다.";
    for (const [slot, grade] of Object.entries(parsed)) {
      if (!EQUIPMENT_SLOTS.includes(slot)) return `알 수 없는 장비 슬롯: ${slot}`;
      if (!EQUIPMENT_GRADES.includes(String(grade))) return `알 수 없는 장비 등급: ${grade}`;
    }
    return null;
  } catch {
    return "equipment_info는 JSON 형식이어야 합니다.";
  }
}

function validateStatusCheck(raw: string): string | null {
  const m = raw.match(/^T:(\d+)\|(.*)$/);
  if (!m) return "status_check 형식이 잘못됐습니다.";
  const body = m[2];
  if (!body) return Number(m[1]) === 0 ? null : "status_check 보유 수가 목록과 다릅니다.";
  const tokens = body.split(",");
  for (const t of tokens) {
    const parts = t.split(":");
    if (parts.length !== 2 || !AQUI_IDS.has(parts[0]) || !["l", "m"].includes(parts[1])) {
      return `잘못된 아퀴 항목: ${t}`;
    }
  }
  if (Number(m[1]) !== tokens.length) return "status_check 보유 수가 목록과 다릅니다.";
  return null;
}

const BUCKET = "screenshots";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

async function ensureBucket(): Promise<void> {
  const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
  if (error && !String(error.message || "").toLowerCase().includes("already")) {
    throw new Error("스토리지 버킷 생성 실패: " + error.message);
  }
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const m = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime: m[1] };
  } catch {
    return null;
  }
}

async function uploadImages(pathPrefix: string, images: string[]): Promise<string[]> {
  await ensureBucket();
  const urls: string[] = [];
  const ts = Date.now();
  for (let i = 0; i < images.length; i++) {
    const parsed = dataUrlToBytes(images[i]);
    if (!parsed) throw new Error(`이미지 형식이 잘못됐습니다 (${i + 1}번째).`);
    if (parsed.bytes.length > MAX_IMAGE_BYTES) throw new Error(`이미지가 너무 큽니다 (${i + 1}번째).`);
    const path = `${pathPrefix}/${ts}_${i}.jpg`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, parsed.bytes, {
      contentType: parsed.mime,
      upsert: true,
    });
    if (error) throw new Error(`이미지 업로드 실패 (${i + 1}번째): ${error.message}`);
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    urls.push(data.publicUrl);
  }
  return urls;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return jsonResponse({ error: "POST만 지원합니다." }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
  }

  const user_id = typeof body.user_id === "string" ? body.user_id.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const current_id = typeof body.current_id === "string" ? body.current_id.trim() : "";
  if (!user_id) return jsonResponse({ error: "아이디를 입력해주세요." }, 400);
  if (!password || password.length < 4) return jsonResponse({ error: "비밀번호는 4자 이상이어야 합니다." }, 400);
  if (!current_id) return jsonResponse({ error: "닉네임을 입력해주세요." }, 400);

  const role = typeof body.role === "string" && REG_ROLES.includes(body.role) ? body.role : "결사원";

  // 중복 체크 (원본 add_registration_request와 동일: 기존 신청 / 기존 회원)
  const { data: existingReq } = await supabase
    .from("registration_requests")
    .select("id, status")
    .eq("user_id", user_id)
    .maybeSingle();
  if (existingReq && existingReq.status === "대기") {
    return jsonResponse({ error: "이미 가입 신청이 접수되어 승인 대기 중입니다." }, 409);
  }
  const { data: existingMember } = await supabase
    .from("members")
    .select("user_id")
    .eq("user_id", user_id)
    .maybeSingle();
  if (existingMember) return jsonResponse({ error: "이미 등록된 아이디입니다." }, 409);

  // 장비/아퀴 (선택)
  const equipment_info = typeof body.equipment_info === "string" && body.equipment_info ? body.equipment_info : null;
  if (equipment_info) {
    const err = validateEquipmentInfo(equipment_info);
    if (err) return jsonResponse({ error: err }, 400);
  }
  const status_check = typeof body.status_check === "string" && body.status_check ? body.status_check : null;
  if (status_check) {
    const err = validateStatusCheck(status_check);
    if (err) return jsonResponse({ error: err }, 400);
  }

  // 스샷 업로드 (전투력 1장 안내지만 다중 허용 — 원본과 동일. 각 최대 10장)
  const powerImages = Array.isArray(body.power_images) ? (body.power_images as string[]).slice(0, 10) : [];
  const aquiImages = Array.isArray(body.aqui_images) ? (body.aqui_images as string[]).slice(0, 10) : [];
  let powerUrls: string[] = [];
  let aquiUrls: string[] = [];
  try {
    if (powerImages.length) powerUrls = await uploadImages(`registrations/${user_id}/power`, powerImages);
    if (aquiImages.length) aquiUrls = await uploadImages(`registrations/${user_id}/aqui`, aquiImages);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 400);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const row: Record<string, unknown> = {
    user_id,
    password: passwordHash,
    current_id,
    role,
    guild_name: typeof body.guild_name === "string" ? body.guild_name.trim() || null : null,
    subjugation_rank: typeof body.subjugation_rank === "string" ? body.subjugation_rank.trim() || null : null,
    level: Number.isInteger(Number(body.level)) && Number(body.level) >= 0 ? Number(body.level) : 0,
    class: typeof body.class === "string" ? body.class.trim() || null : null,
    abyss_level: typeof body.abyss_level === "string" ? body.abyss_level.trim() || null : null,
    power: Number.isInteger(Number(body.power)) && Number(body.power) >= 0 ? Number(body.power) : 0,
    equipment_info,
    status_check,
    power_img_url: powerUrls.length ? JSON.stringify(powerUrls) : null,
    status_check_img_url: aquiUrls.length ? JSON.stringify(aquiUrls) : null,
    status: "대기",
  };

  // 과거 거절/승인된 신청이 남아있으면(UNIQUE user_id) 갱신, 아니면 신규 INSERT
  if (existingReq) {
    const { error } = await supabase.from("registration_requests").update({ ...row, approved_at: null }).eq("id", existingReq.id);
    if (error) return jsonResponse({ error: "가입 신청 저장에 실패했습니다." }, 500);
  } else {
    const { error } = await supabase.from("registration_requests").insert(row);
    if (error) return jsonResponse({ error: "가입 신청 저장에 실패했습니다." }, 500);
  }

  return jsonResponse({ ok: true, message: "가입 신청이 접수되었습니다. 운영진 승인 후 로그인할 수 있습니다." }, 201);
});
