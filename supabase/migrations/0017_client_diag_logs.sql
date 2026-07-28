-- 0017: 클라이언트 진단 로그 — 가입 화면 스샷 첨부 실패 원인 수집 (합병 대량 가입 기간 임시)
--
-- 결사원 폰에서 파일 선택/처리 단계에 실패하면 서버에 아무 흔적이 없어 진단 불가.
-- register 함수의 무인증 진단 엔드포인트(action=diag)가 이 테이블에 기록한다.
-- 파일 내용은 저장하지 않음 — 파일명/형식/크기/에러 문구/브라우저 정보만.
-- RLS 켜고 정책 0개 = anon 직접 접근 차단 (기록은 함수의 service_role로만).
--
-- 안정화 후 정리: DROP TABLE client_diag_logs; (함수 쪽은 테이블 없어도 조용히 무시)

CREATE TABLE IF NOT EXISTS client_diag_logs (
  id serial PRIMARY KEY,
  context text NOT NULL,          -- 예: register_attach(첨부 실패), register_submit(신청 전송 실패)
  detail text,                    -- JSON 문자열 (에러 문구, 파일명/형식/크기 등)
  user_agent text,                -- 기기/브라우저 식별용
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE client_diag_logs ENABLE ROW LEVEL SECURITY;
