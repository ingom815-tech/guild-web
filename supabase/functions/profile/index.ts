// 대시보드 웹 에디터에 배포 가능하도록 의도적으로 단일 파일(자체 완결) 구성.
// 내 정보(셀프서비스): 기본정보/장비/아퀴/비밀번호 수정, 인증샷 업로드(Storage),
// 내 분배이력 조회, 긴급 참여조 선택. 분배 기간 진행 중에는 수정 잠금(원본 _profile_locked).
import { createClient } from "npm:@supabase/supabase-js@2";
import bcrypt from "npm:bcryptjs@2.4.3";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
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

interface SessionUser {
  user_id: string;
  current_id: string | null;
  role: string;
}

async function validateSession(token: string | null): Promise<SessionUser | null> {
  if (!token) return null;
  const { data: session, error: sessionErr } = await supabase
    .from("user_sessions")
    .select("user_id, expires_at")
    .eq("session_token", token)
    .maybeSingle();
  if (sessionErr || !session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;

  const { data: member, error: memberErr } = await supabase
    .from("members")
    .select("user_id, current_id, role")
    .eq("user_id", session.user_id)
    .maybeSingle();
  if (memberErr || !member) return null;

  return { user_id: member.user_id, current_id: member.current_id, role: member.role };
}

async function getCurrentSeason(): Promise<number> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "current_season").maybeSingle();
  if (data && data.value != null && !Number.isNaN(parseInt(data.value, 10))) return parseInt(data.value, 10);
  return 1;
}

// ── 장비/아퀴 검증 (members 함수와 동일 규칙) ──
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

// ── 분배 기간 잠금 (원본 _profile_locked: 활성 기간의 end_time이 미래면 잠금) ──
function kstNowEpoch(): number {
  return Date.now() + 9 * 3600 * 1000;
}
function naiveKstToEpoch(ts: string): number {
  return new Date(ts.replace(" ", "T") + (ts.endsWith("Z") ? "" : "Z")).getTime();
}
async function isProfileLocked(): Promise<boolean> {
  const { data } = await supabase
    .from("distribution_period")
    .select("end_time")
    .eq("status", "진행중")
    .order("id", { ascending: false })
    .limit(1);
  if (!data || !data.length) return false;
  return kstNowEpoch() < naiveKstToEpoch(String(data[0].end_time));
}

// ── 이미지 (Storage) ──
const BUCKET = "screenshots";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 서버측 상한 (클라 1.5MB + 여유)

// Storage 키는 비ASCII를 허용하지 않음 ("붐붐" 같은 한글 아이디 → Invalid key).
// 허용 외 문자를 UTF-8 hex로 치환 — ASCII 아이디는 그대로, 한글 아이디도 항상 같은 경로로 매핑.
function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, (ch) =>
    Array.from(new TextEncoder().encode(ch)).map((b) => "x" + b.toString(16)).join(""),
  );
}

