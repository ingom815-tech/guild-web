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

  if (cat === "아퀴" && grade === "전설" && (unsoldCount || 0) >= 2) {
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
  } else if (cat === "아퀴" && grade === "전설") {
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

// 5개 탭 분류 (app.py INV_GROUP_DEFS, 6562)
function classifyTab(itemName: string, category: string | null, grade: string | null): string {
  const noSpace = itemName.replace(/ /g, "");
  if (itemName.includes("브로치")) return "브로치";
  if (noSpace.includes("별빛심연석")) return "별빛심연석 및 조각";
  if (noSpace.includes("찬란한")) return "찬란한심연석";
  if ((category || "") === "아퀴" && grade === "전설") return "전퀴";
  return "나머지";
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

  // ── 신청 화면 데이터 ──
  if (req.method === "GET") {
    const view = url.searchParams.get("view") || "items";

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

    let qty = 1;
    let pref1 = "";
    let pref2 = "";
    if (item.is_category_item) {
      // 카테고리 아이템: 수량 1 고정, 1순위 필수 (원본 다이얼로그 동일)
      pref1 = typeof body.preference_1 === "string" ? body.preference_1.trim() : "";
      pref2 = typeof body.preference_2 === "string" ? body.preference_2.trim() : "";
      if (!pref1) return jsonResponse({ error: "1순위 선호를 입력해주세요." }, 400);
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
