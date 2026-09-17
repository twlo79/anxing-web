/*
 * 查-應繳日改算法會動到誰.sql　2026-09-17
 *
 * 【為什麼查這個】
 * 使用者要把「首繳日」與「幾號繳」兩個手填欄位拿掉，
 * 改成**從租期起日推算**應繳日。
 *
 * ══════════════════════════════════════════════════════════
 * ★★★ 現在 `pay_day` 是可以跟租期起日**不一樣**的。
 *   例如「租期起 11/15，但約定每月 5 號繳」—— 那是談出來的條件，
 *   不是資料填錯。改成一律從租期起日推，那幾張的應繳日會**全部變掉**，
 *   而應繳日會往下影響已經產生的月租單。
 *
 * ★★ 所以動手之前要先知道:**有幾張是這樣**。
 *   一張都沒有 → 這次改動對既有資料完全沒影響，可以放心做。
 *   有幾張　　 → 要先決定那幾張怎麼辦（沿用舊值？還是跟著改？）。
 *
 * ★ 這支**只讀不寫**，跑幾次都一樣。
 * ══════════════════════════════════════════════════════════
 *
 * 【怎麼看】最後一列的「判定」就是答案。上面那幾列是明細。
 */

with c as (
  select
    id, room, tenant_name, display_name, type, cadence,
    start_date, first_payment_date, pay_day, active,
    /* 租期起日的「日」—— 新算法會用的那個數字 */
    case when start_date is not null
         then extract(day from start_date)::int end as start_day,
    /*
     * 現在實際生效的「幾號繳」。
     * ★ 跟前端 `resolvePayDay()` 同一條規則:先看 pay_day，
     *   沒有才退而求其次用 first_payment_date 的日。
     *   兩邊各寫一次的話，這張表會跟畫面說不一樣的話。
     */
    coalesce(
      nullif(pay_day, 0),
      case when first_payment_date is not null
           then extract(day from first_payment_date)::int end
    ) as now_day
  from public.contracts
  where active = true
    and start_date is not null
),
diff as (
  select * from c
  where now_day is not null
    and start_day is not null
    and now_day <> start_day
)

select * from (

  select 0 as ord,
         '⚠ 會被改到的契約' as "區塊",
         room || '　' || coalesce(display_name, tenant_name, '（沒有名字）') as "是誰",
         '租期起 ' || start_date
           || '（' || start_day || ' 號）'
           || '　但現在算的是每月 ' || now_day || ' 號'
           || case when pay_day is not null and pay_day <> 0
                   then '（來自「幾號繳」）'
                   else '（來自「首繳日」' || coalesce(first_payment_date::text, '—') || '）' end
         as "差在哪"
  from diff

  union all

  select 9,
         '結論',
         (select count(*)::text from diff) || ' 張要處理・'
           || (select count(*)::text from c) || ' 張生效中的契約',
         case
           when (select count(*) from diff) = 0
             then '✅ 一張都沒有 —— 每一張契約的「幾號繳」本來就等於租期起日的日。'
                  || '改成從租期起日推算，既有資料一個數字都不會變，可以直接做。'
           else '⚠ 有 ' || (select count(*) from diff) || ' 張的「幾號繳」跟租期起日不一樣。'
                || '那是談出來的條件不是填錯 —— 上面列出來了，'
                || '要先決定這幾張怎麼辦再動手。'
         end

) t order by t.ord, t."是誰";