async function ensureBucket(): Promise<void> {
  const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
  if (error && !String(error.message || "").toLowerCase().includes("already")) {
    // "already exists" 외 오류만 전파
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

// base64 배열 → Storage 업로드 → 공개 URL 배열
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

// 원본 parse_img_urls: JSON 배열 문자열 or 단일 문자열 → 배열
function parseImgUrls(raw: string | null): string[] {
  if (!raw) return [];
  const s = String(raw).trim();
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [s];
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const token = req.headers.get("x-session-token");
  const user = await validateSession(token);
  if (!user) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const season = await getCurrentSeason();

  // ── 인증샷 업로드 (통째 교체 — 원본과 동일) ──
  if (action === "images" && req.method === "POST") {
    if (await isProfileLocked()) {
      return jsonResponse({ error: "분배 진행 중에는 프로필을 수정할 수 없습니다." }, 403);
    }
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }
    const kind = body.kind === "power" ? "power" : body.kind === "aqui" ? "aqui" : null;
    if (!kind) return jsonResponse({ error: "kind는 power 또는 aqui여야 합니다." }, 400);
    const images = Array.isArray(body.images) ? (body.images as string[]) : [];
    if (!images.length) return jsonResponse({ error: "업로드할 이미지가 없습니다." }, 400);
    if (images.length > 10) return jsonResponse({ error: "이미지는 최대 10장까지 업로드할 수 있습니다." }, 400);

    let urls: string[];
    try {
      urls = await uploadImages(`${safeKey(user.user_id)}/${kind}`, images);
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }

    const column = kind === "power" ? "power_img_url" : "status_check_img_url";
    const { error } = await supabase
      .from("members")
      .update({ [column]: JSON.stringify(urls) })
      .eq("user_id", user.user_id);
    if (error) return jsonResponse({ error: "이미지 저장에 실패했습니다." }, 500);
    return jsonResponse({ ok: true, urls });
  }

  // ── 조회 ──
  if (req.method === "GET") {
    const { data: me } = await supabase
      .from("members")
      .select("user_id, current_id, guild_name, subjugation_rank, class, level, abyss_level, power, equipment_info, status_check, power_img_url, status_check_img_url, participation_score, contribution_score, jaeng_count, jaeng_rate, jaeng_morning, jaeng_evening, jaeng_dawn")
      .eq("user_id", user.user_id)
      .maybeSingle();
    if (!me) return jsonResponse({ error: "회원 정보를 찾을 수 없습니다." }, 404);

    const locked = await isProfileLocked();

    // 내 분배 이력 (최근 50)
    const { data: myHistory } = await supabase
      .from("distribution_history")
      .select("id, item_name, grade, quantity, distributed_at, diamond_amount, cash_amount")
      .eq("receiver_user_id", user.user_id)
      .order("distributed_at", { ascending: false })
      .limit(50);

    return jsonResponse({
      season,
      locked,
      user: { user_id: user.user_id, current_id: me.current_id, role: user.role },
      info: {
        current_id: me.current_id,
        guild_name: me.guild_name,
        subjugation_rank: me.subjugation_rank,
        class: me.class,
        level: me.level,
        abyss_level: me.abyss_level,
        power: me.power,
        participation_score: me.participation_score,
        contribution_score: me.contribution_score,
      },
      equipment_info: me.equipment_info,
      status_check: me.status_check,
      power_imgs: parseImgUrls(me.power_img_url),
      aqui_imgs: parseImgUrls(me.status_check_img_url),
      // 쟁 지표 (참여점수와 별도 — 조 선택 기능은 폐지됨)
      jaeng: {
        count: me.jaeng_count ?? 0,
        rate: me.jaeng_rate ?? null,
        morning: me.jaeng_morning ?? 0,
        evening: me.jaeng_evening ?? 0,
        dawn: me.jaeng_dawn ?? 0,
      },
      my_history: myHistory || [],
    });
  }

  // ── 프로필 저장 (기본정보 + 장비 + 아퀴 + 비밀번호(선택)) ──
  if (req.method === "PUT") {
    if (await isProfileLocked()) {
      return jsonResponse({ error: "분배 진행 중에는 프로필을 수정할 수 없습니다." }, 403);
    }
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }

    const patch: Record<string, unknown> = {};

    // 닉네임 (중복 체크 + 이전 닉 이력 기록 — 원본 update_member_profile 규칙)
    if (typeof body.current_id === "string") {
      const newNick = body.current_id.trim();
      if (!newNick) return jsonResponse({ error: "닉네임은 비울 수 없습니다." }, 400);
      if (newNick !== (user.current_id || "")) {
        const { data: dup } = await supabase
          .from("members")
          .select("user_id")
          .eq("current_id", newNick)
          .neq("user_id", user.user_id)
          .maybeSingle();
        if (dup) return jsonResponse({ error: "이미 사용 중인 닉네임입니다." }, 409);
        if (user.current_id) {
          // 이전 닉을 이력에 남김 (참여 매칭용 — UNIQUE 충돌은 무시)
          await supabase.from("member_nick_history").upsert(
            { user_id: user.user_id, nickname: user.current_id },
            { onConflict: "user_id,nickname", ignoreDuplicates: true },
          );
        }
        patch.current_id = newNick;
      }
    }

    for (const key of ["guild_name", "subjugation_rank", "class", "abyss_level"]) {
      if (typeof body[key] === "string") patch[key] = (body[key] as string).trim() || null;
    }
    if (body.level !== undefined) {
      const level = Number(body.level);
      if (!Number.isInteger(level) || level < 0) return jsonResponse({ error: "레벨은 0 이상의 정수여야 합니다." }, 400);
      patch.level = level;
    }
    if (body.power !== undefined) {
      const power = Number(body.power);
      if (!Number.isInteger(power) || power < 0) return jsonResponse({ error: "전투력은 0 이상의 정수여야 합니다." }, 400);
      patch.power = power;
    }
    if (typeof body.equipment_info === "string" && body.equipment_info) {
      const err = validateEquipmentInfo(body.equipment_info);
      if (err) return jsonResponse({ error: err }, 400);
      patch.equipment_info = body.equipment_info;
    }
    if (typeof body.status_check === "string" && body.status_check) {
      const err = validateStatusCheck(body.status_check);
      if (err) return jsonResponse({ error: err }, 400);
      patch.status_check = body.status_check;
    }
    if (typeof body.new_password === "string" && body.new_password) {
      if (body.new_password.length < 4) return jsonResponse({ error: "비밀번호는 4자 이상이어야 합니다." }, 400);
      patch.password = await bcrypt.hash(body.new_password, 10);
    }

    // 전투력 변경 시 기여점수 재계산 (원본 공식: 참여×0.7 + 전투력×0.3)
    if (patch.power !== undefined) {
      const { data: cur } = await supabase
        .from("members")
        .select("participation_score")
        .eq("user_id", user.user_id)
        .maybeSingle();
      patch.contribution_score = Math.round(((cur?.participation_score ?? 0) * 0.7) + (patch.power as number) * 0.3);
    }

    if (!Object.keys(patch).length) return jsonResponse({ error: "변경할 내용이 없습니다." }, 400);

    const { error } = await supabase.from("members").update(patch).eq("user_id", user.user_id);
    if (error) return jsonResponse({ error: "저장에 실패했습니다." }, 500);
    return jsonResponse({ ok: true });
  }

  // (긴급 참여조 선택 POST는 !쟁 개편으로 폐지 — action=images 외의 POST는 지원하지 않음)

  return jsonResponse({ error: "지원하지 않는 메서드입니다." }, 405);
});
