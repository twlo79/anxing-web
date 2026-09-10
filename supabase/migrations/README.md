# supabase/migrations

這個資料夾的每一支 `.sql` 都是**跑過一次就算數**的資料庫異動。
這份 README 講三件事：**怎麼跑**、**跑過哪些**、**踩過哪些坑**。

---

## 一、怎麼跑一支 migration

貼進 Supabase 的 SQL Editor，整份一起執行。

### ★★★ 看不到自檢的表格 ＝ 失敗了，不是「沒有輸出」

每一支的結構都是：

```sql
begin;
  …真正的異動…
commit;

-- 自檢（在 commit 之後）
select … ;
```

SQL Editor 把整份腳本包在**一個交易**裡。中間任何一句錯，`begin` 到 `commit`
之間**全部回滾**，而畫面上不一定看得到紅字 —— 於是看起來像「跑完了但沒輸出」。

**自檢在 `commit` 後面。成功就一定看得到那張表。**
（2026-09-10 這件事被誤讀兩次，一次是我、一次是使用者。）

### 自檢的三種判定

| | 意思 |
|---|---|
| ✅ | 這一條過了 |
| ❌ | **停下來**，不要跑下一支 |
| ℹ | 只是印給人看，不判對錯（例如「舊資料本來就沒有，0 是正常的」） |

### ★★ 跑之前先問「這支跑過了沒」

不要憑印象、不要憑對話紀錄。事實在 `schema_migrations`：

```sql
select name, run_at
  from public.schema_migrations
 where name >= '230'
 order by name;
```

2026-09-05 我連續三次說「213／215／216 未跑」，而三支**都在兩天前跑完了** ——
代價是兩輪查詢在追一個不存在的 bug。

---

## 二、寫一支 migration 的規矩

### 1. 自檢一定要有，而且要**判定**自己的母體

```sql
select 3, '母體（需求項目總數）',
       (select count(*)::text from public.purchase_demand_items),
       case when (select count(*) from public.purchase_demand_items) = 0
            then '⚠ 母體是 0 —— 上面那幾條不算數' else '✅' end
```

migration_210 的六列自檢全部 ✅，而第一列「房務支出總筆數」是 **0** ——
一筆都沒產生過，所以「還有幾筆沒補」「有沒有錯置」通通自動成立。
**紅字會讓人停下來，六個綠勾讓人以為做完了。**

### 2. 自檢的**基準值不可以來自另一個問法**

migration_240 第 ⑤ 條寫「筆數應該是 3」，而那個 3 是從一段
**加了日期篩選**的診斷查詢數出來的 —— 它濾掉了匯費。
於是那一條必定為紅，而實際上一筆重複都沒有產生。

**兩邊要問同一件事。** 240 第 ③ 條也是同一個病：
左邊算「代墊金額」、右邊算「這張單的**全部**支出（含記在安幸的匯費）」，
必定差一個手續費。

### 3. 自檢要跑第二次、第十次都一樣

migration_213 寫「最近十分鐘有沒有 expenses 的刪除」——
那支是冪等的，第二次跑什麼都不做，於是那一格變 0，看起來像稽核壞了。
而且「十分鐘內」**會隨時間過期**。一個會自己變紅的檢查等於沒有檢查。

### 4. 字串比對一律 `ilike`，不要 `like`

Postgres 印的是 `IS NOT NULL`，而 `like '%is not null%'` 是大小寫敏感的。
migration_233 的第 ① 條因此誤報 ❌。

### 5. 掃約束／函式名用**詞邊界**，不要 `%關鍵字%`

```sql
where pg_get_constraintdef(oid) ~ '\mqty\M'     -- ✅
where pg_get_constraintdef(oid) like '%qty%'    -- ❌ 會掃到 quantity_note
```

誤刪一條別的約束**不會報錯**，只會讓一個守門的規則安靜消失。

### 6. 呼叫既有函式時**照抄上一支**，不要憑印象

`record_migration` 是 `(p_name text)` 一個參數、名字不帶 `migration_` 前綴。
每一支都用同一段包起來：

```sql
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('243_memo_only_depth');
  end if;
end $do$;
```

（`schema_migrations` 的欄位是 `name` 不是 `version`。）

### 7. `pg_get_functiondef()` 一定要加 `prokind`

```sql
from pg_proc p where p.prokind in ('f','p')
```

不加的話掃到聚合函式就 `ERROR: 42809: "array_agg" is an aggregate function`，
**整支回滾 —— 而爆掉的是自檢**。

