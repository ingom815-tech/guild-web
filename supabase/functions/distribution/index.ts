// 대시보드 웹 에디터에 배포 가능하도록 의도적으로 단일 파일(자체 완결) 구성.
// 분배 신청 단계: 기간 관리(운영진) + 신청 화면 데이터 + 신청/취소.
import { createClient } from "npm:@supabase/supabase-js@2";

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

function kstNowString(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

// ── 원본 app.py 상수/로직 이식 ─────────────────────────────────────────────

const EQUIPMENT_GRADES = ["희귀", "영웅", "전설", "신화", "절대자"];

// 절대자 풀셋 판정 슬롯 (app.py:710-713 그대로)
const ABSO_FULL_SLOTS = [
  "주무기", "특화무기", "투구", "상의", "망토", "허리띠", "바지", "신발", "장갑",
  "반지 1", "반지 2", "귀걸이 1", "귀걸이 2", "팔찌", "목걸이",
];

// 자격 조건 기본값 (app.py DEFAULT_REGULATIONS 중 이 단계에서 쓰는 키만)
const DEFAULT_REGULATIONS: Record<string, unknown> = {
  participation_rate_season: "current",
  legend_simyeon_min_power: 20000,
  legend_simyeon_min_participation_pct: 35,
  legend_aqui_min_power: 32000,
  legend_aqui_min_participation_pct: 65,
  starlight_min_power: 35000,
  starlight_min_participation_pct: 70,
  brooch_min_participation_pct: 35,
};

function normalizeGrade(g: string): string {
  if (!g) return g;
  const s = g.trim();
  for (const grade of EQUIPMENT_GRADES) {
    if (s.startsWith(grade)) return grade;
  }
  return s;
}

// equipment_info: JSON 문자열 또는 "슬롯:등급|슬롯:등급" 레거시 포맷 (app.py:1080-1094)
function parseEquipmentInfo(raw: string | null): Record<string, string> {
  if (!raw) return {};
  let result: Record<string, string> = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed;
  } catch {
    for (const part of raw.split("|")) {
      const p = part.trim();
      const idx = p.indexOf(":");
      if (idx > 0) result[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
    }
  }
  for (const slot of Object.keys(result)) result[slot] = normalizeGrade(String(result[slot]));
  return result;
}

async function getRegulations(): Promise<Record<string, unknown>> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "guild_regulations").maybeSingle();
  if (data && data.value) {
    try {
      const parsed = JSON.parse(data.value);
      if (parsed && typeof parsed === "object") return { ...DEFAULT_REGULATIONS, ...parsed };
    } catch {
      // 폴백
    }
  }
  return { ...DEFAULT_REGULATIONS };
}

// 참여율 값 결정 (app.py:9589-9609): regs.participation_rate_season="current"|시즌번호
async function getParticipationRate(userId: string, regs: Record<string, unknown>): Promise<number> {
  let season: number | null = null;
  const setting = regs.participation_rate_season;
  if (setting === "current" || setting == null) {
    const { data } = await supabase.from("app_settings").select("value").eq("key", "current_season").maybeSingle();
    season = data && data.value != null && !Number.isNaN(parseInt(data.value, 10)) ? parseInt(data.value, 10) : 1;
  } else {
    const n = parseInt(String(setting), 10);
    if (Number.isNaN(n)) return 0;
    season = n;
  }
  const { data: sp } = await supabase
    .from("season_participation")
    .select("participation_rate")
    .eq("user_id", userId)
    .eq("season", season)
    .maybeSingle();
  if (sp && sp.participation_rate != null) return Math.round(sp.participation_rate * 10) / 10;
  return 0;
}

interface MemberRow {
  power: number | null;
  equipment_info: string | null;
  power_img_url: string | null;
  status_check_img_url: string | null;
  contribution_score: number | null;
}

interface Eligibility {
  eligible: boolean;
  failed: { label: string; current: unknown; required: unknown }[];
  rule: string;
}

// 원본 _check_item_eligibility (app.py:5987-6044) 그대로 이식.
function checkEligibility(
  itemName: string,
  category: string | null,
  grade: string | null,
  member: MemberRow,
  regs: Record<string, unknown>,
  participation: number,
  unsoldCount: number,
): Eligibility {
  const myPower = member.power || 0;
  const nameNorm = itemName.replace(/ /g, "").toLowerCase();
  const cat = (category || "").replace(/ /g, "").toLowerCase();
  // 카테고리 표준화 호환: "아퀴"(구) / "아퀴룬"(신) 모두 아퀴로 취급 — 규칙 자체는 원본 그대로.
  const isAquiCat = cat === "아퀴" || cat === "아퀴룬";

  if (isAquiCat && grade === "전설" && (unsoldCount || 0) >= 2) {
    return { eligible: true, failed: [], rule: "전설 아퀴 (2회 유찰 — 무조건 신청 가능)" };
  }

  let conditions: [string, number, number][] = [];
  let rule = "";

  if (nameNorm.includes("찬란한") && nameNorm.includes("심연석")) {
    const equip = parseEquipmentInfo(member.equipment_info);
    const allAbso = ABSO_FULL_SLOTS.every((s) => equip[s] === "절대자");
    if (!allAbso) {
      return { eligible: false, failed: [{ label: "장비", current: "절대자 풀셋 미달성", required: "전 슬롯 절대자 장착 필요" }], rule: "찬란한 심연석" };
    }
    return { eligible: true, failed: [], rule: "찬란한 심연석" };
  } else if (nameNorm.includes("별빛심연석")) {
    const equip = parseEquipmentInfo(member.equipment_info);
    const allAbso = ABSO_FULL_SLOTS.every((s) => equip[s] === "절대자");
    if (allAbso) {
      return { eligible: false, failed: [{ label: "장비", current: "전 슬롯 절대자 달성", required: "신청 불가" }], rule: "별빛 심연석" };
    }
    conditions = [
      ["전투력", myPower, Number(regs.starlight_min_power ?? 35000)],
      ["참여도", participation, Number(regs.starlight_min_participation_pct ?? 70)],
    ];
    rule = "별빛 심연석";
  } else if (nameNorm.includes("심연석") && !nameNorm.includes("조각") && grade === "전설") {
    conditions = [
      ["전투력", myPower, Number(regs.legend_simyeon_min_power ?? 20000)],
      ["참여도", participation, Number(regs.legend_simyeon_min_participation_pct ?? 35)],
    ];
    rule = "전설 심연석";
  } else if (isAquiCat && grade === "전설") {
    conditions = [
      ["전투력", myPower, Number(regs.legend_aqui_min_power ?? 32000)],
      ["참여도", participation, Number(regs.legend_aqui_min_participation_pct ?? 65)],
    ];
    rule = "전설 아퀴";
  } else if (nameNorm.includes("브로치") && itemName.includes("3단")) {
    conditions = [["참여도", participation, Number(regs.brooch_min_participation_pct ?? 35)]];
    rule = "3단 브로치";
  }

  if (!conditions.length) return { eligible: true, failed: [], rule: "" };

  const failed = conditions
    .filter(([, current, required]) => current < required)
    .map(([label, current, required]) => ({ label, current, required }));
  return { eligible: failed.length === 0, failed, rule };
}

