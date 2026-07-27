// 대시보드 웹 에디터에 배포 가능하도록 의도적으로 단일 파일(자체 완결) 구성.
import { createClient } from "npm:@supabase/supabase-js@2";
import bcrypt from "npm:bcryptjs@2.4.3";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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

function isStaff(user: SessionUser | null): boolean {
  return !!user && (user.role === "관리자" || user.role === "운영진");
}

function isAdmin(user: SessionUser | null): boolean {
  return !!user && user.role === "관리자";
}

// 기존 Streamlit 앱의 app.py 회원 권한 값과 동일 — members.role 컬럼의 DB 기본값('Member', 영문)은
// 예전에 남은 값이라 실제로는 쓰이지 않음. 새 회원은 항상 아래 한글 값 중 하나로 명시적으로 저장한다.
const ROLES = ["결사원", "운영진", "관리자"];

// 장비/아퀴 필드 검증용 상수 (원본 app.py:703-774와 동일 목록 — 값 자체는 클라이언트가 만들지만
// 형식이 깨진 문자열이 저장되면 분배 자격 판정이 오작동하므로 서버에서 형식을 강제한다).
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

interface MemberPayload {
  current_id: string;
  guild_name: string | null;
  class: string | null;
  level: number;
  power: number;
  role: string;
  subjugation_rank: string | null;
  abyss_level: string | null;
}

