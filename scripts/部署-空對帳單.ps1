# 安幸上工 — 部署「空對帳單：0 筆只更新日期」
#
# 用法：
#   .\部署-空對帳單.ps1
#   .\部署-空對帳單.ps1 -DryRun     # 只檢查，不部署
#
# ============================================================
# 【為什麼不是又一支 deploy.ps1】
#
# deploy.ps1 已經在做 測試 → build → add → commit → push。
# 在這裡再寫一份，就變成**兩條部署路徑** ——
# 改了一邊忘了另一邊的時候沒有人會發現，而且是部署當下才發現。
#
# 所以這支只做 deploy.ps1 沒做的三件事，然後把方向盤交回去：
#
#   ① 這次會夾帶哪些不相干的檔案（deploy.ps1 的 git add 掃得比你想的寬）
#   ② npx tsc --noEmit（DEPLOY.md 叫你跑，deploy.ps1 沒跑）
#   ③ 先跑對帳單解析那一支測試 —— 兩秒就知道核心對不對，
#      不用等全套 test + build 三分鐘才發現
#
#
# ============================================================
# 【這次改了什麼】
#
# 查詢期間內銀行沒有任何進出時，PDF 上只有一行「總計 0 0」。
# 舊版的 `if (txns.length === 0) 失敗` 把「銀行說沒有交易」跟
# 「我們讀不懂這份 PDF」壓成同一件事，回報「版面可能改了」——
# 而版面沒有改。
#
# 現在：表頭認得 ＋ 銀行印的總計 0／0 ＋ 帳號讀到 → 放行，
# 匯入時**只把對帳日期往前推，餘額從上一份接過來不動**。
#
# 沒有 migration。純程式碼，CI 跑完就生效。

param(
    [switch]$DryRun
)

Set-Location -Path $PSScriptRoot

function Fail($text) {
    Write-Host ""
    Write-Host "  $text" -ForegroundColor Red
    Write-Host ""
    exit 1
}

function Step($n, $text) {
    Write-Host ""
    Write-Host "[$n] $text" -ForegroundColor Cyan
}

$COMMIT_MSG = "對帳單：查詢期間沒有交易時只更新日期，不再當成解析失敗"

# 這次應該動到的檔案。**多出來的會被指名** —— 見下面的說明。
$EXPECTED = @(
    "src/lib/bank-statement.ts",
    "src/lib/bank-statement.test.ts",
    "src/lib/bank-import.test.ts",
    "src/lib/__fixtures__/yuanta-70564-empty.tsv",
    "src/app/(app)/accounts/upload-panel.tsx",
    "src/app/api/bank-statements/import/route.ts"
)

# deploy.ps1 的 `git add` 掃到的範圍（跟它第 4 步保持一致）
$SWEPT = @("src/", "supabase/", "public/", ".github/", "docs/", "archive/")

if (-not (Test-Path ".\package.json")) { Fail "這裡不是專案資料夾，找不到 package.json" }
if (-not (Test-Path ".\deploy.ps1"))   { Fail "找不到 deploy.ps1 —— 這支是掛在它前面的，不能單獨用" }

# ── 1. 這次到底會推什麼上去 ──────────────────────────
#
# deploy.ps1 是 `git add -u` ＋ `git add src supabase public .github docs archive`。
# 意思是:
#
#   · **任何已追蹤檔案的修改「與刪除」都會被帶走** —— 包括根目錄那些筆記
#   · 那六個資料夾底下**未追蹤的新檔案也會被帶走**
#
# 兩者都不會問你。所以在按下去之前先把「不是這次要改的」列出來 ——
# 「順手夾帶」的東西一旦進了 commit，之後要看懂那次改了什麼就很難了。
Step 1 "這次會推什麼"
$lines = @(git -c core.quotepath=false status --porcelain)
if (-not $lines) { Fail "工作區乾淨，沒有東西要部署" }

$mine   = @()
$strays = @()
foreach ($line in $lines) {
    if ($line.Length -lt 4) { continue }
    $code = $line.Substring(0, 2)
    $path = $line.Substring(3).Trim().Trim('"')
    # 改名的 "old -> new" 只看新的那個
    if ($path -match " -> ") { $path = ($path -split " -> ")[-1] }

    if ($EXPECTED -contains $path) { $mine += "$code $path"; continue }

    $untracked = $code.Trim() -eq "??"
    $inSwept   = $false
    foreach ($d in $SWEPT) { if ($path.StartsWith($d)) { $inSwept = $true } }
    # 已追蹤的改動一律會被 git add -u 帶走；未追蹤的只有落在那六個資料夾裡才會
    if ((-not $untracked) -or $inSwept) { $strays += "$code $path" }
}

