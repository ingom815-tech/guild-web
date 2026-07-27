-- 결사 합병 준비 1단계: 결사명 설정 테이블.
-- 회원 계정(아이디/고정아이디/비밀번호)은 일절 건드리지 않는다.
-- members.guild_name은 문자열 그대로 유지하되 UI에서 guilds 목록 선택형으로 제한하고,
-- 결사명 변경 시 서버(guild_update)가 members/registration_requests의 기존 이름을 함께 전파한다.

CREATE TABLE IF NOT EXISTS public.guilds (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);

-- 기존 테이블들과 동일 원칙: RLS 활성화 + 정책 0개 (Edge Function의 service_role만 접근)
ALTER TABLE public.guilds ENABLE ROW LEVEL SECURITY;

-- 초기값: 임시명 4행 (실명 확정 시 운영진이 결사명 관리 UI에서 name만 수정)
INSERT INTO public.guilds (name, sort_order)
VALUES ('알파', 1), ('베타', 2), ('감마', 3), ('델타', 4)
ON CONFLICT (name) DO NOTHING;