function validateMemberPayload(
  body: Record<string, unknown>,
  { partial }: { partial: boolean },
): { valid: boolean; errors: string[]; value?: Partial<MemberPayload> } {
  const errors: string[] = [];
  const value: Partial<MemberPayload> = {};

  const hasField = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (!partial || hasField("current_id")) {
    const current_id = typeof body.current_id === "string" ? body.current_id.trim() : "";
    if (!current_id) errors.push("닉네임은 필수입니다.");
    value.current_id = current_id;
  }

  if (!partial || hasField("role")) {
    const role = typeof body.role === "string" ? body.role : "결사원";
    if (!ROLES.includes(role)) errors.push(`role은 ${ROLES.join(", ")} 중 하나여야 합니다.`);
    value.role = role;
  }

  if (!partial || hasField("level")) {
    const level = body.level === undefined || body.level === null || body.level === "" ? 0 : Number(body.level);
    if (!Number.isFinite(level) || !Number.isInteger(level) || level < 0) errors.push("레벨은 0 이상의 정수여야 합니다.");
    value.level = level;
  }

  if (!partial || hasField("power")) {
    const power = body.power === undefined || body.power === null || body.power === "" ? 0 : Number(body.power);
    if (!Number.isFinite(power) || !Number.isInteger(power) || power < 0) errors.push("전투력은 0 이상의 정수여야 합니다.");
    value.power = power;
  }

  if (!partial || hasField("guild_name")) {
    value.guild_name = typeof body.guild_name === "string" ? body.guild_name.trim() || null : null;
  }
  if (!partial || hasField("class")) {
    value.class = typeof body.class === "string" ? body.class.trim() || null : null;
  }
  if (!partial || hasField("subjugation_rank")) {
    value.subjugation_rank = typeof body.subjugation_rank === "string" ? body.subjugation_rank.trim() || null : null;
  }
  if (!partial || hasField("abyss_level")) {
    value.abyss_level = typeof body.abyss_level === "string" ? body.abyss_level.trim() || null : null;
  }

  if (errors.length) return { valid: false, errors };
  return { valid: true, errors: [], value };
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const token = req.headers.get("x-session-token");
  const user = await validateSession(token);
  if (!user) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

  // 결사원 관리 화면 전체가 원본 앱처럼 운영진 이상 전용 — 조회를 포함해 전 메서드 공통 게이트.
  if (!isStaff(user)) {
    return jsonResponse({ error: "운영진만 사용할 수 있는 기능입니다." }, 403);
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // ── 결사명 관리 (합병 준비 — guilds 테이블) ──
  // 이름 수정 = 운영진, 추가/삭제 = 관리자. 이름 변경 시 members/registration_requests의
  // 기존 이름을 함께 전파해 문자열 guild_name 정합을 유지한다.
  if (action === "guild_update" || action === "guild_add" || action === "guild_delete") {
    if (req.method !== "POST") return jsonResponse({ error: "지원하지 않는 메서드입니다." }, 405);
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }

    if (action === "guild_update") {
      const id = Number(body.id);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!id || !name) return jsonResponse({ error: "id와 name이 필요합니다." }, 400);
      const { data: g } = await supabase.from("guilds").select("id, name").eq("id", id).maybeSingle();
      if (!g) return jsonResponse({ error: "해당 결사를 찾을 수 없습니다." }, 404);
      if (g.name === name) return jsonResponse({ ok: true, renamed: 0 });
      const { data: dup } = await supabase.from("guilds").select("id").eq("name", name).maybeSingle();
      if (dup) return jsonResponse({ error: "이미 같은 이름의 결사가 있습니다." }, 409);
      const { error: upErr } = await supabase.from("guilds").update({ name }).eq("id", id);
      if (upErr) return jsonResponse({ error: "결사명 변경에 실패했습니다." }, 500);
      // 기존 이름을 쓰던 회원/가입 신청에 새 이름 전파
      const { data: renamed } = await supabase
        .from("members").update({ guild_name: name }).eq("guild_name", g.name).select("user_id");
      await supabase.from("registration_requests").update({ guild_name: name }).eq("guild_name", g.name);
      return jsonResponse({ ok: true, renamed: (renamed || []).length });
    }

    if (!isAdmin(user)) return jsonResponse({ error: "결사 추가/삭제는 관리자만 가능합니다." }, 403);

    if (action === "guild_add") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return jsonResponse({ error: "name이 필요합니다." }, 400);
      const { data: maxRow } = await supabase
        .from("guilds").select("sort_order").order("sort_order", { ascending: false }).limit(1);
      const nextOrder = ((maxRow && maxRow[0] && maxRow[0].sort_order) || 0) + 1;
      const { data, error } = await supabase
        .from("guilds").insert({ name, sort_order: nextOrder }).select().single();
      if (error) return jsonResponse({ error: "결사 추가에 실패했습니다 (이름 중복 여부 확인)." }, 500);
      return jsonResponse(data, 201);
    }

    // guild_delete: 소속 회원이 있으면 차단
    const id = Number(body.id);
    if (!id) return jsonResponse({ error: "id가 필요합니다." }, 400);
    const { data: g } = await supabase.from("guilds").select("id, name").eq("id", id).maybeSingle();
    if (!g) return jsonResponse({ error: "해당 결사를 찾을 수 없습니다." }, 404);
    const { count } = await supabase
      .from("members").select("user_id", { count: "exact", head: true }).eq("guild_name", g.name);
    if ((count || 0) > 0) {
      return jsonResponse({ error: `"${g.name}" 소속 회원이 ${count}명 있어 삭제할 수 없습니다. 회원 소속을 먼저 변경해주세요.` }, 409);
    }
    const { error: delErr } = await supabase.from("guilds").delete().eq("id", id);
    if (delErr) return jsonResponse({ error: "삭제에 실패했습니다." }, 500);
    return jsonResponse({ ok: true });
  }

  // ── 가입 신청 승인/거절 (원본 approve_registration/reject_registration, database.py:3300) ──
  if ((action === "approve" || action === "reject") && req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }
    const reqId = Number(body.request_id);
    if (!reqId) return jsonResponse({ error: "request_id가 필요합니다." }, 400);

    const { data: reg, error: regErr } = await supabase
      .from("registration_requests")
      .select("*")
      .eq("id", reqId)
      .maybeSingle();
    if (regErr || !reg) return jsonResponse({ error: "해당 가입 신청을 찾을 수 없습니다." }, 404);
    if (reg.status !== "대기") return jsonResponse({ error: `이미 처리된 신청입니다 (${reg.status}).` }, 409);

    if (action === "reject") {
      const { error } = await supabase
        .from("registration_requests")
        .update({ status: "거절" })
        .eq("id", reqId);
      if (error) return jsonResponse({ error: "거절 처리에 실패했습니다." }, 500);
      return jsonResponse({ ok: true });
    }

    // 승인: members UPSERT (기존 회원이면 신청 내용으로 갱신 — 원본 ON CONFLICT DO UPDATE와 동일)
    const memberRow = {
      user_id: reg.user_id,
      password: reg.password, // 신청 시점에 이미 bcrypt 해시됨
      current_id: reg.current_id,
      guild_name: reg.guild_name,
      subjugation_rank: reg.subjugation_rank,
      level: reg.level ?? 0,
      class: reg.class,
      abyss_level: reg.abyss_level,
      power: reg.power ?? 0,
      role: reg.role || "결사원",
      equipment_info: reg.equipment_info,
      status_check: reg.status_check,
      power_img_url: reg.power_img_url,
      status_check_img_url: reg.status_check_img_url,
      contribution_score: Math.round((reg.power ?? 0) * 0.3), // 신규 회원 참여점수 0 기준
    };
    const { error: upsertErr } = await supabase
      .from("members")
      .upsert(memberRow, { onConflict: "user_id" });
    if (upsertErr) return jsonResponse({ error: "회원 등록에 실패했습니다." }, 500);

    const { error: stErr } = await supabase
      .from("registration_requests")
      .update({ status: "승인", approved_at: new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) })
      .eq("id", reqId);
    if (stErr) return jsonResponse({ error: "신청 상태 갱신에 실패했습니다." }, 500);

    return jsonResponse({ ok: true, user_id: reg.user_id });
  }

  if (req.method === "GET") {
    const view = url.searchParams.get("view");

    // 결사 목록 (합병 준비 — 필터/결사명 관리 UI용)
    if (view === "guilds") {
      const { data, error } = await supabase
        .from("guilds")
        .select("id, name, sort_order, active")
        .order("sort_order", { ascending: true });
      if (error) return jsonResponse({ error: "결사 목록 조회에 실패했습니다." }, 500);
      return jsonResponse(data || []);
    }

    // 가입 신청 목록 (대기 중)
    if (view === "registrations") {
      const { data, error } = await supabase
        .from("registration_requests")
        .select("id, user_id, current_id, role, guild_name, subjugation_rank, level, class, abyss_level, power, equipment_info, status_check, power_img_url, status_check_img_url, requested_at, status")
        .eq("status", "대기")
        .order("requested_at", { ascending: true });
      if (error) return jsonResponse({ error: "가입 신청 조회에 실패했습니다." }, 500);
      return jsonResponse(data);
    }

    // 개별 결사원의 스샷 원본 조회 (목록에서 제외된 블랍을 필요할 때만 1명분 가져옴)
    if (view === "images") {
      const uid = url.searchParams.get("user_id");
      if (!uid) return jsonResponse({ error: "user_id가 필요합니다." }, 400);
      const { data, error } = await supabase
        .from("members")
        .select("user_id, current_id, power_img_url, status_check_img_url")
        .eq("user_id", uid)
        .maybeSingle();
      if (error) return jsonResponse({ error: "스크린샷 조회에 실패했습니다." }, 500);
      if (!data) return jsonResponse({ error: "해당 회원을 찾을 수 없습니다." }, 404);
      return jsonResponse(data);
    }

    // 스샷 유무 플래그 — 이미지 원문(레거시 base64 블랍)은 목록에서 절대 select하지 않는다.
    // 원본 get_all_members도 같은 이유로 has_power_img 불리언만 계산했다(database.py:1160).
    const imgFlagSet = async (col: string): Promise<Set<string>> => {
      const { data: rows, error: e } = await supabase
        .from("members")
        .select("user_id")
        .not(col, "is", null)
        .neq(col, "");
      if (e || !rows) return new Set();
      return new Set(rows.map((r: { user_id: string }) => r.user_id));
    };
    // 성능: 목록 + 스샷 플래그 2종은 서로 독립 — 순차 3회 왕복 → 병렬 1웨이브
    const [listRes, hasPower, hasAqui] = await Promise.all([
      supabase
        .from("members")
        .select(
          "user_id, current_id, guild_name, class, level, power, role, subjugation_rank, abyss_level, contribution_score, participation_score, registered_at, equipment_info, status_check",
        )
        .order("current_id", { ascending: true }),
      imgFlagSet("power_img_url"),
      imgFlagSet("status_check_img_url"),
    ]);
    const { data, error } = listRes;
    if (error) return jsonResponse({ error: "결사원 목록 조회에 실패했습니다." }, 500);
    return jsonResponse(
      (data ?? []).map((m) => ({
        ...m,
        has_power_img: hasPower.has(m.user_id),
        has_aqui_img: hasAqui.has(m.user_id),
      })),
    );
  }

  if (req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }

    const user_id = typeof body.user_id === "string" ? body.user_id.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!user_id) return jsonResponse({ error: "아이디(user_id)는 필수입니다." }, 400);
    if (!password || password.length < 4) return jsonResponse({ error: "비밀번호는 4자 이상이어야 합니다." }, 400);

    const check = validateMemberPayload(body, { partial: false });
    if (!check.valid) return jsonResponse({ error: check.errors.join(" ") }, 400);
    const m = check.value as MemberPayload;

    const { data: existing, error: findErr } = await supabase
      .from("members")
      .select("user_id")
      .eq("user_id", user_id)
      .maybeSingle();
    if (findErr) return jsonResponse({ error: "중복 확인에 실패했습니다." }, 500);
    if (existing) return jsonResponse({ error: "이미 존재하는 아이디입니다." }, 409);

    const passwordHash = await bcrypt.hash(password, 10);
    // 신규 회원은 참여점수가 0이므로 공식이 power*0.3으로 단순화됨(database.py의 재계산 공식 그대로).
    const contribution_score = Math.round(m.power * 0.3);

    // 장비/아퀴 (선택 — 원본 가입 폼에도 있던 필드)
    const insertExtra: Record<string, unknown> = {};
    if (typeof body.equipment_info === "string" && body.equipment_info) {
      const err = validateEquipmentInfo(body.equipment_info);
      if (err) return jsonResponse({ error: err }, 400);
      insertExtra.equipment_info = body.equipment_info;
    }
    if (typeof body.status_check === "string" && body.status_check) {
      const err = validateStatusCheck(body.status_check);
      if (err) return jsonResponse({ error: err }, 400);
      insertExtra.status_check = body.status_check;
    }

    const { data, error } = await supabase
      .from("members")
      .insert({
        user_id,
        password: passwordHash,
        current_id: m.current_id,
        guild_name: m.guild_name,
        class: m.class,
        level: m.level,
        power: m.power,
        role: m.role,
        subjugation_rank: m.subjugation_rank,
        abyss_level: m.abyss_level,
        contribution_score,
        ...insertExtra,
      })
      .select("user_id, current_id, guild_name, class, level, power, role, subjugation_rank, abyss_level, contribution_score")
      .single();
    if (error) return jsonResponse({ error: "등록에 실패했습니다." }, 500);
    return jsonResponse(data, 201);
  }

  if (req.method === "PUT") {
    const targetId = url.searchParams.get("user_id");
    if (!targetId) return jsonResponse({ error: "user_id가 필요합니다." }, 400);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }

    const check = validateMemberPayload(body, { partial: true });
    if (!check.valid) return jsonResponse({ error: check.errors.join(" ") }, 400);
    const patch = check.value as Partial<MemberPayload>;

    const { data: current, error: findErr } = await supabase
      .from("members")
      .select("power, participation_score, role")
      .eq("user_id", targetId)
      .maybeSingle();
    if (findErr) return jsonResponse({ error: "회원 조회에 실패했습니다." }, 500);
    if (!current) return jsonResponse({ error: "해당 회원을 찾을 수 없습니다." }, 404);

    // 권한(운영진/관리자 지정) 변경은 관리자 전용 — 합병 운영 방침
    if (patch.role !== undefined && patch.role !== current.role && !isAdmin(user)) {
      return jsonResponse({ error: "권한 변경은 관리자만 가능합니다." }, 403);
    }

    // 전투력이 바뀌면 기여점수를 서버에서 재계산 (database.py: participation_score*0.7 + power*0.3).
    const nextPower = patch.power !== undefined ? patch.power : current.power;
    const updatePayload: Record<string, unknown> = {
      ...patch,
      contribution_score: Math.round((current.participation_score ?? 0) * 0.7 + nextPower * 0.3),
    };

    // 장비/아퀴 정보 (선택 필드 — 형식 검증 후 반영)
    if (typeof body.equipment_info === "string" && body.equipment_info) {
      const err = validateEquipmentInfo(body.equipment_info);
      if (err) return jsonResponse({ error: err }, 400);
      updatePayload.equipment_info = body.equipment_info;
    }
    if (typeof body.status_check === "string" && body.status_check) {
      const err = validateStatusCheck(body.status_check);
      if (err) return jsonResponse({ error: err }, 400);
      updatePayload.status_check = body.status_check;
    }

    // 비밀번호 재설정은 관리자만 — 운영진은 나머지 정보 수정은 가능하지만 비번 재설정 권한은 없음.
    if (typeof body.new_password === "string" && body.new_password) {
      if (!isAdmin(user)) return jsonResponse({ error: "비밀번호 재설정은 관리자만 가능합니다." }, 403);
      if (body.new_password.length < 4) return jsonResponse({ error: "비밀번호는 4자 이상이어야 합니다." }, 400);
      updatePayload.password = await bcrypt.hash(body.new_password, 10);
    }

    const { data, error } = await supabase
      .from("members")
      .update(updatePayload)
      .eq("user_id", targetId)
      .select("user_id, current_id, guild_name, class, level, power, role, subjugation_rank, abyss_level, contribution_score")
      .maybeSingle();
    if (error) return jsonResponse({ error: "수정에 실패했습니다." }, 500);
    if (!data) return jsonResponse({ error: "해당 회원을 찾을 수 없습니다." }, 404);
    return jsonResponse(data);
  }

  if (req.method === "DELETE") {
    const targetId = url.searchParams.get("user_id");
    if (!targetId) return jsonResponse({ error: "user_id가 필요합니다." }, 400);
    const confirm = url.searchParams.get("confirm") === "true";

    // 탈퇴 처리는 원본 앱과 동일하게 관리자 전용 (운영진은 조회/정보수정까지만).
    if (!isAdmin(user)) return jsonResponse({ error: "탈퇴 처리는 관리자만 가능합니다." }, 403);

    const { data: target, error: findErr } = await supabase
      .from("members")
      .select("user_id, current_id, role")
      .eq("user_id", targetId)
      .maybeSingle();
    if (findErr) return jsonResponse({ error: "삭제 확인 중 오류가 발생했습니다." }, 500);
    if (!target) return jsonResponse({ error: "해당 회원을 찾을 수 없습니다." }, 404);

    if (!confirm) {
      return jsonResponse({ requires_confirmation: true, target });
    }

    // 자기 자신 탈퇴 방지 (관리자가 실수로 본인 계정을 지우는 사고 방지).
    if (targetId === user.user_id) {
      return jsonResponse({ error: "본인 계정은 탈퇴 처리할 수 없습니다." }, 400);
    }

    const { error: delErr } = await supabase.from("members").delete().eq("user_id", targetId);
    if (delErr) return jsonResponse({ error: "탈퇴 처리에 실패했습니다." }, 500);

    // 세션도 즉시 무효화해서 탈퇴 후 기존 로그인 세션으로 계속 쓰지 못하게 함.
    await supabase.from("user_sessions").delete().eq("user_id", targetId);

    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "지원하지 않는 메서드입니다." }, 405);
});
