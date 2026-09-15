/*
 * 查-誰假設一張訂單只有一筆押金.sql　2026-09-15
 * 訂單要多一列「訂金」之前，先找出所有會被這件事弄壞的東西
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，出來的表整個貼回來。
 *          ★ 只有 select，一個字都不會改。
 *          ★ 欄位標題是「類別／名稱／內容」。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 現在的唯一索引是 dep_order_once_idx = UNIQUE(order_id)。
 * 也就是**一張訂單只能有一列 deposits** —— 所有幣別與寵物押金
 * 全部塞在同一列的 lines 裡，amount 是台幣合計。
 *
 * 訂金要有自己的生命週期（收 → 退／沒收／轉押金），
 * 所以它必須是**自己一列**。那就要把索引放寬成 (order_id, kind)。
 *
 * ★★★ 放寬之後，任何「照 order_id 撈押金、而且假設只會撈到一列」
 *   的程式都會壞掉。已經抓到兩個:
 *
 *     sync_order_deposits　　收尾沒有分 kind，會把訂金標成孤兒
 *     pickDeposit（前端）　　撈到兩列就回「many」，「從押金扣」整個失效
 *
 *   ★★ 資料庫裡還有沒有別的，我不知道 —— 所以問，不猜。
 *   猜錯的形狀是「某個功能安靜地不再作用」，而不是報錯。
 *
 * 【篩的條件】
 * 提到 deposits 與 order_id、但**完全沒提到 kind** 的函式 ——
 * 那正是「不知道有兩種押金」的那些。
 * ══════════════════════════════════════════════════════════
 */

select v.ord, v."類別", v."名稱", v."內容" from (

  /* ① 先給一張全景:所有碰 deposits 的函式，各自有沒有意識到 kind */
  select 1 as ord, '① 全部碰 deposits 的函式' as "類別",
         p.proname as "名稱",
         (case when p.prosrc ~ 'kind' then '有分 kind' else '★ 沒分 kind' end)
         || '　／　'
         || (case when p.prosrc ~ 'order_id' then '有碰 order_id' else '沒碰 order_id' end)
           as "內容"
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ~ 'deposits'

  union all
  /* ② 有風險的那幾支，完整原始碼 —— 我要在現在跑的那一份上面改 */
  select 2, '② 有風險的完整原始碼', p.proname,
         pg_get_functiondef(p.oid)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosrc ~ 'deposits' and p.prosrc ~ 'order_id' and p.prosrc !~ 'kind'
     and p.proname <> 'sync_order_deposits'

  union all
  /* ③ 檢視表也可能假設一列 */
  select 3, '③ 提到 deposits 的檢視表', c.relname,
         pg_get_viewdef(c.oid, true)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('v', 'm')
     and pg_get_viewdef(c.oid, true) ~ 'deposits'

) as v(ord, "類別", "名稱", "內容")
order by v.ord, v."名稱";
