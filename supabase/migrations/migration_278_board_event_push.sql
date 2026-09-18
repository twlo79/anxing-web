/*
 * migration_278_board_event_push.sql　2026-09-18
 * 佈告欄排新活動 → 推播（用 SQL 接，不靠後台的 Webhooks 畫面）
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *          ★★ 跑完還要跑**另外那一張卡**（把金鑰填進去），不然自檢第 ⑤ 列會是紅的。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼改用 SQL 接】
 *
 * 2026-09-18 使用者:「沒 webhook」—— 他的 Supabase 後台
 * Database 底下沒有「Webhooks」那一項（版本不同，它搬家了）。
 *
 * 而那個畫面做的事**本來就是產生一支觸發器** —— 直接寫成 SQL 有三個好處:
 *
 *   ① 不用在後台找選單，找不到就卡住
 *   ② 進 repo，換一個專案照著跑一次就有
 *   ③ **檢查得到**。畫面上設的東西沒有任何地方驗得出「它還在不在」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 金鑰不寫在這一支裡】
 *
 * `x-push-key` 要跟 Vercel 的 `PUSH_KEY` 一樣。
 * 那個值**不進 repo** —— 這支 migration 是會被 commit 的，
 * 寫進來等於把金鑰永久留在 git 歷史裡，而 git 歷史刪不掉。
 *
 * 所以金鑰放在 `app_secrets` 這張表，由**另外一張卡**填進去
 * （那張卡不要存檔、不要 commit，跑完就關掉）。
 *
 * ★ `app_secrets` 開了 RLS **而且一條 policy 都沒有** ——
 *   等於前端與任何登入者都讀不到。只有 SECURITY DEFINER 的觸發器讀得到。
 *   （這是少數「RLS 開著沒 policy」是**正確**的地方:
 *     平常那是 migration_206 那種 bug，這裡是刻意的。）
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 推播失敗不可以擋住活動建立】
 *
 * 觸發器整段包在 exception 裡。推不出去是小事，
 * **建不了活動是大事** —— 而使用者不會知道那是推播的問題。
 *
 * ★ 代價:推播默默失敗時沒有人會叫。所以自檢第 ⑤ 列在看金鑰有沒有設，
 *   而 `net._http_response` 裡查得到每一次的結果（底下有查法）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 只掛 Insert】
 *
 * 掛上 Update 的話，改一個錯字都會叮全公司一次 ——
 * 而被叮了三次沒意義的通知之後，人就不會再點這種通知了，
 * **包括真的要看的那一則**（`api/push/board-event/route.ts` 的註解同一句）。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ① 裝 pg_net（發 HTTP 用）══════
/*
 * ★ 裝擴充**一定要包起來**。SQL Editor 把整份腳本包在一個交易裡，
 *   任一錯誤全部回滾（README）—— 而某些專案這支已經裝好了。
 */
do $do$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net 裝不起來（可能已經裝了，或這個專案不給裝）:%', sqlerrm;
end $do$;

-- ══════ ② 金鑰放這裡（值不在這支裡）══════

create table if not exists public.app_secrets (
  name       text primary key,
  value      text not null,
  updated_at timestamptz not null default clock_timestamp()
);

comment on table public.app_secrets is
  '給資料庫內部用的祕密(目前只有推播的 push_key 與 push_url)。'
  '★★★ RLS 開著而且**故意一條 policy 都沒有** —— 前端與任何登入者都讀不到,'
  '  只有 SECURITY DEFINER 的觸發器讀得到。'
  '★ 值不寫進 migration:那會永久留在 git 歷史裡。用另外一張一次性的卡填。';

/*
 * ★★★ 開 RLS、不給 policy、把權限收回來。三件事都要做:
 *   只開 RLS 不收 grant 的話，service_role 那條路還是讀得到。
 */
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

-- ══════ ③ 觸發器 ══════

create or replace function public.notify_board_event()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $fn$
declare v_key text; v_url text;
begin
  select value into v_key from public.app_secrets where name = 'push_key';
  select value into v_url from public.app_secrets where name = 'push_url';

  /* ★ 沒設金鑰就安靜跳過 —— 不要擋住活動建立。自檢第 ⑤ 列在看這件事 */
  if v_key is null or v_url is null then return new; end if;

  perform net.http_post(
    url     := rtrim(v_url, '/') || '/api/push/board-event',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-push-key',   v_key),
    /*
     * ★★ 形狀要跟 Supabase Webhook 一樣（`{ type, table, record }`）——
     *   那支 route 讀的是 `body.record`，換一種形狀它會回 400
     *   而這裡看不到（http_post 是非同步的）。
     */
    body    := jsonb_build_object(
                 'type',   'INSERT',
                 'table',  'board_events',
                 'record', to_jsonb(new))
  );
  return new;
exception when others then
  /*
   * ★★★ 推不出去是小事，**建不了活動是大事**。
   *   代價是推播默默失敗 —— 查法在 migration 檔頭。
   */
  raise notice '佈告欄推播送不出去:%', sqlerrm;
  return new;
end $fn$;

comment on function public.notify_board_event() is
  '佈告欄排了新活動就打 /api/push/board-event(migration_278)。'
  '★ 只掛 Insert —— 掛 Update 的話改一個錯字都會叮全公司一次。'
  '★★ 整段包在 exception 裡:推播失敗不可以擋住活動建立。';