### 8. `schema-baseline.sql` **不等於線上**

那份是舊的 dump。policy 比它多、函式比它新、migration_166 之類的東西根本不在裡面。
照它抄表名或約束名 → 漏掉的東西**不會叫**。
要看線上長什麼樣就去查 `pg_constraint` / `pg_proc`，不要查檔案。

### 9. 改欄位型別之前，先列出**掛在那一欄上的東西**

migration_239 為此連死兩次：

| | 補了什麼 | 死在哪 |
|---|---|---|
| 一版 | 什麼都沒查 | `42804` DEFAULT 轉不過去 |
| 二版 | drop default ＋ 查 view | `42883` **check 約束** `qty > 0` |

錯誤訊息**都不說是誰**：42883 只講「text > numeric」，不講那個 `>` 從哪來。
所以「看訊息再補」是走不完的路。一次列完：
**① view / rule ② DEFAULT ③ check 約束**（還有 generated column）。

view 擋住就**停下來報名字**，不要自己 drop 別人的東西；
約束 drop 掉要把定義寫進 COMMENT 留底 —— 一條看門的規則安靜消失，比留著更糟。

---

## 三、230 ~ 243 這一批

> **不要從這張表判斷「跑過了沒」** —— 事實在 `schema_migrations`，用上面那段查詢。

| # | 做了什麼 | 為什麼 |
|---|---|---|
| 230 | 認列表帶上 `item_name` | `gen_recognitions()` 漏帶，上線至今營收表的「項目」一直是空的 |
| 231 | 付款帳號多兩本現金 | `(正隆)現金`、`(安幸)現金`；`payment_accounts_method_check` 一起放寬 |
| 232 | `gen_demand_no()` 改 SECURITY DEFINER | 它看到的是 **RLS 縮過的母體** → 兩個人同時開單會撞號 |
| 233 | 採購需求大家看得到、只能改自己的 | 原本看不到別人的單 |
| 234 | 停用假的「安幸辦公室」物業 | **後來被 235 推翻** —— 見下面 |
| 235 | `orders.purpose_type`，辦公室不再是假物業 | 234 用「停用」來藏它，而它每個月都在收房務清潔的錢。**標籤說謊比資料錯更難查** |
| 236 | `advance_payments.for_book` ＋ 類別「代墊」 | 安幸代墊其他事業體的欄位 |
| 237 | 請款產生支出時帶 `book`；新增代墊分支 | `gen_expenses_from_pr()` 列了 17 欄**沒有 `book`** → 一筆已經記錯帳 |
| 238 | 好事多 → 好市多 | `platform` 沒有 check，舊值不會報錯，只會讓下拉**顯示空白** |
| 239 | 採購需求：數量獨立成一欄（text） | 一個框裝規格＋數量，會計不知道要買幾瓶 —— 而那一格**是填了的** |
| 240 | 補建代墊的暫付紀錄 | 236/237 之前的三筆：愛皮有費用、安幸**沒有應收** |
| 241 | 代墊只掛同一本帳的支出 | **修 240 的錯** —— 見下面 |
| 242 | `pr_planned_chk` 補上現金／臨櫃 | 前端 `needsPayout()` 放寬了兩次，資料庫那條沒跟 |
| 243 | 摘要守衛不要誤傷餘額重算 | 匯入對帳單只做 INSERT，卻撞到一個 UPDATE 的守衛 |

### ⚠ 228 有兩支

`migration_228_deferral_rpc.sql` 與 `migration_228_hk_double_entry.sql` 撞號。
兩支都跑過，功能不相干，但**編號不再是唯一的** —— 排序與「跑到第幾支」的判斷
從此要看檔名全名，不能只看數字。

---

## 四、這一批踩過的坑（依形狀分類）

### ★★★ A. 同一條規則寫在兩個地方，只改了一邊

**這一批出現三次，全部都是「畫面讓你做、存檔丟一句看不懂的例外」。**

| 規則 | 前端那一半 | 資料庫那一半 | 症狀 |
|---|---|---|---|
| 哪些付款方式可以有我方帳號 | `purchase-pay.ts` 的 `needsPayout()` | `pr_planned_chk` | 選了 `(安幸)現金` → `violates check constraint` |
| 暫付有哪些類別 | `advance.ts` 的 `CATEGORIES` | `ap_category_chk` | 下拉**顯示空白**，隨手一選就把代墊改成押金 —— **存檔成功** |
| 誰可以改銀行流水 | — | `bank_txn_memo_only` ／ `trg_bank_txn_balance` | 一支懂得閃自己人、一支不懂 |

