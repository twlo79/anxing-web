-- migration_155：憑證號碼下放到請款項目
--
-- ============================================================
-- 【為什麼】（2026-08-19 發現，2026-08-21 使用者拍板）
--
-- 憑證號碼原本是**請款單層級**的一個欄位，而一張請款單可以有十幾個項目。
-- 十七張不同的收據沒有地方各自放，填單的人就把號碼用頓號串成一串
-- 塞進那一格。gen_expenses_from_pr 再把整串原封不動複製給**每一筆**
-- 產生出來的支出 —— 那支觸發器裡到現在還寫著:
--
--     「同一張發票本來就對應多個項目」
--
-- 那個假設在多張發票時就不成立。結果是計程車車資那筆的憑證號碼裡，
-- 混著差旅住宿的發票號。對帳的人拿著那個號碼去查，查到的是別的東西。
--
-- 2026-08-19 先做了顯示截斷（src/lib/voucher.ts）—— 那只是止血，
-- **資料還是錯的**。這支是真正的修法。
--
--
-- ============================================================
-- 【改成什麼】
--
--   預設        每個請款項目各自填自己的憑證號碼
--   共同憑證    勾起來之後改用請款單層級的那一個號碼
--               （真的只有一張發票、拆成多個項目報帳時用）
--
-- 使用者拍板的三件事（2026-08-21）:
--
--   ① 既有的 59 張全部標成「共同憑證」，號碼不動
--      → 舊單畫面上跟現在一模一樣。不複製到項目層級 ——
--        複製等於把一筆錯的資料變成十幾筆錯的，而且看起來像填好了。
--        「對不上的不猜」:少填一個看得到、補得回來;填錯一個沒有人會發現。
--
--   ② 勾了共同憑證之後，項目上已經填的號碼**留著但不使用**
--      → 前端灰掉。哪天取消勾選，號碼還在，不用重打。
--
--   ③ 每個項目各自有一個「無憑證」勾勾
--      → 五個項目裡四個有發票、一個是現金車馬費真的沒單據時，
--        那一項才表達得出來。沒有這個勾勾的話只能留空白，
--        而**空白跟「還沒填」長得一模一樣** —— 三個月後沒有人知道
--        該不該去追。
--
--
-- ============================================================
-- 【這支不動觸發器】
--
-- gen_expenses_from_pr 還是照舊把**請款單層級**的號碼複製給每筆支出。
-- 要改那支得先拿到線上的完整定義（baseline 這份已經被證實過期好幾次），
-- 所以拆成 migration_156。
--
-- 也就是說:**跑完這支之後，逐項憑證還不會流到支出頁**。
-- 前端可以填、存得進去、看得到，但支出頁的憑證欄要等 156。
-- 這是刻意的 —— 寧可分兩步，也不要照過期的定義覆寫一支正在用的觸發器。
-- ============================================================


-- ── ① 請款項目:各自的憑證 ──────────────────────────
alter table public.purchase_request_items
  add column if not exists voucher_no  text,
  add column if not exists no_voucher  boolean not null default false;

/*
 * 「勾了無憑證」與「填了號碼」不能同時成立 —— 那是自相矛盾的兩件事，
 * 而矛盾的資料在報表上會變成「有時候算有憑證、有時候算沒有」，
 * 取決於哪支程式先讀到哪一欄。
 *
 * 條件式與 pr_voucher_chk / exp_voucher_chk 一字不差,三張表同一套規則。
 */
do $$ begin
  alter table public.purchase_request_items
    add constraint pri_voucher_chk
    check (not (no_voucher and voucher_no is not null and voucher_no <> ''));
exception when duplicate_object then null;
end $$;

comment on column public.purchase_request_items.voucher_no is
  '這個項目自己的憑證號碼。請款單勾了 shared_voucher 時不使用（但保留，'
  '取消勾選就回來）—— migration_155。';
