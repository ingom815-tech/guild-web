-- 전체 20개 테이블 RLS 활성화. 정책은 하나도 만들지 않는다(= anon/publishable 키로는
-- PostgREST를 통해 어떤 테이블도 읽고 쓸 수 없음). 모든 접근은 Edge Function이
-- SUPABASE_SERVICE_ROLE_KEY(자동 주입, RLS 우회)로만 수행한다.

ALTER TABLE public.app_settings              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.distribution_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.distribution_period        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guild_assets               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guild_transactions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_log              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_master                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_requests              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_bank_accounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_nick_history        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.members                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_history            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_support            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participation_log_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participation_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registration_requests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season_participation       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sheet_id_mapping           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_sessions              ENABLE ROW LEVEL SECURITY;