// 공식 구분 5분류 (카테고리 표준화 — 프론트 GameData.category5와 동일 규칙).
// DB 구분 값이 이미 5분류면 그대로, 구 값이면 이름 기반으로 환산한다.
const DIST_CATEGORIES = ["아퀴룬", "브로치", "별빛심연석", "찬란한심연석", "전파편 및 기타"];
function classifyTab(itemName: string, category: string | null, _grade: string | null): string {
  if (category && DIST_CATEGORIES.includes(category)) return category;
  const noSpace = itemName.replace(/ /g, "");
  if (noSpace.includes("브로치")) return "브로치";
  if (noSpace.includes("별빛심연석")) return "별빛심연석";
  if (noSpace.includes("찬란한")) return "찬란한심연석";
  if ((category || "") === "아퀴") return "아퀴룬";
  return "전파편 및 기타";
}

// ── 분배 확정 시 수령자 장비/아퀴 자동 갱신 (원본 _update_member_equipment_on_distribution, database.py:2789) ──

const CATEGORY_TO_SLOTS: Record<string, string[]> = {
  "주무기": ["주무기"],
  "특화무기": ["특화무기"],
  "방어구": ["투구", "상의", "망토", "허리띠", "바지", "신발", "장갑"],
  "장신구": ["반지 1", "반지 2", "귀걸이 1", "귀걸이 2", "팔찌", "목걸이"],
  "부적": ["2층 부적", "3층 부적"],
  "브로치": ["브로치"],
};

// 아퀴 룬 이름 → 슬롯 코드 (원본 _AQUI_NAME_TO_ID — 원본은 6직업 기준이었으나
// guild-web gamedata.js와 동일하게 야만투사 룬 이름도 포함해 매칭 누락을 없앤다)
const AQUI_NAME_TO_ID: Record<string, string> = {};
{
  const add = (id: string, names: string[]) => {
    for (const n of names) AQUI_NAME_TO_ID[n] = id;
  };
  add("A1", ["파쇄 화살", "카데나의 징벌", "표적 관통", "대지 가르기", "주문 각인 창", "공허 가르기"]);
  add("A2", ["보호의 향연", "감시자의 권능", "피의 복수", "금빛 바람", "약점 공략", "고통 망각"]);
  add("A3", ["향연의 덫", "신의 방패", "배후의 일격", "샤카 투척", "눈보라", "사신의 원무"]);
  add("A4", ["고속 연사", "신성한 강타", "환영 쇄도", "샤카의 춤", "유성 낙하", "심연 손아귀"]);
  add("A5", ["추적 사냥", "사슬 속박", "검풍 발산", "신속한 일격", "폭풍의 춤", "주문강타", "재빠른 습격"]);
  add("A6", ["회피 공격", "시련의 외침", "암기 투척", "점멸 습격", "얼음 방패", "휘몰아치는 힘"]);
  add("A_pot", ["단궁 물약 강화", "수호 HP 물약 강화", "장검 HP 물약 강화", "검무 물약 강화", "원소 물약 강화", "해방 물약 강화"]);
  add("B1", ["능숙한 견제", "숭고한 회복", "방어 자세", "모래 방벽", "무형 방패", "원한의 시선"]);
  add("B2", ["저격 자세", "진군의 신호", "얽힘 방출", "감시자의 판결", "보호의 축복", "흑염 방출"]);
  add("B3", ["회심의 일격", "최초의 일격", "희생의 방패", "모래시계 폭풍", "고양의 영역", "포식자의 이빨"]);
  add("B4", ["관통하는 화살", "카데나의 낙인", "방패 투척", "황금률의 파도", "집중 치유", "몰살의 파도"]);
  add("B5", ["명사수", "공격의 오라", "용맹한 돌진", "시간 왜곡", "구원의 빛", "심연 덩굴"]);
  add("B6", ["쐐기 화살", "회복의 오라", "압도적 방어", "쇄도하는 빛", "정화의 빛무리", "공포의 눈"]);
  add("B_pot", ["장궁 HP 물약 강화", "헌신 소지 무게 증가", "환영방패 HP 물약 강화", "환원 HP 물약 강화", "충전 소지 무게 증가", "복수 HP 물약 강화"]);
  add("C1", ["향연 방사", "집행 선언", "칼바람 궤적", "환영 돌진", "연쇄 차크람", "소소리 바람", "그림자 발톱"]);
  add("C2", ["가로막는 향연", "심판의 시간", "야성 본능", "환영 갑옷", "굳건한 태양", "지식의 완성", "영체 흡수"]);
  add("C3", ["얽힘석궁 설치", "맹렬한 돌격", "신수의 발톱", "최후의 일격", "단단한 피부", "돌풍 회오리", "암흑개화"]);
  add("C4", ["얽힘 과부하", "신의 형벌", "창의 심판", "환영검 투척", "개미지옥", "바람 장벽", "굶주린 무리"]);
  add("C5", ["향연 유탄", "징벌의 도약", "야성의 돌진", "십자 베기", "휘몰이 돌풍", "태풍의 눈", "심연의 부름"]);
  add("C6", ["연발 사격", "참회의 도끼", "미치광이 도약", "전투의 열광", "질풍의 포효", "환기", "심연의 등불"]);
  add("C_pot", ["대석궁 물약 강화", "심판 물약 강화", "야성 물약 강화", "환영검 물약 강화", "질풍 물약 강화", "기류 물약 강화", "지배 물약 강화"]);
  // 특화 1~6은 계열 접두어 패턴으로 일괄 생성
  const SPEC_PREFIX: Record<string, string[]> = {
    A: ["단궁", "수호", "장검", "검무", "원소", "해방"],
    B: ["장궁", "헌신", "환영방패", "환원", "충전", "복수"],
    C: ["대석궁", "심판", "야성", "환영검", "질풍", "기류", "지배"],
  };
  for (const [g, prefixes] of Object.entries(SPEC_PREFIX)) {
    for (const p of prefixes) {
      for (let n = 1; n <= 6; n++) AQUI_NAME_TO_ID[`${p} 특화 ${n}`] = `${g}_s${n}`;
    }
  }
}

interface DistributedItem {
  item_name: string;
  category: string | null;
  grade: string | null;
}

