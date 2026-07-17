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

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("members")
      .select(
        "user_id, current_id, guild_name, class, level, power, role, subjugation_rank, abyss_level, contribution_score, participation_score, registered_at",
      )
      .order("current_id", { ascending: true });
    if (error) return jsonResponse({ error: "결사원 목록 조회에 실패했습니다." }, 500);
    return jsonResponse(data);
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
      .select("power, participation_score")
      .eq("user_id", targetId)
      .maybeSingle();
    if (findErr) return jsonResponse({ error: "회원 조회에 실패했습니다." }, 500);
    if (!current) return jsonResponse({ error: "해당 회원을 찾을 수 없습니다." }, 404);

    // 전투력이 바뀌면 기여점수를 서버에서 재계산 (database.py: participation_score*0.7 + power*0.3).
    const nextPower = patch.power !== undefined ? patch.power : current.power;
    const updatePayload: Record<string, unknown> = {
      ...patch,
      contribution_score: Math.round((current.participation_score ?? 0) * 0.7 + nextPower * 0.3),
    };

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