comment on column public.purchase_request_items.no_voucher is
  '這個項目確定沒有單據。與留空白是兩件事:空白是還沒填（migration_155）。';


-- ── ② 請款單:共同憑證的開關 ────────────────────────
alter table public.purchase_requests
  add column if not exists shared_voucher boolean not null default false;

comment on column public.purchase_requests.shared_voucher is
  '整張單共用一個憑證號碼（用 purchase_requests.voucher_no）。'
  '預設 false = 每個項目各自填。既有的單全部回填 true，'
  '所以舊單的行為完全不變（migration_155）。';


-- ── ③ 既有的單全部標成共同憑證 ─────────────────────
/*
 * ★ 為什麼是全部，不是只有「填了號碼的那些」。
 *
 * 沒填號碼的那幾張多半還是草稿。標成共同憑證之後，
 * 明天打開來看到的是**跟今天一模一樣**的畫面（單張一個號碼欄），
 * 不會有人在不知情的狀況下遇到一個新版面。
 * 要用逐項的話把勾勾取消掉就好 —— 那是一個看得見的動作。
 *
 * ★ 為什麼不 where voucher_no is not null。
 *   default false 已經套用在所有既有列上了，這裡是把它們改回 true。
 *   漏掉任何一張的症狀是「那一張單突然變成逐項模式」——
 *   而使用者不會知道為什麼只有那一張不一樣。
 */
update public.purchase_requests set shared_voucher = true;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('155_item_voucher');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★ 只能有**一個** SELECT。
 *   SQL Editor 只顯示最後一個 SELECT 的結果 ——
 *   寫兩個的話前面那張表永遠看不到（2026-08-21 踩過）。
 */
select "檢查項目", "結果", "說明" from (

  select 1 as ord, '★★ 項目的憑證欄位' as "檢查項目",
         count(*)::text || ' / 2' as "結果",
         case when count(*) = 2 then '✅ voucher_no 與 no_voucher 都建好了'
              else '❌ 欄位沒建起來' end as "說明"
    from information_schema.columns
   where table_schema = 'public'          -- 少了這個條件，其他 schema 的同名表會誤報
     and table_name  = 'purchase_request_items'
     and column_name in ('voucher_no', 'no_voucher')

  union all
  select 2, '★★ 共同憑證開關', count(*)::text || ' / 1',
         case when count(*) = 1 then '✅' else '❌ 欄位沒建起來' end
    from information_schema.columns
   where table_schema = 'public' and table_name = 'purchase_requests'
     and column_name = 'shared_voucher'

  union all
  select 3, '★ 矛盾資料的防線', count(*)::text || ' / 1',
         case when count(*) = 1 then '✅ 不能同時勾無憑證又填號碼'
              else '❌ 約束沒建起來' end
    from pg_constraint
   where conrelid = 'public.purchase_request_items'::regclass
     and conname  = 'pri_voucher_chk'

  union all
  /*
   * ★★ 這一項是重點:每一張既有的單都要是共同憑證。
   *   漏掉一張的症狀是那一張突然變成逐項模式，而沒有人知道為什麼。
   */
  select 4, '★★ 舊單全部標成共同憑證',
         count(*) filter (where shared_voucher)::text || ' / ' || count(*)::text,
         case when count(*) = count(*) filter (where shared_voucher)
              then '✅ 舊單畫面完全不變'
              else '❌ 有 ' || count(*) filter (where not shared_voucher)::text
                   || ' 張沒回填到' end
    from public.purchase_requests

  union all
  /*
   * ★ 這一項現在一定是 0 —— 欄位剛建好，還沒有人填過。
   *   它的用途是跑完 156 之後回來對照:那時候應該開始有數字。
   */
  select 5, '目前有逐項憑證的項目',
         count(*) filter (where voucher_no is not null or no_voucher)::text
           || ' / ' || count(*)::text,
         '剛建好，是 0 才正常'
    from public.purchase_request_items

) v order by ord;