async function updateMemberAquiOnDistribution(userId: string, item: DistributedItem): Promise<void> {
  const grade = item.grade || "";
  if (grade !== "전설" && grade !== "신화") return;
  const matched = AQUI_NAME_TO_ID[item.item_name] || "";
  if (!matched) return;
  const { data: member } = await supabase.from("members").select("status_check").eq("user_id", userId).maybeSingle();
  if (!member) return;

  const gradeCode = grade === "신화" ? "m" : "l";
  const sc: string = member.status_check || "";
  const existing: Record<string, string> = {};
  let total = 0;
  if (sc && sc.includes("|")) {
    const sep = sc.indexOf("|");
    const header = sc.slice(0, sep);
    const idPart = sc.slice(sep + 1);
    for (const tok of header.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (tok.startsWith("T:")) {
        const n = parseInt(tok.slice(2), 10);
        if (!Number.isNaN(n)) total = n;
      }
    }
    for (const entry of idPart.split(",").map((x) => x.trim()).filter(Boolean)) {
      const i = entry.indexOf(":");
      if (i > 0) existing[entry.slice(0, i)] = entry.slice(i + 1) || "l";
      else existing[entry] = "l";
    }
  }

  if (matched in existing) {
    const old = existing[matched];
    // 이미 신화거나 같은 등급이면 갱신 없음 (원본 동일 — 다운그레이드 방지)
    if (old === "m" || (old === "l" && gradeCode === "l")) return;
    existing[matched] = gradeCode;
  } else {
    existing[matched] = gradeCode;
    total += 1;
  }

  const entries = Object.keys(existing).sort().map((k) => `${k}:${existing[k]}`).join(",");
  await supabase
    .from("members")
    .update({ status_check: `T:${total}|${entries}`, profile_updated_at: kstNowString() })
    .eq("user_id", userId);
}

async function updateMemberOnDistribution(userId: string | null, item: DistributedItem): Promise<void> {
  if (!userId) return;
  const category = item.category || "";
  if (category === "아퀴" || category === "아퀴룬") {
    await updateMemberAquiOnDistribution(userId, item);
    return;
  }
  const grade = item.grade || "";
  if (!grade || !(category in CATEGORY_TO_SLOTS)) return;

  const { data: member } = await supabase.from("members").select("equipment_info").eq("user_id", userId).maybeSingle();
  if (!member) return;
  let equip: Record<string, string> = {};
  try {
    const parsed = JSON.parse(member.equipment_info || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) equip = parsed;
  } catch {
    // 원본도 JSON 파싱 실패 시 빈 객체에서 시작
  }

  const slots = CATEGORY_TO_SLOTS[category];
  const nameNorm = item.item_name.toLowerCase().replace(/ /g, "");
  let target: string | null = null;
  for (const slot of slots) {
    if (nameNorm.includes(slot.replace(/ /g, ""))) {
      target = slot;
      break;
    }
  }
  if (!target && slots.length === 1) target = slots[0];
  if (!target) return;

  equip[target] = grade;
  await supabase
    .from("members")
    .update({ equipment_info: JSON.stringify(equip), profile_updated_at: kstNowString() })
    .eq("user_id", userId);
}

// DB의 timestamp without time zone은 KST 벽시계값 — 문자열을 UTC로 강제 해석한 epoch와
// "현재 KST 벽시계값을 UTC로 해석한 epoch"(Date.now()+9h)를 비교하면 올바른 대소 비교가 된다.
function kstNowEpoch(): number {
  return Date.now() + 9 * 3600 * 1000;
}
function naiveKstToEpoch(ts: string): number {
  return new Date(ts.replace(" ", "T") + (ts.endsWith("Z") ? "" : "Z")).getTime();
}

