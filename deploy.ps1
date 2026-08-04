# 安幸上工 — 一鍵部署
#
# 用法：
#   .\deploy.ps1 "commit 訊息"
#   .\deploy.ps1              # 不給訊息會互動詢問
#
# 做的事：測試 → build → 加檔 → commit → push → 印出 Actions 連結
#
# 為什麼要有這支：build 失敗時一定要中止。
# CI 在 Vultr 上是 git reset --hard → npm install → npm run build → pm2 restart，
# build 掛掉的話程式碼已經被拉到最新、但服務還跑舊版，會停在不一致的狀態。
# 本機先 build 過再推，就不會發生。

param(
    [Parameter(Position = 0)]
    [string]$Message
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

# ── 0. 確認在正確的 repo ──────────────────────────────
if (-not (Test-Path ".\package.json")) { Fail "這裡不是專案資料夾，找不到 package.json" }

# ── 1. 有沒有東西要推 ────────────────────────────────
Step 1 "檢查變更"
$changes = git status --porcelain
if (-not $changes) { Fail "沒有任何變更，不需要部署" }
git status --short
Write-Host ""

# ── 2. 測試 ─────────────────────────────────────────
# 排在 build 之前：跑幾秒就有結果，沒必要等三分鐘的 build 才發現邏輯錯了。
# 這些測試守的是「數字會不會悄悄變小」——不會讓程式當掉的那種錯。
Step 2 "單元測試"
npm test --silent
if ($LASTEXITCODE -ne 0) { Fail "測試失敗，已中止。先看是規則真的變了，還是解析器壞了。" }
Write-Host "    測試通過" -ForegroundColor Green

# ── 3. Build ────────────────────────────────────────
Step 3 "本機 build（失敗就不會往下走）"
npm run build
if ($LASTEXITCODE -ne 0) { Fail "Build 失敗，已中止。修好再跑一次。" }
Write-Host "    Build 通過" -ForegroundColor Green

# ── 4. 加檔 ─────────────────────────────────────────
# 只加程式與設定，不碰根目錄的個人筆記（DESIGN-*.md、TODO-*.md 之類）。
# 想連那些一起推，自己下 git add -A 再跑這支。
Step 4 "加入變更"
git add -u                                    # 已追蹤檔案的修改與刪除
foreach ($p in @("src", "supabase", "public", ".github", "docs", "archive")) {
    if (Test-Path $p) { git add $p }
}
# 根目錄要進版控的檔案逐一列出。
# 這支腳本自己曾經不在清單裡 —— 於是它從來沒被 commit 過:
# 改了它、推了程式,腳本本身留在本機,換台機器就沒了,
# 而且 git status 一直顯示 ?? 也沒人覺得奇怪。
foreach ($f in @("deploy.ps1", "smoke-test.ps1", ".gitattributes", ".gitignore", "README.md",
                 "package.json", "package-lock.json", "tsconfig.json",
                 "next.config.mjs", "postcss.config.mjs", "tailwind.config.ts")) {
    if (Test-Path $f) { git add $f }
}

$staged = git diff --cached --name-only
if (-not $staged) { Fail "沒有檔案被加入。若只改了根目錄的筆記，請自行 git add。" }
Write-Host "    這些檔案會被推上去：" -ForegroundColor Green
$staged | ForEach-Object { Write-Host "      $_" }

# ── 4b. 這次帶了哪些 migration ────────────────────────
# migration 是手動貼進 Supabase SQL Editor 跑的，CI 不會碰它。
# 程式推上去了、SQL 沒跑，症狀是線上噴「column does not exist」——
# 而且是等有人點到那個頁面才發現。所以這裡把清單印出來擋一下。
$newMigrations = $staged | Where-Object { $_ -like "supabase/migrations/*.sql" }
if ($newMigrations) {
    Write-Host ""
    Write-Host "  這次帶了 $($newMigrations.Count) 支 migration，CI 不會執行：" -ForegroundColor Yellow
    $newMigrations | ForEach-Object { Write-Host "      $(Split-Path $_ -Leaf)" -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "  依編號順序貼進 Supabase SQL Editor 執行。每支結尾會回報有沒有記錄成功。" -ForegroundColor Yellow
    Write-Host "  想確認線上跑到哪：select * from schema_migrations order by name;" -ForegroundColor DarkGray
    Write-Host ""
    $ans = Read-Host "  已經知道要跑這幾支了嗎？(Y 繼續 / 其他中止)"
    if ($ans -ne "Y" -and $ans -ne "y") { Fail "已中止。跑完 migration 再回來，或直接按 Y 先推程式。" }
}

# ── 5. Commit 訊息 ──────────────────────────────────
if (-not $Message) {
    Write-Host ""
    $Message = Read-Host "commit 訊息"
}
if (-not $Message) { Fail "沒有 commit 訊息，已中止" }

# ── 6. Commit + Push ───────────────────────────────
Step 5 "Commit"
git commit -m $Message
if ($LASTEXITCODE -ne 0) { Fail "Commit 失敗" }

Step 6 "Push"
git push
if ($LASTEXITCODE -ne 0) { Fail "Push 失敗" }

# ── 完成 ────────────────────────────────────────────
$sha = (git rev-parse --short HEAD)
Write-Host ""
Write-Host "  已推送 $sha" -ForegroundColor Green
Write-Host "  CI 約需 2 分鐘：https://github.com/twlo79/anxing-web/actions"
Write-Host "  網站：https://justwork.estia.com.tw"
Write-Host ""
if ($newMigrations) {
    Write-Host "  還沒跑的 migration：" -ForegroundColor Yellow
    $newMigrations | ForEach-Object { Write-Host "      $(Split-Path $_ -Leaf)" -ForegroundColor Yellow }
    Write-Host "  https://supabase.com/dashboard/project/_/sql" -ForegroundColor DarkGray
}
Write-Host ""
