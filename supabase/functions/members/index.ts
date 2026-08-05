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

// 신화 아퀴 보유 판정: status_check 우측 토큰에 ":m" 등급 또는 레거시 "M숫자" 토큰이 하나라도 있으면.
// (전력 분석 view=war / 공개 스냅샷 war_publish 공용)
function hasMythAqui(sc: string | null): boolean {
  if (!sc || !sc.includes("|")) return false;
  const right = sc.split("|").slice(1).join("|");
  for (const t of right.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (t.includes(":")) {
      if (t.split(":")[1] === "m") return true;
    } else if (/^M\d/.test(t)) {
      return true;
    }
  }
  return false;
}

function kstNowString(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
}

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

  // ── 전력 분석 (쟁 오더 작전판 — war_roles, 즉시 저장) ──
  const WAR_ROLES = ["tank", "bruiser", "mdealer", "pdealer", "healer", "support"];

  // 저장(공개): 현재 배치/짝지를 결사별 스냅샷으로 발행 — 전력 현황 탭이 이 시점 화면을 그대로 봄.
  // body.guild = 특정 결사만 갱신 (없으면 전체 결사 갱신). 결사별로 published_at 별도 관리.
  if (action === "war_publish" && req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      // 본문 없이 호출 = 전체 저장
    }
    const targetGuild = typeof body.guild === "string" && body.guild ? body.guild : null;

    const [rolesRes, memRes, curRes] = await Promise.all([
      supabase.from("war_roles").select("member_id, role, pair_no, main_level, line"),
      supabase.from("members").select("user_id, current_id, guild_name, class, status_check"),
      supabase.from("app_settings").select("value").eq("key", "war_published").maybeSingle(),
    ]);
    const memMap = new Map((memRes.data || []).map((m) => [m.user_id, m]));

    // 배치 인원을 결사별로 그룹핑
    const perGuild = new Map<string, Record<string, unknown>[]>();
    for (const r of rolesRes.data || []) {
      const m = memMap.get(r.member_id);
      if (!m) continue;
      const g = m.guild_name || "(미지정)";
      const entry = {
        nick: m.current_id || m.user_id,
        class: m.class,
        guild: m.guild_name,
        role: r.role,
        pair: r.pair_no,
        main: r.main_level || 0, // 별 0~3
        line: r.line || null, // 전력판 전위/중위/후위
        myth: hasMythAqui(m.status_check),
      };
      const arr = perGuild.get(g);
      if (arr) arr.push(entry);
      else perGuild.set(g, [entry]);
    }

    // 기존 발행본 위에 대상 결사만 교체 (전체 저장이면 통째 교체)
    let stored: { guilds: Record<string, unknown> } = { guilds: {} };
    try {
      if (curRes.data && curRes.data.value) {
        const parsed = JSON.parse(curRes.data.value);
        if (parsed && typeof parsed === "object" && parsed.guilds) stored = parsed;
      }
    } catch {
      // 폴백 — 새로 시작
    }
    const now = kstNowString();
    let count = 0;
    if (targetGuild) {
      const list = perGuild.get(targetGuild) || [];
      stored.guilds[targetGuild] = { published_at: now, members: list };
      count = list.length;
    } else {
      stored.guilds = {};
      for (const [g, list] of perGuild) {
        stored.guilds[g] = { published_at: now, members: list };
        count += list.length;
      }
    }
    const { error } = await supabase
      .from("app_settings")
      .upsert({ key: "war_published", value: JSON.stringify(stored) }, { onConflict: "key" });
    if (error) return jsonResponse({ error: "저장에 실패했습니다." }, 500);
    return jsonResponse({ ok: true, published_at: now, guild: targetGuild, count });
  }

  // 메인 지정 (별 0~3개 — 0 = 해제, 칩 남색 강조 + 우측 상단 별 표시)
  if (action === "war_main" && req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }
    const uid = typeof body.user_id === "string" ? body.user_id : "";
    if (!uid) return jsonResponse({ error: "user_id가 필요합니다." }, 400);
    const level = Number(body.level);
    if (!Number.isInteger(level) || level < 0 || level > 3) {
      return jsonResponse({ error: "메인 등급은 0~3이어야 합니다." }, 400);
    }
    const { error } = await supabase.from("war_roles").update({ main_level: level }).eq("member_id", uid);
    if (error) return jsonResponse({ error: "메인 지정 저장에 실패했습니다." }, 500);
    return jsonResponse({ ok: true });
  }

  // 전력판 섹터 지정 (전위/중위/후위 — null = 해제. 역할 배치자만 대상)
  if (action === "war_line" && req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }
    const uid = typeof body.user_id === "string" ? body.user_id : "";
    if (!uid) return jsonResponse({ error: "user_id가 필요합니다." }, 400);
    const line = body.line === null || body.line === undefined ? null : String(body.line);
    if (line !== null && !["front", "mid", "rear"].includes(line)) {
      return jsonResponse({ error: "섹터는 front/mid/rear 중 하나여야 합니다." }, 400);
    }
    const { error } = await supabase.from("war_roles").update({ line }).eq("member_id", uid);
    if (error) return jsonResponse({ error: "전력판 저장에 실패했습니다." }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === "war_role" || action === "war_pair" || action === "war_unpair") {
    if (req.method !== "POST") return jsonResponse({ error: "지원하지 않는 메서드입니다." }, 405);
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }

    // 역할 배치/변경/해제 (role 비우면 배치 해제 — 짝지 동반 해제)
    if (action === "war_role") {
      const uid = typeof body.user_id === "string" ? body.user_id : "";
      if (!uid) return jsonResponse({ error: "user_id가 필요합니다." }, 400);
      const role = typeof body.role === "string" && body.role ? body.role : null;
      if (role === null) {
        const { data: row } = await supabase.from("war_roles").select("pair_no").eq("member_id", uid).maybeSingle();
        if (row && row.pair_no != null) {
          await supabase.from("war_roles").update({ pair_no: null }).eq("pair_no", row.pair_no);
        }
        const { error } = await supabase.from("war_roles").delete().eq("member_id", uid);
        if (error) return jsonResponse({ error: "배치 해제에 실패했습니다." }, 500);
        return jsonResponse({ ok: true });
      }
      if (!WAR_ROLES.includes(role)) return jsonResponse({ error: "알 수 없는 역할입니다." }, 400);
      // upsert가 role만 갱신 — 기존 pair_no는 유지 (역할 변경해도 짝 유지)
      const { error } = await supabase.from("war_roles").upsert({ member_id: uid, role }, { onConflict: "member_id" });
      if (error) return jsonResponse({ error: "역할 저장에 실패했습니다." }, 500);
      return jsonResponse({ ok: true });
    }

    // 짝지 지정 (자유 2인 — 양쪽의 기존 짝 자동 해제 후 새 번호 부여)
    if (action === "war_pair") {
      const a = typeof body.a === "string" ? body.a : "";
      const b = typeof body.b === "string" ? body.b : "";
      if (!a || !b || a === b) return jsonResponse({ error: "서로 다른 두 결사원이 필요합니다." }, 400);
      const { data: rows } = await supabase.from("war_roles").select("member_id, pair_no").in("member_id", [a, b]);
      if (!rows || rows.length !== 2) return jsonResponse({ error: "배치된 결사원끼리만 짝지를 지정할 수 있습니다." }, 400);
      for (const oldNo of [...new Set(rows.map((r) => r.pair_no).filter((n) => n != null))]) {
        await supabase.from("war_roles").update({ pair_no: null }).eq("pair_no", oldNo);
      }
      const { data: maxRow } = await supabase
        .from("war_roles").select("pair_no").not("pair_no", "is", null)
        .order("pair_no", { ascending: false }).limit(1);
      const nextNo = ((maxRow && maxRow[0] && maxRow[0].pair_no) || 0) + 1;
      const { error } = await supabase.from("war_roles").update({ pair_no: nextNo }).in("member_id", [a, b]);
      if (error) return jsonResponse({ error: "짝지 저장에 실패했습니다." }, 500);
      return jsonResponse({ ok: true, pair_no: nextNo });
    }

    // 짝지 해제 (해당 번호 양쪽 모두)
    const uid = typeof body.user_id === "string" ? body.user_id : "";
    if (!uid) return jsonResponse({ error: "user_id가 필요합니다." }, 400);
    const { data: row } = await supabase.from("war_roles").select("pair_no").eq("member_id", uid).maybeSingle();
    if (row && row.pair_no != null) {
      const { error } = await supabase.from("war_roles").update({ pair_no: null }).eq("pair_no", row.pair_no);
      if (error) return jsonResponse({ error: "짝지 해제에 실패했습니다." }, 500);
    }
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

    // ── 출석 소급 매칭(백필): 가입 전에 저장된 로그의 미매칭 참석 기록 중
    //    닉네임이 일치하는 행을 새 회원에 연결하고 점수·쟁 지표를 재계산한다.
    //    현재 시즌 로그만 대상 (지난 시즌은 마감 스냅샷 보존 원칙 — 건드리지 않음).
    let backfilled = 0;
    try {
      const { data: cs } = await supabase.from("app_settings").select("value").eq("key", "current_season").maybeSingle();
      const season = cs && cs.value != null && !Number.isNaN(parseInt(cs.value, 10)) ? parseInt(cs.value, 10) : 1;
      const { data: seasonLogs } = await supabase.from("participation_logs").select("id").eq("season", season);
      const logIds = (seasonLogs || []).map((l) => l.id);
      if (logIds.length && reg.current_id) {
        const { data: rows } = await supabase
          .from("participation_log_members")
          .update({ user_id: reg.user_id, matched: true })
          .is("user_id", null)
          .eq("member_name", reg.current_id)
          .in("log_id", logIds)
          .select("id");
        backfilled = (rows || []).length;
        if (backfilled > 0) {
          await supabase.rpc("recalc_participation_scores", { p_season: season });
        }
      }
    } catch {
      // 백필 실패는 승인 자체를 막지 않음 (미매칭 상태로 남을 뿐 — 관리자 보정 가능)
    }

    return jsonResponse({ ok: true, user_id: reg.user_id, backfilled });
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

    // 전력 분석 보드 데이터 (표시 값은 전부 기존 소스에서 파생 — war_roles는 배치/짝만)
    if (view === "war") {
      const { data: cs } = await supabase.from("app_settings").select("value").eq("key", "current_season").maybeSingle();
      const season = cs && cs.value != null && !Number.isNaN(parseInt(cs.value, 10)) ? parseInt(cs.value, 10) : 1;
      const [memRes, spRes, rolesRes, pubRes] = await Promise.all([
        supabase
          .from("members")
          .select("user_id, current_id, guild_name, class, power, status_check, jaeng_rate")
          .neq("role", "관리자")
          .order("current_id", { ascending: true }),
        supabase.from("season_participation").select("user_id, participation_rate").eq("season", season),
        supabase.from("war_roles").select("member_id, role, pair_no, main_level, line"),
        supabase.from("app_settings").select("value").eq("key", "war_published").maybeSingle(),
      ]);
      if (memRes.error) return jsonResponse({ error: "회원 조회에 실패했습니다." }, 500);
      const rateMap = new Map((spRes.data || []).map((r) => [r.user_id, r.participation_rate]));
      const roleMap = new Map((rolesRes.data || []).map((r) => [r.member_id, r]));
      // 결사별 저장(공개) 시각 요약 {결사명: 시각}
      const published: Record<string, string> = {};
      try {
        if (pubRes.data && pubRes.data.value) {
          const parsed = JSON.parse(pubRes.data.value);
          for (const [g, v] of Object.entries(parsed.guilds || {})) {
            published[g] = (v as { published_at?: string }).published_at || "";
          }
        }
      } catch {
        // 무시
      }
      return jsonResponse({
        season,
        published,
        members: (memRes.data || []).map((m) => {
          const wr = roleMap.get(m.user_id);
          return {
            user_id: m.user_id,
            nick: m.current_id || m.user_id,
            guild: m.guild_name,
            class: m.class,
            power: m.power,
            sch_rate: rateMap.get(m.user_id) ?? null, // 일정참여율 (현재 시즌)
            war_rate: m.jaeng_rate ?? null,           // 쟁참여율
            myth: hasMythAqui(m.status_check),
            role: wr ? wr.role : null,
            pair_no: wr ? wr.pair_no : null,
            main: wr ? wr.main_level || 0 : 0, // 별 0~3
            line: wr ? wr.line || null : null, // 전력판 전위/중위/후위
          };
        }),
      });
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
