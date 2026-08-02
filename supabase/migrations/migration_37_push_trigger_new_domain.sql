-- migration_37：推播觸發器改指向新網域
--
-- justwork.oasisliving.tw → justwork.estia.com.tw
--
-- 這支要重跑的原因：migration_36 把網址寫死在函式裡，而函式存在資料庫，
-- 改 repo 裡的 .sql 檔對正式環境沒有任何作用。必須在 Supabase 重新執行。
--
-- ⚠️ 執行前：把 <PUSH_KEY> 換成你 .env.local 裡的 PUSH_KEY 值（保留單引號）。
-- ⚠️ 執行時機：等新網域的 DNS 與 SSL 都生效之後再跑。
--    太早跑會讓推播打到一個還沒生效的網址，等於這段期間完全不會發通知。

create or replace function public.pr_notify_push() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url     := 'https://justwork.estia.com.tw/api/push/notify',
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

-- 觸發器本身不用重建，它綁的是函式名稱，函式換內容就生效。


-- ============================================================
-- 換網域會讓所有推播訂閱失效
--
-- Web Push 的訂閱是綁在 origin 上的，換網域之後舊訂閱永遠推不出去
-- （推播服務商會回 404/410）。與其留著等它慢慢失敗，不如直接清掉，
-- 讓每個人重新在新網址上開啟一次通知。
--
-- 目前只有你一台裝置訂閱過，成本很低。
-- ============================================================
delete from public.push_subscriptions;


-- ============================================================
-- 驗證
-- ============================================================
select prosrc like '%justwork.estia.com.tw%' as 已指向新網域
from pg_proc where proname = 'pr_notify_push';

select count(*) as 剩餘訂閱數_應為0 from public.push_subscriptions;