Write-Host "    這次的修改：" -ForegroundColor Green
$mine | ForEach-Object { Write-Host "      $_" }

$missing = @($EXPECTED | Where-Object { $p = $_; -not ($mine | Where-Object { $_.EndsWith($p) }) })
if ($missing) {
    Write-Host ""
    Write-Host "    這幾個檔案沒有改動 —— 是不是拿錯資料夾了？" -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "      $_" -ForegroundColor Yellow }
    Fail "預期的檔案不齊，已中止。"
}

if ($strays) {
    Write-Host ""
    Write-Host "  ⚠ 下面這些**不是這次要改的，但 deploy.ps1 會一起推上去**：" -ForegroundColor Yellow
    $strays | ForEach-Object { Write-Host "      $_" -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "    狀態 D 是刪除 —— git add -u 連刪除也會一起 commit。" -ForegroundColor DarkGray
    Write-Host "    要留著的話先 git restore <檔案>；要分開推的話先自己 commit 一次。" -ForegroundColor DarkGray
    Write-Host ""
    $ans = (Read-Host "  知道了，一起推沒關係？(Y 繼續 / 其他中止)").Trim()
    if ($ans -notin @("Y", "y", "yes", "是")) { Fail "已中止。處理完那幾個檔案再回來。" }
}

# ── 2. 型別檢查 ──────────────────────────────────────
# DEPLOY.md 寫「合併到 main 前請先在本機驗證 npx tsc --noEmit」，
# 而 deploy.ps1 沒有這一步。這次動到了共用型別（Statement 多一個欄位），
# 漏一個建構點就是線上壞掉 —— tsc 三秒就講得出來。
Step 2 "型別檢查（deploy.ps1 沒有這一步）"
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) { Fail "tsc 有錯，已中止。" }
Write-Host "    型別乾淨" -ForegroundColor Green

# ── 3. 先跑對帳單那一支 ──────────────────────────────
# 全套測試 ＋ build 要三分鐘。核心壞了的話，兩秒就該知道。
Step 3 "對帳單解析測試（先跑這一支，快）"
node --experimental-strip-types --test src/lib/bank-statement.test.ts
if ($LASTEXITCODE -ne 0) { Fail "對帳單解析測試沒過，已中止。這正是這次要改的東西。" }
Write-Host "    解析器 OK" -ForegroundColor Green

if ($DryRun) {
    Write-Host ""
    Write-Host "  -DryRun：檢查都過了，沒有部署。" -ForegroundColor Green
    Write-Host "  要真的推的話，不加 -DryRun 再跑一次。"
    Write-Host ""
    exit 0
}

# ── 4. 交給 deploy.ps1 ───────────────────────────────
# 測試、build、add、commit、push 全部在它裡面。這支不重寫。
Step 4 "交給 deploy.ps1"
Write-Host "    commit 訊息：$COMMIT_MSG" -ForegroundColor DarkGray
$global:LASTEXITCODE = 0
& (Join-Path $PSScriptRoot "deploy.ps1") $COMMIT_MSG
if ($LASTEXITCODE -ne 0) { Fail "deploy.ps1 中止了 —— 上面有原因。" }

# ── 5. 收尾 ──────────────────────────────────────────
Write-Host ""
Write-Host "  這次沒有 migration，SQL Editor 不用開。" -ForegroundColor Green
Write-Host ""
Write-Host "  CI 跑完（約 2 分鐘）之後建議做兩件事：" -ForegroundColor Cyan
Write-Host "    1. .\smoke-test.ps1          # build 成功不等於服務活著"
Write-Host "    2. 拿那份 09/03~09/04 的 PDF 再上傳一次"
Write-Host "       預期看到：「這段期間沒有交易 —— 匯入只會把對帳日期更新到 2026-09-04，餘額不變。」"
Write-Host "       匯入後帳戶卡片的日期往前，金額不變。"
Write-Host ""