async function getActivePeriod(): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from("distribution_period")
    .select("*")
    .eq("status", "진행중")
    .order("id", { ascending: false })
    .limit(1);
  return data && data.length ? data[0] : null;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const token = req.headers.get("x-session-token");
  const user = await validateSession(token);
  if (!user) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // ── 기간 관리 (운영진 이상) ──
  if (action === "period" || action === "close") {
    if (!isStaff(user)) return jsonResponse({ error: "운영진만 사용할 수 있는 기능입니다." }, 403);

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      // GET류 아님 — 기간 액션은 전부 body 필요
    }

    if (action === "period" && req.method === "POST") {
      const start = typeof body.start_time === "string" ? body.start_time : "";
      const end = typeof body.end_time === "string" ? body.end_time : "";
      if (!start || !end) return jsonResponse({ error: "시작/마감 시각이 필요합니다." }, 400);
      if (naiveKstToEpoch(end) <= naiveKstToEpoch(start)) {
        return jsonResponse({ error: "마감 시각은 시작 시각보다 뒤여야 합니다." }, 400);
      }
      // 원본 set_distribution_period: 기존 '진행중' 전부 '종료' 후 새 행 (단일 활성 기간)
      await supabase.from("distribution_period").update({ status: "종료" }).eq("status", "진행중");
      const { data, error } = await supabase
        .from("distribution_period")
        .insert({ start_time: start, end_time: end, status: "진행중" })
        .select()
        .single();
      if (error) return jsonResponse({ error: "기간 설정에 실패했습니다." }, 500);
      return jsonResponse(data, 201);
    }

    if (action === "period" && req.method === "PUT") {
      const periodId = Number(body.period_id);
      const newEnd = typeof body.new_end === "string" ? body.new_end : "";
      if (!periodId || !newEnd) return jsonResponse({ error: "period_id와 new_end가 필요합니다." }, 400);
      const { data, error } = await supabase
        .from("distribution_period")
        .update({ end_time: newEnd })
        .eq("id", periodId)
        .eq("status", "진행중")
        .select()
        .maybeSingle();
      if (error) return jsonResponse({ error: "연장에 실패했습니다." }, 500);
      if (!data) return jsonResponse({ error: "진행중인 기간을 찾을 수 없습니다." }, 404);
      return jsonResponse(data);
    }

    if (action === "close" && req.method === "POST") {
      const periodId = Number(body.period_id);
      if (!periodId) return jsonResponse({ error: "period_id가 필요합니다." }, 400);
      const { data, error } = await supabase.rpc("close_distribution_period", { p_period_id: periodId });
      if (error) return jsonResponse({ error: "기간 종료에 실패했습니다." }, 500);
      return jsonResponse({ ok: true, confirmed_count: data ?? 0 });
    }

    return jsonResponse({ error: "지원하지 않는 요청입니다." }, 405);
  }

  // ── 분배 후반부 액션 (운영진/관리자) ──────────────────────────────────────
  const MANAGE_ACTIONS = new Set([
    "confirm", "bulk_cancel", "dispatch", "undispatch", "revert",
    "decline_conflict", "finalize", "cancel_history", "delete_history",
  ]);
  if (action && MANAGE_ACTIONS.has(action) && req.method === "POST") {
    if (!isStaff(user)) return jsonResponse({ error: "운영진만 사용할 수 있는 기능입니다." }, 403);
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }

    // 수동 확정 (원본 confirm_item_distribution — 재고 초과 방지 + 소진 시 잔여 대기 반려)
    if (action === "confirm") {
      const itemId = Number(body.item_id);
      const winnerId = typeof body.user_id === "string" ? body.user_id : "";
      if (!itemId || !winnerId) return jsonResponse({ error: "item_id와 user_id가 필요합니다." }, 400);
      const { data, error } = await supabase.rpc("confirm_item_distribution", {
        p_item_id: itemId,
        p_winner_user_id: winnerId,
      });
      if (error) return jsonResponse({ error: "확정 처리에 실패했습니다." }, 500);
      if (data === "no_item") return jsonResponse({ error: "해당 재고를 찾을 수 없습니다." }, 404);
      if (data === "no_request") return jsonResponse({ error: "해당 유저의 대기 신청이 없습니다." }, 404);
      if (data === "exceeded") return jsonResponse({ error: "재고 수량을 초과해 확정할 수 없습니다." }, 409);
      return jsonResponse({ ok: true });
    }

    // 자격 미달 신청 일괄 취소 (원본 bulk_cancel_requests — 대기 상태만)
    if (action === "bulk_cancel") {
      const ids = Array.isArray(body.request_ids) ? body.request_ids.map(Number).filter(Boolean) : [];
      if (!ids.length) return jsonResponse({ error: "request_ids가 필요합니다." }, 400);
      const { data, error } = await supabase
        .from("item_requests")
        .update({ status: "취소" })
        .in("id", ids)
        .eq("status", "대기")
        .select("id");
      if (error) return jsonResponse({ error: "일괄 취소에 실패했습니다." }, 500);
      return jsonResponse({ ok: true, cancelled: (data || []).length });
    }

    // 나감 처리 (원본 mark_dispatched — 처리 후 재고 소진 아이템의 미처리 확정건은 '대기'로 복귀)
    // ※ 현재 UI는 확정 대기에서 바로 최종확인(finalize)하므로 이 액션은 사용하지 않음 — 호환용으로 유지.
    if (action === "dispatch") {
      const ids = Array.isArray(body.request_ids) ? body.request_ids.map(Number).filter(Boolean) : [];
      if (!ids.length) return jsonResponse({ error: "request_ids가 필요합니다." }, 400);
      const { data: updated, error } = await supabase
        .from("item_requests")
        .update({ is_dispatched: true, dispatched_at: new Date().toISOString() })
        .in("id", ids)
        .eq("status", "확정")
        .select("id, item_id");
      if (error) return jsonResponse({ error: "나감 처리에 실패했습니다." }, 500);

      // 원본 2470-2490: 아이템별 dispatch 수량이 재고 이상이면, 아직 안 나간 확정건을 '대기'로 되돌림
      const itemIds = [...new Set((updated || []).map((r) => r.item_id))];
      for (const itemId of itemIds) {
        const { data: inv } = await supabase.from("inventory").select("quantity").eq("id", itemId).eq("status", "재고").maybeSingle();
        if (!inv) continue;
        const { data: confirmedRows } = await supabase
          .from("item_requests")
          .select("id, requested_quantity, is_dispatched")
          .eq("item_id", itemId)
          .eq("status", "확정");
        const dispatchedQty = (confirmedRows || [])
          .filter((r) => r.is_dispatched)
          .reduce((s, r) => s + (r.requested_quantity || 1), 0);
        if (dispatchedQty >= (inv.quantity || 0)) {
          const revertIds = (confirmedRows || []).filter((r) => !r.is_dispatched).map((r) => r.id);
          if (revertIds.length) {
            await supabase.from("item_requests").update({ status: "대기" }).in("id", revertIds);
          }
        }
      }
      return jsonResponse({ ok: true, dispatched: (updated || []).length });
    }

    // 나감 취소
    if (action === "undispatch") {
      const ids = Array.isArray(body.request_ids) ? body.request_ids.map(Number).filter(Boolean) : [];
      if (!ids.length) return jsonResponse({ error: "request_ids가 필요합니다." }, 400);
      const { error } = await supabase
        .from("item_requests")
        .update({ is_dispatched: false, dispatched_at: null })
        .in("id", ids)
        .eq("status", "확정");
      if (error) return jsonResponse({ error: "나감 취소에 실패했습니다." }, 500);
      return jsonResponse({ ok: true });
    }

    // 확정 삭제 (원본 revert_confirmed_distribution — 확정행 자체 DELETE)
    if (action === "revert") {
      const reqId = Number(body.request_id);
      if (!reqId) return jsonResponse({ error: "request_id가 필요합니다." }, 400);
      const { data, error } = await supabase
        .from("item_requests")
        .delete()
        .eq("id", reqId)
        .eq("status", "확정")
        .select("id")
        .maybeSingle();
      if (error) return jsonResponse({ error: "삭제에 실패했습니다." }, 500);
      if (!data) return jsonResponse({ error: "확정 상태의 신청을 찾을 수 없습니다." }, 404);
      return jsonResponse({ ok: true });
    }

    // 충돌 해결: 선택 외 건 반려 + 다음 대기자(기여점수순) 자동 승격 (원본 decline_conflict_item + get_next_pending_applicant)
    if (action === "decline_conflict") {
      const reqId = Number(body.request_id);
      if (!reqId) return jsonResponse({ error: "request_id가 필요합니다." }, 400);
      const { data: declined, error } = await supabase
        .from("item_requests")
        .update({ status: "반려" })
        .eq("id", reqId)
        .eq("status", "확정")
        .select("item_id")
        .maybeSingle();
      if (error) return jsonResponse({ error: "반려 처리에 실패했습니다." }, 500);
      if (!declined) return jsonResponse({ error: "확정 상태의 신청을 찾을 수 없습니다." }, 404);

      const { data: next } = await supabase
        .from("item_requests")
        .select("user_id")
        .eq("item_id", declined.item_id)
        .eq("status", "대기")
        .order("current_contribution_score", { ascending: false })
        .order("request_date", { ascending: true })
        .limit(1);
      let promoted: string | null = null;
      if (next && next.length) {
        const { data: rpcRes } = await supabase.rpc("confirm_item_distribution", {
          p_item_id: declined.item_id,
          p_winner_user_id: next[0].user_id,
        });
        if (rpcRes === "ok") {
          const { data: pm } = await supabase.from("members").select("current_id").eq("user_id", next[0].user_id).maybeSingle();
          promoted = (pm && pm.current_id) || next[0].user_id;
        }
      }
      return jsonResponse({ ok: true, promoted });
    }

    // 최종확인: 이력 기록 + 재고 차감(RPC) → 장비/아퀴 자동 갱신 → 공금 자동 지급
    // 공금 입금이 RPC 밖인 것은 원본 app.py 호출부 책임 구조를 그대로 유지한 것.
    if (action === "finalize") {
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (!entries.length) return jsonResponse({ error: "entries가 필요합니다." }, 400);
      const results: Record<string, unknown>[] = [];
      for (const raw of entries) {
        const e = raw as Record<string, unknown>;
        const requestId = Number(e.request_id);
        const itemId = Number(e.item_id);
        const receiverUid = typeof e.receiver_user_id === "string" ? e.receiver_user_id : null;
        const receiverName = typeof e.receiver_name === "string" ? e.receiver_name : receiverUid || "";
        const diamond = Math.max(0, Number(e.diamond) || 0);
        const cash = Math.max(0, Number(e.cash) || 0);
        if (!requestId || !itemId) {
          results.push({ request_id: requestId, ok: false, error: "request_id/item_id 누락" });
          continue;
        }
        const { data: fin, error: finErr } = await supabase.rpc("finalize_distribution", {
          p_item_id: itemId,
          p_receiver_name: receiverName,
          p_receiver_user_id: receiverUid,
          p_request_id: requestId,
          p_diamond: diamond,
          p_cash: cash,
        });
        if (finErr || !fin || !fin.length) {
          results.push({ request_id: requestId, ok: false, error: "최종확인 처리 실패" });
          continue;
        }
        const f = fin[0];

        // 수령자 장비/아퀴 자동 갱신 (원본은 finalize 내부 — 실패해도 분배 자체는 유효)
        try {
          await updateMemberOnDistribution(receiverUid, { item_name: f.item_name, category: f.category, grade: f.grade });
        } catch {
          // 무시 (원본도 부가 갱신)
        }

        // 다이아: 반드시 룻자(운영진) 계좌로 입금 — 수령자 폴백 금지.
        // 우선순위: UI에서 선택한 룻자 → 아이템의 looter_user_id → looter 이름 매칭 → 결사 금고.
        let diaTo: string | null = null;
        let diaName = "";
        if (diamond > 0) {
          const chosenLooter = typeof e.looter_user_id === "string" && e.looter_user_id ? e.looter_user_id : null;
          if (chosenLooter) {
            const { data: cm } = await supabase.from("members").select("user_id, current_id").eq("user_id", chosenLooter).maybeSingle();
            if (cm) {
              diaTo = cm.user_id;
              diaName = cm.current_id || cm.user_id;
            }
          }
          if (!diaTo && f.looter_user_id) {
            diaTo = f.looter_user_id;
            diaName = f.looter || f.looter_user_id;
          }
          if (!diaTo && f.looter) {
            const { data: lm } = await supabase.from("members").select("user_id, current_id").eq("current_id", f.looter).limit(1);
            if (lm && lm.length) {
              diaTo = lm[0].user_id;
              diaName = lm[0].current_id;
            }
          }
          if (!diaTo) {
            diaTo = "guild_treasury";
            diaName = "결사 금고";
          }
          // 계좌 통합 별칭 (app_settings.dia_account_alias, 예: {"크앙":"admin"} = 곰형→관리자).
          // 어떤 경로로 곰형이 정해져도 실제 입금은 관리자 계좌로 간다. 분배취소도 같은 별칭 적용(0010).
          try {
            const { data: aliasRow } = await supabase.from("app_settings").select("value").eq("key", "dia_account_alias").maybeSingle();
            if (aliasRow && aliasRow.value) {
              const alias = JSON.parse(aliasRow.value) as Record<string, string>;
              if (alias[diaTo]) {
                const { data: am } = await supabase.from("members").select("user_id, current_id").eq("user_id", alias[diaTo]).maybeSingle();
                if (am) {
                  diaTo = am.user_id;
                  diaName = am.current_id || am.user_id;
                }
              }
            }
          } catch {
            // 별칭 설정이 없거나 형식 오류면 원래 대상 유지
          }
          const { error: diaErr } = await supabase.rpc("apply_treasury_transaction", {
            p_asset_type: "다이아",
            p_direction: "입금",
            p_amount: diamond,
            p_owner_user_id: diaTo,
            p_owner_name: diaName,
            p_description: `분배: ${f.item_name} → ${receiverName}`,
            p_ref_type: "distribution",
            p_ref_id: String(f.history_id),
            p_created_by: user.user_id,
          });
          if (diaErr) {
            results.push({ request_id: requestId, ok: true, history_id: f.history_id, warn: "다이아 입금 실패 — 공금 관리에서 수동 입금 필요" });
            continue;
          }
        }
        // 현금: 결사 금고 입금 (원본 8715-8721)
        if (cash > 0) {
          const { error: cashErr } = await supabase.rpc("apply_treasury_transaction", {
            p_asset_type: "현금",
            p_direction: "입금",
            p_amount: cash,
            p_owner_user_id: "guild_treasury",
            p_owner_name: "결사 금고",
            p_description: `분배: ${f.item_name} → ${receiverName}`,
            p_ref_type: "distribution",
            p_ref_id: String(f.history_id),
            p_created_by: user.user_id,
          });
          if (cashErr) {
            results.push({ request_id: requestId, ok: true, history_id: f.history_id, warn: "현금 입금 실패 — 공금 관리에서 수동 입금 필요" });
            continue;
          }
        }
        results.push({ request_id: requestId, ok: true, history_id: f.history_id });
      }
      return jsonResponse({ results });
    }

    // 분배취소 (관리자 전용 — 재고/신청/공금 역전 + 이력 삭제)
    if (action === "cancel_history") {
      if (!isAdmin(user)) return jsonResponse({ error: "분배취소는 관리자만 가능합니다." }, 403);
      const histId = Number(body.history_id);
      if (!histId) return jsonResponse({ error: "history_id가 필요합니다." }, 400);
      const { data, error } = await supabase.rpc("cancel_finalized_distribution", {
        p_history_id: histId,
        p_created_by: user.user_id,
      });
      if (error) return jsonResponse({ error: "분배취소에 실패했습니다." }, 500);
      if (data === "no_history") return jsonResponse({ error: "해당 이력을 찾을 수 없습니다." }, 404);
      return jsonResponse({ ok: true });
    }

    // 이력만 삭제 (관리자 전용 — 복원 없이 행 삭제, 원본 delete_distribution_history)
    if (action === "delete_history") {
      if (!isAdmin(user)) return jsonResponse({ error: "이력 삭제는 관리자만 가능합니다." }, 403);
      const histId = Number(body.history_id);
      if (!histId) return jsonResponse({ error: "history_id가 필요합니다." }, 400);
      const { error } = await supabase.from("distribution_history").delete().eq("id", histId);
      if (error) return jsonResponse({ error: "이력 삭제에 실패했습니다." }, 500);
      return jsonResponse({ ok: true });
    }
  }

  // ── 신청 화면 데이터 ──
  if (req.method === "GET") {
    const view = url.searchParams.get("view") || "items";

    // ── 신청 현황 (전 회원 조회 — 원본 get_items_with_requests_full) ──
    if (view === "status") {
      const staff = isStaff(user);
      const { data: inv, error: invErr } = await supabase
        .from("inventory")
        .select("id, item_name, grade, category, quantity, looter, raid_type, is_category_item, unsold_period_count")
        .eq("status", "재고");
      if (invErr) return jsonResponse({ error: "재고 조회에 실패했습니다." }, 500);
      const { data: reqs, error: reqErr } = await supabase
        .from("item_requests")
        .select("id, user_id, item_id, requested_quantity, current_contribution_score, request_date, preference_1, preference_2")
        .eq("status", "대기");
      if (reqErr) return jsonResponse({ error: "신청 조회에 실패했습니다." }, 500);

      const { data: mems } = await supabase
        .from("members")
        .select("user_id, current_id, role, power, equipment_info, contribution_score");
      const memById = new Map((mems || []).map((m) => [m.user_id, m]));

      // 운영진 화면용 자격 재검사 (원본 자격미달 일괄취소 블록) — 참여율은 시즌 단위 일괄 조회
      let partByUser = new Map<string, number>();
      let regs: Record<string, unknown> = {};
      if (staff) {
        regs = await getRegulations();
        let season = 1;
        const setting = regs.participation_rate_season;
        if (setting === "current" || setting == null) {
          const { data: cs } = await supabase.from("app_settings").select("value").eq("key", "current_season").maybeSingle();
          season = cs && cs.value != null && !Number.isNaN(parseInt(cs.value, 10)) ? parseInt(cs.value, 10) : 1;
        } else {
          season = parseInt(String(setting), 10) || 1;
        }
        const uids = [...new Set((reqs || []).map((r) => r.user_id))];
        if (uids.length) {
          const { data: sp } = await supabase
            .from("season_participation")
            .select("user_id, participation_rate")
            .eq("season", season)
            .in("user_id", uids);
          partByUser = new Map((sp || []).map((r) => [r.user_id, Math.round((r.participation_rate || 0) * 10) / 10]));
        }
      }

      // (item_name) 그룹 — 같은 이름 재고행 수량 합산 (원본 aggregated_qty)
      const invById = new Map((inv || []).map((i) => [i.id, i]));
      const groups = new Map<string, Record<string, unknown>>();
      for (const it of inv || []) {
        let g = groups.get(it.item_name);
        if (!g) {
          g = {
            item_name: it.item_name, grade: it.grade, category: it.category,
            quantity: 0, looters: [] as string[], item_ids: [] as number[],
            is_category_item: false, unsold_period_count: 0, raid_type: it.raid_type || "결사",
            requests: [] as Record<string, unknown>[],
          };
          groups.set(it.item_name, g);
        }
        g.quantity = (g.quantity as number) + (it.quantity || 0);
        (g.item_ids as number[]).push(it.id);
        if (it.looter && !(g.looters as string[]).includes(it.looter)) (g.looters as string[]).push(it.looter);
        g.is_category_item = (g.is_category_item as boolean) || !!it.is_category_item;
        g.unsold_period_count = Math.max(g.unsold_period_count as number, it.unsold_period_count || 0);
      }

      for (const r of reqs || []) {
        const it = invById.get(r.item_id);
        if (!it) continue;
        const g = groups.get(it.item_name);
        if (!g) continue;
        const m = memById.get(r.user_id);
        const row: Record<string, unknown> = {
          id: r.id,
          item_id: r.item_id,
          user_id: r.user_id,
          nick: (m && m.current_id) || r.user_id,
          role: (m && m.role) || "결사원",
          qty: r.requested_quantity || 1,
          score: r.current_contribution_score || 0,
          request_date: r.request_date,
          preference_1: r.preference_1,
          preference_2: r.preference_2,
        };
        if (staff && m) {
          const part = partByUser.get(r.user_id) ?? 0;
          const elig = checkEligibility(
            it.item_name, it.category, it.grade,
            { power: m.power, equipment_info: m.equipment_info, power_img_url: null, status_check_img_url: null, contribution_score: m.contribution_score },
            regs, part, (groups.get(it.item_name)?.unsold_period_count as number) || 0,
          );
          row.ineligible = !elig.eligible && m.role !== "관리자" && m.role !== "운영진";
          if (!elig.eligible) {
            row.inelig_reason = elig.failed.map((f) => `${f.label} ${f.current} (기준 ${f.required})`).join(", ");
          }
        }
        (g.requests as Record<string, unknown>[]).push(row);
      }

      // 정렬: 기여점수 내림차순 → 신청일 오름차순 (원본 고정 규칙)
      const list = [...groups.values()].map((g) => {
        (g.requests as { score: number; request_date: string }[]).sort(
          (a, b) => b.score - a.score || String(a.request_date).localeCompare(String(b.request_date)),
        );
        g.tab = classifyTab(String(g.item_name), g.category as string | null, g.grade as string | null);
        return g;
      });
      const period = await getActivePeriod();
      return jsonResponse({ period, is_staff: staff, groups: list });
    }

    // ── 확정 목록 (원본 get_confirmed_distributions — 운영진은 전체, 일반은 본인 것만) ──
    if (view === "confirmed") {
      const staff = isStaff(user);
      let q = supabase
        .from("item_requests")
        .select("id, user_id, item_id, requested_quantity, current_contribution_score, request_date, is_dispatched, dispatched_at, preference_1, preference_2")
        .eq("status", "확정")
        .order("request_date", { ascending: false });
      if (!staff) q = q.eq("user_id", user.user_id);
      const { data: reqs, error } = await q;
      if (error) return jsonResponse({ error: "확정 목록 조회에 실패했습니다." }, 500);

      const itemIds = [...new Set((reqs || []).map((r) => r.item_id))];
      const invById = new Map<number, Record<string, unknown>>();
      if (itemIds.length) {
        const { data: items } = await supabase
          .from("inventory")
          .select("id, item_name, grade, category, quantity, looter, looter_user_id")
          .in("id", itemIds)
          .eq("status", "재고");
        for (const it of items || []) invById.set(it.id, it);
      }
      const uids = [...new Set((reqs || []).map((r) => r.user_id))];
      const nickByUid = new Map<string, string>();
      if (uids.length) {
        const { data: ms } = await supabase.from("members").select("user_id, current_id").in("user_id", uids);
        for (const m of ms || []) nickByUid.set(m.user_id, m.current_id || m.user_id);
      }

      const rows = (reqs || [])
        .filter((r) => invById.has(r.item_id)) // 원본: i.status='재고' 조인 조건
        .map((r) => {
          const it = invById.get(r.item_id)!;
          return {
            request_id: r.id,
            item_id: r.item_id,
            user_id: r.user_id,
            nick: nickByUid.get(r.user_id) || r.user_id,
            item_name: it.item_name,
            grade: it.grade,
            category: it.category,
            stock_qty: it.quantity,
            looter: it.looter,
            qty: r.requested_quantity || 1,
            score: r.current_contribution_score || 0,
            request_date: r.request_date,
            is_dispatched: !!r.is_dispatched,
            dispatched_at: r.dispatched_at,
          };
        });
      return jsonResponse({ is_staff: staff, rows });
    }

    // ── 분배 이력 (전 회원 조회 — 원본 get_distribution_history; cash_amount 미조회 버그는 수정해 포함) ──
    if (view === "history") {
      const { data: rows, error } = await supabase
        .from("distribution_history")
        .select("id, item_name, category, grade, quantity, looter, looter_user_id, receiver, receiver_user_id, registered_at, distributed_at, diamond_amount, cash_amount")
        .order("distributed_at", { ascending: false })
        .limit(500);
      if (error) return jsonResponse({ error: "이력 조회에 실패했습니다." }, 500);

      // 룻자/수령자 현재 닉네임으로 표시 (원본 COALESCE(멤버 current_id, dh.looter))
      const uids = [...new Set((rows || []).flatMap((r) => [r.looter_user_id, r.receiver_user_id]).filter(Boolean))] as string[];
      const nickByUid = new Map<string, string>();
      if (uids.length) {
        const { data: ms } = await supabase.from("members").select("user_id, current_id").in("user_id", uids);
        for (const m of ms || []) nickByUid.set(m.user_id, m.current_id || m.user_id);
      }
      return jsonResponse({
        is_admin: isAdmin(user),
        rows: (rows || []).map((r) => ({
          ...r,
          looter: (r.looter_user_id && nickByUid.get(r.looter_user_id)) || r.looter,
          receiver: (r.receiver_user_id && nickByUid.get(r.receiver_user_id)) || r.receiver,
        })),
      });
    }

    if (view === "my") {
      const { data, error } = await supabase
        .from("item_requests")
        .select("id, item_id, requested_quantity, preference_1, preference_2, request_date, current_contribution_score, status")
        .eq("user_id", user.user_id)
        .eq("status", "대기")
        .order("request_date", { ascending: false });
      if (error) return jsonResponse({ error: "신청 목록 조회에 실패했습니다." }, 500);

      // 아이템명 조인 (FK 없음 — 2단계 조회)
      const itemIds = [...new Set((data || []).map((r) => r.item_id))];
      const nameMap = new Map<number, { item_name: string; grade: string | null }>();
      if (itemIds.length) {
        const { data: items } = await supabase.from("inventory").select("id, item_name, grade").in("id", itemIds);
        for (const it of items || []) nameMap.set(it.id, { item_name: it.item_name, grade: it.grade });
      }
      return jsonResponse(
        (data || []).map((r) => ({
          ...r,
          item_name: nameMap.get(r.item_id)?.item_name || "(삭제된 아이템)",
          grade: nameMap.get(r.item_id)?.grade || null,
        })),
      );
    }

    // view === "items"
    let period = await getActivePeriod();
    let autoConfirmed = 0;
    if (period && kstNowEpoch() >= naiveKstToEpoch(String(period.end_time))) {
      // 원본과 동일: 화면 로드 시점에 마감 경과 감지 → 자동확정 + 종료 (RPC가 중복 실행 방지)
      const { data } = await supabase.rpc("close_distribution_period", { p_period_id: period.id });
      autoConfirmed = data ?? 0;
      period = { ...period, status: "종료" };
    }

    const { data: inv, error: invErr } = await supabase
      .from("inventory")
      .select("id, item_name, grade, category, quantity, looter, raid_type, drop_date, unsold_period_count, is_category_item")
      .eq("status", "재고");
    if (invErr) return jsonResponse({ error: "재고 조회에 실패했습니다." }, 500);

    // 본인 정보 + 규정 + 참여율
    const { data: me } = await supabase
      .from("members")
      .select("power, equipment_info, power_img_url, status_check_img_url, contribution_score, participation_score")
      .eq("user_id", user.user_id)
      .maybeSingle();
    const regs = await getRegulations();
    const participation = await getParticipationRate(user.user_id, regs);

    // 본인의 기존 신청(대기/확정) — item_name 기준 중복 표시용
    const { data: myReqs } = await supabase
      .from("item_requests")
      .select("item_id, status")
      .eq("user_id", user.user_id)
      .in("status", ["대기", "확정"]);
    const invById = new Map((inv || []).map((i) => [i.id, i]));
    const myRequestedNames = new Set<string>();
    for (const r of myReqs || []) {
      const it = invById.get(r.item_id);
      if (it) myRequestedNames.add(it.item_name);
    }

    // (item_name, raid_type) 그룹핑 — 원본 6527-6560
    const groups = new Map<string, Record<string, unknown>>();
    for (const it of inv || []) {
      const rt = it.raid_type || "결사";
      const key = `${it.item_name}|${rt}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          item_name: it.item_name,
          raid_type: rt,
          grade: it.grade,
          category: it.category,
          quantity: 0,
          looters: [] as string[],
          item_ids: [] as number[],
          drop_date: null as string | null,
          unsold_period_count: 0,
          is_category_item: false,
        };
        groups.set(key, g);
      }
      g.quantity = (g.quantity as number) + (it.quantity || 0);
      if (it.looter && !(g.looters as string[]).includes(it.looter)) (g.looters as string[]).push(it.looter);
      (g.item_ids as number[]).push(it.id);
      if (it.drop_date && (!g.drop_date || String(it.drop_date) > String(g.drop_date))) g.drop_date = it.drop_date;
      g.unsold_period_count = Math.max(g.unsold_period_count as number, it.unsold_period_count || 0);
      g.is_category_item = (g.is_category_item as boolean) || !!it.is_category_item;
    }

    const staff = isStaff(user);
    const periodActive = !!(period && period.status === "진행중");
    const memberRow: MemberRow = me || {
      power: 0, equipment_info: null, power_img_url: null, status_check_img_url: null, contribution_score: 0,
    };
    const hasPowerSs = !!memberRow.power_img_url;
    const hasAquiSs = !!memberRow.status_check_img_url;

    const groupList = [...groups.values()].map((g) => {
      const elig = checkEligibility(
        String(g.item_name), g.category as string | null, g.grade as string | null,
        memberRow, regs, participation, g.unsold_period_count as number,
      );
      let blocked: string | null = null;
      if (g.raid_type === "연합") blocked = "🔒 연합 룻 (신청불가)";
      else if (myRequestedNames.has(String(g.item_name))) blocked = "✅ 신청 완료";
      else if (!periodActive) blocked = "⏳ 신청 기간이 아닙니다";
      else if (!hasPowerSs) blocked = "📸 전투력 스샷 미등록 (신청불가)";
      else if (!hasAquiSs) blocked = "📸 아퀴룬 스샷 미등록 (신청불가)";
      else if (!elig.eligible && !staff) blocked = "❌ 자격 미달";

      return {
        ...g,
        tab: classifyTab(String(g.item_name), g.category as string | null, g.grade as string | null),
        first_item_id: (g.item_ids as number[])[0],
        applied: myRequestedNames.has(String(g.item_name)),
        eligibility: elig,
        blocked_reason: blocked,
        can_apply: blocked === null,
      };
    });

    return jsonResponse({
      period,
      auto_confirmed: autoConfirmed,
      my: { participation_rate: participation, contribution_score: memberRow.contribution_score || 0, has_power_ss: hasPowerSs, has_aqui_ss: hasAquiSs },
      groups: groupList,
    });
  }

  // ── 신청 등록 ──
  if (req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }

    const itemId = Number(body.item_id);
    if (!itemId) return jsonResponse({ error: "item_id가 필요합니다." }, 400);

    const period = await getActivePeriod();
    if (!period || kstNowEpoch() >= naiveKstToEpoch(String(period.end_time))) {
      return jsonResponse({ error: "분배 신청 기간이 아닙니다." }, 400);
    }

    const { data: item } = await supabase
      .from("inventory")
      .select("id, item_name, grade, category, raid_type, unsold_period_count, is_category_item")
      .eq("id", itemId)
      .eq("status", "재고")
      .maybeSingle();
    if (!item) return jsonResponse({ error: "해당 재고를 찾을 수 없습니다." }, 404);
    if ((item.raid_type || "결사") === "연합") return jsonResponse({ error: "연합 룻 아이템은 신청할 수 없습니다." }, 400);

    const { data: me } = await supabase
      .from("members")
      .select("power, equipment_info, power_img_url, status_check_img_url, contribution_score, participation_score")
      .eq("user_id", user.user_id)
      .maybeSingle();
    if (!me) return jsonResponse({ error: "회원 정보를 찾을 수 없습니다." }, 500);
    if (!me.power_img_url) return jsonResponse({ error: "전투력 스샷 미등록 상태라 신청할 수 없습니다." }, 400);
    if (!me.status_check_img_url) return jsonResponse({ error: "아퀴룬 스샷 미등록 상태라 신청할 수 없습니다." }, 400);

    // 같은 이름 재고 총량 (수량 상한)
    const { data: sameName } = await supabase
      .from("inventory")
      .select("quantity, unsold_period_count")
      .eq("item_name", item.item_name)
      .eq("status", "재고");
    const totalQty = (sameName || []).reduce((s, r) => s + (r.quantity || 0), 0);
    const maxUnsold = Math.max(0, ...(sameName || []).map((r) => r.unsold_period_count || 0));

    const regs = await getRegulations();
    const participation = await getParticipationRate(user.user_id, regs);
    const elig = checkEligibility(item.item_name, item.category, item.grade, me, regs, participation, maxUnsold);
    if (!elig.eligible && !isStaff(user)) {
      const reason = elig.failed.map((f) => `${f.label}: ${f.current} (기준 ${f.required})`).join(", ");
      return jsonResponse({ error: `신청 자격 미달 — ${reason}` }, 403);
    }

    // 심연석류(별빛 심연석·조각, 찬란한 심연석)는 수량·재고 개념 없이 신청만 받는다 —
    // 수량 1 고정, 재고 수량 상한 검증 없음. 선정은 운영진이 신청자 중에서 직접 확정.
    const openNameNorm = item.item_name.replace(/ /g, "");
    const isOpenApply = openNameNorm.includes("별빛심연석") ||
      (openNameNorm.includes("찬란한") && openNameNorm.includes("심연석"));

    let qty = 1;
    let pref1 = "";
    let pref2 = "";
    if (item.is_category_item) {
      // 카테고리 아이템: 수량 1 고정, 1순위 필수 (원본 다이얼로그 동일)
      pref1 = typeof body.preference_1 === "string" ? body.preference_1.trim() : "";
      pref2 = typeof body.preference_2 === "string" ? body.preference_2.trim() : "";
      if (!pref1) return jsonResponse({ error: "1순위 선호를 입력해주세요." }, 400);
    } else if (isOpenApply) {
      qty = 1;
    } else {
      qty = Number(body.quantity);
      if (!Number.isInteger(qty) || qty < 1) return jsonResponse({ error: "수량은 1 이상의 정수여야 합니다." }, 400);
      const nameNorm = item.item_name.replace(/ /g, "");
      const cap = nameNorm.includes("찬란한") ? Math.min(totalQty, 3) : totalQty;
      if (qty > cap) return jsonResponse({ error: `신청 수량은 최대 ${cap}개입니다.` }, 400);
    }

    const { data: rpcResult, error: rpcErr } = await supabase.rpc("add_item_request_safe", {
      p_user_id: user.user_id,
      p_item_id: itemId,
      p_score: me.contribution_score || 0,
      p_qty: qty,
      p_pref1: pref1,
      p_pref2: pref2,
    });
    if (rpcErr) return jsonResponse({ error: "신청 처리에 실패했습니다." }, 500);

    if (rpcResult === "dup_confirmed") {
      return jsonResponse({ error: "이미 확정 대기 중인 신청이 있습니다. 나감 처리 후 재신청할 수 있습니다." }, 409);
    }
    if (rpcResult === "dup_pending") return jsonResponse({ error: "이미 신청하셨습니다." }, 409);
    if (rpcResult === "no_item") return jsonResponse({ error: "해당 재고를 찾을 수 없습니다." }, 404);
    return jsonResponse({ ok: true }, 201);
  }

  // ── 신청 취소 ──
  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "id가 필요합니다." }, 400);
    const { data, error } = await supabase
      .from("item_requests")
      .update({ status: "취소" })
      .eq("id", Number(id))
      .eq("user_id", user.user_id)
      .eq("status", "대기")
      .select()
      .maybeSingle();
    if (error) return jsonResponse({ error: "취소에 실패했습니다." }, 500);
    if (!data) return jsonResponse({ error: "취소할 수 있는 신청을 찾을 수 없습니다." }, 404);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "지원하지 않는 메서드입니다." }, 405);
});
