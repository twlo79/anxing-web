-- 查：支出筆數變少，是有人刪掉了嗎？
--
-- 貼進 Supabase SQL Editor，一段一段跑。這支只讀不寫。
--
-- 【先講清楚一件事】
-- expenses 沒有異動紀錄。沒有任何地方會記「誰在什麼時候刪了哪一筆」，
-- 所以沒辦法直接證明「有人刪過」。
-- （hk_audit 只涵蓋房務的四張設定主檔，跟支出無關。）
--
-- 【已經排除的：不是 migration】
-- migration_30 到 71 全掃過，expenses 只有 update，沒有任何 delete 或 truncate。
-- 62/63 合併房源時只是把 property_id 改指到保留的那間。
-- 而且 expenses_property_id_fkey 沒有 cascade —— 就算 migration 刪了房源，
-- 有支出掛著的話會直接報錯中止，不會靜靜連坐刪掉。
--
-- 【也不是畫面篩選】
-- 支出頁的日期、科目、用途全部預設空白，一載入就是全部。
--
-- 所以剩下的可能是「真的有人刪」。第 3 段是關鍵。


-- ═══════════════════════════════════════════════════════
-- 1. 現在到底有幾筆？先確認基準
-- ═══════════════════════════════════════════════════════
select count(*)      as 總筆數,
       min(spent_on) as 最早,
       max(spent_on) as 最晚,
       sum(amount)   as 總金額
from expenses;


-- ═══════════════════════════════════════════════════════
-- 2. 按月份看，哪個月不見了
--
-- 「某個月整段消失」比較像匯入或資料搬遷的問題；
-- 「每個月零星少幾筆」比較像人工刪除。
-- ═══════════════════════════════════════════════════════
select to_char(spent_on, 'YYYY-MM') as 月份,
       count(*)     as 筆數,
       sum(amount)  as 金額,
       count(*) filter (where source_item_id is not null) as 請款連動,
       count(*) filter (where source_item_id is null)     as 直接新增
from expenses
group by 1 order by 1;


-- ═══════════════════════════════════════════════════════
-- 3. 【關鍵】請款單已付款，但支出不見了
--
-- 請款單按「確認支付」時，每個項目會各自產生一筆支出，
-- 靠 expenses.source_item_id 對回 purchase_request_items.id。
-- 所以「已產生支出的請款項目」和「支出」應該一對一。
--
-- 這裡列出來的，就是**曾經產生過、後來被刪掉**的支出。
-- 回傳 0 筆 = 請款那條線沒有東西被刪。
-- ═══════════════════════════════════════════════════════
select pr.req_no                as 請款單號,
       pr.expense_generated_at  as 產生支出時間,
       pri.item_name            as 項目,
       pri.amount               as 金額,
       coalesce(s.name, '(查無)') as 申請人,
       pr.purchased_on          as 付款日
from purchase_request_items pri
join purchase_requests pr on pr.id = pri.request_id
left join staff s on s.auth_uid = pr.requester_id
where pr.expense_generated_at is not null
  and not exists (select 1 from expenses e where e.source_item_id = pri.id)
order by pr.expense_generated_at desc;


-- ═══════════════════════════════════════════════════════
-- 3b. 上面那段的數量統計（先看總數再看明細比較快）
-- ═══════════════════════════════════════════════════════
select count(*)        as 消失的連動支出筆數,
       sum(pri.amount) as 消失的金額
from purchase_request_items pri
join purchase_requests pr on pr.id = pri.request_id
where pr.expense_generated_at is not null
  and not exists (select 1 from expenses e where e.source_item_id = pri.id);


-- ═══════════════════════════════════════════════════════
-- 4. 建立時間的分布
--
-- created_at 是寫進資料庫的時間，spent_on 是花錢的日期，兩者不同。
-- 看 created_at 可以知道「這批資料什麼時候進來的」。
-- ═══════════════════════════════════════════════════════
select to_char(created_at, 'YYYY-MM-DD') as 寫入日,
       count(*) as 筆數
from expenses
group by 1 order by 1 desc limit 30;


-- ═══════════════════════════════════════════════════════
-- 5. 誰有能力刪
--
-- RLS 上 expenses 開放給 manager / accountant / super_admin，
-- 請款連動的那些前端有擋（只有總經理看得到刪除鈕），
-- 但那是**前端的擋**，直接打 API 仍然刪得掉。
-- ═══════════════════════════════════════════════════════
select s.name as 姓名, p.role as 權限, p.active as 啟用中
from profiles p
join staff s on s.auth_uid = p.id
where p.role in ('manager', 'accountant', 'super_admin')
order by p.role, s.name;


-- ═══════════════════════════════════════════════════════
-- 6. 反向檢查：請款單自己被刪過嗎
--
-- source_item_id 的外鍵是 ON DELETE SET NULL，
-- 所以請款單被刪掉時支出不會消失，只會失去來源標記。
-- 有憑證號碼卻沒有來源的，通常就是這種。
-- ═══════════════════════════════════════════════════════
select count(*) as 有憑證但失去來源的支出
from expenses
where request_id is null and source_item_id is null
  and voucher_no is not null;