drop trigger if exists trg_board_event_push on public.board_events;
create trigger trg_board_event_push
  after insert on public.board_events
  for each row execute function public.notify_board_event();

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('278_board_event_push');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════
select * from (

  select 1 as ord, '① pg_net 裝好了沒' as "檢查",
         coalesce((select 'pg_net ' || extversion from pg_extension
                    where extname = 'pg_net'), '（沒裝）') as "結果",
         case when exists (select 1 from pg_extension where extname = 'pg_net')
              then '✅' else '❌ 沒有它發不出 HTTP —— 推播不會動' end as "判定"

  union all
  select 2, '② 觸發器掛上去了沒（而且只掛 Insert）',
         coalesce((select t.tgname::text || '（'
                     || case when (t.tgtype & 4) > 0 then 'INSERT' else '' end
                     || case when (t.tgtype & 16) > 0 then '＋UPDATE ⚠' else '' end
                     || case when (t.tgtype & 8) > 0 then '＋DELETE ⚠' else '' end || '）'
                     from pg_trigger t
                     join pg_class c on c.oid = t.tgrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where not t.tgisinternal and n.nspname = 'public'
                      and c.relname = 'board_events'
                      and t.tgname::text = 'trg_board_event_push'), '（不在）'),
         case when not exists (select 1 from pg_trigger t
                                join pg_class c on c.oid = t.tgrelid
                                join pg_namespace n on n.oid = c.relnamespace
                               where not t.tgisinternal and n.nspname = 'public'
                                 and c.relname = 'board_events'
                                 and t.tgname::text = 'trg_board_event_push')
              then '❌ 不在 —— 建了活動不會有通知，而且不會有錯誤訊息'
              when exists (select 1 from pg_trigger t
                            join pg_class c on c.oid = t.tgrelid
                            join pg_namespace n on n.oid = c.relnamespace
                           where not t.tgisinternal and n.nspname = 'public'
                             and c.relname = 'board_events'
                             and t.tgname::text = 'trg_board_event_push'
                             and (t.tgtype & 24) > 0)
              then '⚠ 不只掛 Insert —— 改一個錯字就會叮全公司'
              else '✅ 只在新增時推' end

  union all
  /*
   * ★★★ 金鑰那張表**開了 RLS 而且故意沒有 policy**。
   *   有 policy 的話前端就讀得到金鑰 —— 那比沒有推播嚴重得多。
   */
  select 3, '★★★ ③ 金鑰讀不到吧（RLS 開、policy 0 條）',
         case when to_regclass('public.app_secrets') is null then '★ 表不在'
              else (case when (select relrowsecurity from pg_class
                                where oid = 'public.app_secrets'::regclass)
                         then 'RLS ✅' else 'RLS ❌' end)
                   || '　policy ' || (select count(*)::text from pg_policies
                                       where schemaname = 'public'
                                         and tablename = 'app_secrets') || ' 條'
         end,
         case when to_regclass('public.app_secrets') is null then '❌ 表不在'
              when not (select relrowsecurity from pg_class
                         where oid = 'public.app_secrets'::regclass)
              then '❌ RLS 沒開 —— 任何登入者都讀得到金鑰'
              when (select count(*) from pg_policies
                     where schemaname = 'public' and tablename = 'app_secrets') > 0
              then '❌ **有 policy** —— 這張表要一條都沒有才讀不到'
              else '✅ 誰都讀不到，只有觸發器讀得到' end

  union all
  select 4, '★★ ④ 觸發器整段有沒有包 exception',
         case when coalesce((select pg_get_functiondef(p.oid) from pg_proc p
                              join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname = 'public' and p.prokind in ('f','p')
                               and p.proname::text = 'notify_board_event'), '')
                   like '%exception%' then '有' else '沒有 ❌' end,
         case when coalesce((select pg_get_functiondef(p.oid) from pg_proc p
                              join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname = 'public' and p.prokind in ('f','p')
                               and p.proname::text = 'notify_board_event'), '')
                   like '%exception%'
              then '✅ 推播失敗不會擋住活動建立'
              else '❌ 推播一失敗就建不了活動' end

  union all
  /*
   * ★★★ 這一列**剛跑完一定是紅的** —— 金鑰還沒填。
   *   填完再跑一次這支就會變綠（它是冪等的）。
   *   ★ 只印「有沒有」與長度，**不印值**（這張表會被貼回對話裡）。
   */
  select 5, '★★★ ⑤ 金鑰填了沒',
         case when to_regclass('public.app_secrets') is null then '★ 表不在'
              else coalesce((select string_agg(
                       s.name || '：' ||
                       case when btrim(s.value) = '' then '空的'
                            else '已設（' || length(s.value)::text || ' 字）' end,
                       '　' order by s.name)
                     from public.app_secrets s
                    where s.name in ('push_key', 'push_url')), '（都還沒填）') end,
         case when to_regclass('public.app_secrets') is null then '❌ 表不在'
              when (select count(*) from public.app_secrets
                     where name in ('push_key', 'push_url') and btrim(value) <> '') = 2
              then '✅ 兩個都設好了'
              else '⚠ **還沒填** —— 去跑另外那張「填金鑰」的卡，然後再跑一次這支' end

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '278_board_event_push'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '278_board_event_push')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;


/*
 * ══════════════════════════════════════════════════════════
 * 【推播到底有沒有送出去？】排一場活動之後跑這句:
 *
 *   select id, status_code, error_msg, created
 *     from net._http_response order by id desc limit 5;
 *
 *   200 ＝ 成功；403 ＝ 金鑰不對；404 ＝ 網址不對。
 * ══════════════════════════════════════════════════════════
 */