**動手前的檢查：放寬任何一條規則之前，先 grep 那條規則的另一半在哪裡。**
資料庫端至少要看 `pg_constraint`、`pg_proc`、`pg_trigger` 三個地方。

第三個最值得看一眼：`trg_bank_txn_balance()` 自己第一行就寫著
`if pg_trigger_depth() > 1 then return null`，它知道重算會再觸發自己 ——
**只是沒有人回頭替另一支守衛也想一次**。

### ★★★ B. 加了新的寫入方式，卻沒更新讀取端

一個靜默的讀 ＋ 一個靜默的寫 ＝ **一個不存在的功能**。這一批第五、六次：

| 欄位／功能 | 寫進去了 | 誰沒跟上 | 多久才發現 |
|---|---|---|---|
| `hk_day.rooms_override` | 前端寫 | 那一欄**線上根本不存在** | 三個月 |
| 逐項憑證 `request_item_id` | 請款頁 | **支出頁沒借看** | 一個月，而且第一直覺是「資料被刪了」 |
| `expenses.book` | migration_237 之前沒帶 | — | 一筆已經記錯帳 |
| `purchase_demand_items.buy_link` | 表單有框、列表有顯示 | **中間的 insert 少一行** | 從上線到現在都是空的 |
| `advance_payments.category = '代墊'` | migration_236 | 前端 `CATEGORIES` | 下拉變空白 |

**加一欄的時候，三個地方都要跟著加：**
① 寫入（insert/update）② 抄欄位的清單（如 `SPLIT_INHERITED`）③ 讀取的 `select`。
少任何一個都**不會報錯**，只會安靜地變成空的。

`src/lib/demand.ts` 的 `newItemRow()` 與 `src/lib/receipt-parents.ts`
就是為了讓這件事**測得到**而存在的 —— 測試會失敗並告訴你要改哪裡。

### ★★ C. 用「這一筆的 id」接，而不是用「該接的條件」接

migration_240 第 ③ 步：

```sql
where e.request_id = r.id            -- ❌ 一張單的支出不只一種
where e.request_id = r.id
  and coalesce(e.book,'anxing') = coalesce(a.for_book,'anxing')   -- ✅
```

一張請款單同時產生**愛皮的項目支出**與**安幸的匯費**。
少了帳本條件，愛皮被算成欠了一筆它沒欠的 $15 手續費 ——
**錢沒有記錯，錯的是「誰欠誰」**，而那種錯不會讓任何數字變紅。

★ 加上那個條件同時讓 240 變成**重跑安全**：沒有它的話，
240 跑第二次會把 241 拆掉的匯費重新掛回去。

### ★★ D. 標籤說謊

migration_234 用「停用」把重複的「安幸辦公室」藏起來。
但那個物業**每個月都在收房務清潔的錢** ——
一個收得到錢的物業標成停用，日後任何人看到都會下錯結論。

正確的做法是 235：**改資料模型**（`orders.purpose_type`），
然後把那個假物業真的刪掉。

同一類的還有：
- 「未分類」印成灰字 → 它是**待辦**不是一種分類，要用琥珀色（其他收支帳）
- 「尚未上傳」用在憑證在別層的情況 → 「真的沒傳」跟「傳了但在另一層」給同一個答案

### ★ E. 憑對話紀錄判斷狀態

- 「這支 migration 跑了沒」→ 查 `schema_migrations`
- 「這批 code 推了沒」→ 跑 `git status --short` 與 `git log --oneline -5`

2026-09-10 我說「這批你還沒推」，而使用者早就推了（commit `3138974`）。
**兩次都是同一個病：說之前沒有去看。**

---

## 五、跑錯了怎麼辦

| 情況 | 做法 |
|---|---|
| 整支回滾（看不到自檢） | 把紅字原文貼出來，不要自己判斷 |
| 資料改壞了 | 寫**下一支** migration 修，不要改已經跑過的那支的內容 —— 除非是為了讓它「重跑安全」（240 就是這樣） |
| 不確定現在的狀態 | 先查，再動。`pg_constraint` / `pg_proc` / `pg_trigger` / `schema_migrations` |

**唯一的例外**：已經跑過的 migration 如果**重跑會造成傷害**，
那要回頭把檔案修好（加冪等條件），並在檔頭寫清楚為什麼。
240 的第 ③ 步就是這個例外。
