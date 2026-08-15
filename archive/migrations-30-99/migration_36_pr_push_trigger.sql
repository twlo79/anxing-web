-- migration_36：請款單狀態變動時呼叫推播 API
--
-- 等同於 Supabase Dashboard 的 Database Webhook，但寫成 SQL 進版控。
-- Dashboard 的 Webhook 介面本質上也只是建一個呼叫 HTTP 的觸發器，
-- 而那個介面在 2026 改版後換了位置；寫在這裡不會因為 UI 變動而找不到。
--
-- ⚠️ 執行前：把下面的 <PUSH_KEY> 換成你 .env.local 裡的 PUSH_KEY 值。
--    值不對的話 API 會回 403，通知不會發出，而且不會有任何錯誤提示。

-- pg_net 提供非同步 HTTP 呼叫。非同步很重要 —— 觸發器不能等待外部網路，
-- 否則推播服務慢或掛掉時，連帶把「核可」這個資料庫操作一起拖住。
create extension if not exists pg_net;


create or replace function public.pr_notify_push() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url     := 'https://justwork.oasisliving.tw/api/push/notify',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-push-key',   '<PUSH_KEY>'
               ),
    body    := jsonb_build_object(
                 'type',       'UPDATE',
                 'table',      'purchase_requests',
                 'record',     to_jsonb(new),
                 'old_record', to_jsonb(old)
               )
  );
  return new;
end $$;


-- 只掛 UPDATE，不掛 INSERT:
--   pr_insert 這條 RLS policy 強制新單一律是 draft，
--   而 draft 不需要通知任何人，掛 INSERT 只是白打一次 HTTP。
--
-- WHEN 條件把改採購日、改備註這類變動擋掉。
-- API 那端也有一層相同的判斷，但能在資料庫層就不發出請求更好 ——
-- 每天改幾次備註就打幾次外部 API 是沒必要的雜訊。
drop trigger if exists trg_pr_notify_push on public.purchase_requests;
create trigger trg_pr_notify_push
  after update on public.purchase_requests
  for each row
  when (
    new.status              is distinct from old.status
    or new.manager_approved_at is distinct from old.manager_approved_at
    or new.admin_approved_at   is distinct from old.admin_approved_at
  )
  execute function public.pr_notify_push();


-- ============================================================
-- 驗證
-- ============================================================
select tgname, tgenabled from pg_trigger
where tgrelid = 'public.purchase_requests'::regclass and not tgisinternal
order by tgname;

-- 送單後可以用這句看最近的呼叫結果（200 = 成功，403 = key 不對）
--   select id, status_code, content, created
--   from net._http_response order by id desc limit 5;
