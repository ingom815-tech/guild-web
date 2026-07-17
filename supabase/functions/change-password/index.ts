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

// user_sessions.user_id -> members.user_id 에 FK가 없어(직접 확인함) PostgREST embedded join을
// 쓸 수 없다. 그래서 두 단계로 조회한다.
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

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeHexEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

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

async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "POST만 지원합니다." }, 405);
  }

  const token = req.headers.get("x-session-token");
  const user = await validateSession(token);
  if (!user) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
  }

  const oldPassword = typeof body.old_password === "string" ? body.old_password : "";
  const newPassword = typeof body.new_password === "string" ? body.new_password : "";
  if (!oldPassword || !newPassword) {
    return jsonResponse({ error: "현재 비밀번호와 새 비밀번호를 입력해주세요." }, 400);
  }
  if (newPassword.length < 4) {
    return jsonResponse({ error: "새 비밀번호는 4자 이상이어야 합니다." }, 400);
  }

  const { data: member, error } = await supabase
    .from("members")
    .select("password")
    .eq("user_id", user.user_id)
    .maybeSingle();

  if (error || !member || !member.password) {
    return jsonResponse({ error: "현재 비밀번호가 올바르지 않습니다." }, 401);
  }

  const result = await verifyPassword(oldPassword, member.password);
  if (!result.valid) {
    return jsonResponse({ error: "현재 비밀번호가 올바르지 않습니다." }, 401);
  }

  const newHash = await hashPassword(newPassword);
  const { error: updateErr } = await supabase
    .from("members")
    .update({ password: newHash })
    .eq("user_id", user.user_id);

  if (updateErr) {
    return jsonResponse({ error: "비밀번호 변경에 실패했습니다." }, 500);
  }

  // 비밀번호 변경 시 다른 세션은 전부 무효화(현재 세션만 유지)
  await supabase
    .from("user_sessions")
    .delete()
    .eq("user_id", user.user_id)
    .neq("session_token", token);

  return jsonResponse({ ok: true });
});
