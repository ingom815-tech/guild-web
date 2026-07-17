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

// Supabase가 2026년 중 API 키 포맷을 sb_publishable_/sb_secret_ 로 전환 중이라(레거시
// SUPABASE_SERVICE_ROLE_KEY는 연말 폐기 예정), 신규 포맷(SUPABASE_SECRET_KEYS, JSON)을
// 우선 시도하고 없으면 레거시로 폴백한다. 둘 다 자동 주입되므로 별도 설정 불필요.
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

// 기존 Streamlit 앱(hashlib.sha256(pw).hexdigest())과 동일한 방식으로 SHA256 hex를 계산한다.
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 해시는 항상 고정 64자 hex이므로 길이 분기 자체는 정보 누출이 아님.
function timingSafeHexEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * 저장된 해시가 bcrypt(`$2`로 시작)면 bcrypt로, 아니면(레거시 SHA256 hex) SHA256으로 검증한다.
 * upgradeHash가 있으면 호출자가 bcrypt 해시로 UPDATE 해줘야 한다(점진적 업그레이드).
 */
async function verifyPassword(
  plain: string,
  stored: string,
): Promise<{ valid: boolean; upgradeHash?: string }> {
  if (stored.startsWith("$2")) {
    const ok = await bcrypt.compare(plain, stored);
    return { valid: ok };
  }
  const hex = await sha256Hex(plain);
  const ok = timingSafeHexEqual(hex, stored);
  if (!ok) return { valid: false };
  const upgradeHash = await bcrypt.hash(plain, 10);
  return { valid: true, upgradeHash };
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "POST만 지원합니다." }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
  }

  const user_id = typeof body.user_id === "string" ? body.user_id.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!user_id || !password) {
    return jsonResponse({ error: "아이디와 비밀번호를 입력해주세요." }, 400);
  }

  const { data: member, error } = await supabase
    .from("members")
    .select("user_id, password, role, current_id")
    .eq("user_id", user_id)
    .maybeSingle();

  // 존재하지 않는 아이디와 틀린 비밀번호를 같은 메시지로 응답 (계정 존재 여부 노출 방지)
  const invalid = () => jsonResponse({ error: "아이디 또는 비밀번호가 올바르지 않습니다." }, 401);

  if (error || !member || !member.password) return invalid();

  const result = await verifyPassword(password, member.password);
  if (!result.valid) return invalid();

  if (result.upgradeHash) {
    await supabase.from("members").update({ password: result.upgradeHash }).eq("user_id", user_id);
  }

  // 만료된 세션 정리(기회적) 후 새 세션 발급
  await supabase.from("user_sessions").delete().eq("user_id", user_id).lt("expires_at", new Date().toISOString());

  const token = crypto.randomUUID();
  const { error: insertErr } = await supabase
    .from("user_sessions")
    .insert({ session_token: token, user_id });

  if (insertErr) {
    return jsonResponse({ error: "세션 생성에 실패했습니다." }, 500);
  }

  return jsonResponse({
    token,
    user: { user_id: member.user_id, current_id: member.current_id, role: member.role },
  });
});
