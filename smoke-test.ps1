# 安幸上工 — 線上 API 煙霧測試
#
# 用法：
#   .\smoke-test.ps1              # 測正式站
#   .\smoke-test.ps1 -Local       # 測本機 http://localhost:3000（要先 npm run dev）
#
# 為什麼需要這支：
# 2026-08-04 全站 503 了一段時間，而每一個訊號都是綠的 ——
# CI 過、build 過、pm2 顯示 online、log 印著 ✓ Ready。
# 唯一的線索是 pm2 的重啟次數累積到 79，而沒有人在看那個數字。
#
# build 成功不等於服務活著。deploy.ps1 只驗得到前者，這支驗後者。
# 部署完跑一次，30 秒就知道線上是不是真的能用。
#
# CORS 只約束瀏覽器，命令列打 API 不受影響，所以這裡不需要任何特殊處理。

param(
    [switch]$Local
)

Set-Location -Path $PSScriptRoot

$base = if ($Local) { "http://localhost:3000" } else { "https://justwork.estia.com.tw" }

# ── 讀金鑰 ──────────────────────────────────────────
if (-not (Test-Path ".\.env.sync")) {
    Write-Host "  找不到 .env.sync，需要一行 IMPORT_KEY=xxx" -ForegroundColor Red
    exit 1
}
$line = Get-Content .\.env.sync | Select-String '^IMPORT_KEY='
if (-not $line) {
    Write-Host "  .env.sync 裡沒有 IMPORT_KEY" -ForegroundColor Red
    exit 1
}
$key = ($line -split '=', 2)[1].Trim()

Write-Host ""
Write-Host "  測試目標：$base" -ForegroundColor Cyan
Write-Host ""

$pass = 0
$fail = 0

# 打一次並比對狀態碼。
# 401/404 這些會讓 Invoke-WebRequest 丟例外，所以一律包 try ——
# 我們要的是「狀態碼是多少」，不是「有沒有丟例外」。
function Check {
    param($Name, $Path, $Expect, $Headers = @{}, $Method = 'GET')

    $code = 0
    $body = ''
    try {
        $r = Invoke-WebRequest -Uri "$base$Path" -Method $Method -Headers $Headers `
             -UseBasicParsing -TimeoutSec 20
        $code = [int]$r.StatusCode
        $body = $r.Content
    } catch {
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
        } else {
            # 連不上（DNS / 逾時 / 服務整個掛掉）
            Write-Host ("  ✗ {0,-38} 連不上：{1}" -f $Name, $_.Exception.Message) -ForegroundColor Red
            $script:fail++
            return $null
        }
    }

    if ($code -eq $Expect) {
        Write-Host ("  ✓ {0,-38} {1}" -f $Name, $code) -ForegroundColor Green
        $script:pass++
        return $body
    } else {
        Write-Host ("  ✗ {0,-38} 得到 {1}，預期 {2}" -f $Name, $code, $Expect) -ForegroundColor Red
        $script:fail++
        return $null
    }
}

$auth = @{ 'x-import-key' = $key }

# ── 1. 服務活著嗎 ───────────────────────────────────
# 登入頁是靜態的，不碰資料庫。它掛掉表示 Next 整個沒起來。
Check "首頁（未登入導向 /login）" "/login" 200 | Out-Null

# ── 2. 金鑰真的有在擋嗎 ─────────────────────────────
# 這條比看起來重要：如果哪天回 200，代表 IMPORT_KEY 沒設，
# 匯入端點對全世界開放 —— 那是能被灌假訂單的等級。
Check "無金鑰要被擋" "/api/import/reviews/state" 401 | Out-Null

# ── 3. 路由存在且能讀資料庫 ─────────────────────────
$state = Check "評價狀態（帶金鑰）" "/api/import/reviews/state" 200 $auth

if ($state) {
    try {
        $j = $state | ConvertFrom-Json
        Write-Host ""
        Write-Host "      DB 評價數        : $($j.dbCount)"
        Write-Host "      最近 id 筆數     : $($j.recentIds.Count)"
        Write-Host "      上次全量對帳     : $(if ($j.lastFullReconcile) { $j.lastFullReconcile } else { '(從未)' })"
        Write-Host "      上次同步         : $(if ($j.lastSyncAt) { $j.lastSyncAt } else { '(從未)' })"

        if ($j.dbCount -eq 0) {
            Write-Host "      ⚠ dbCount 是 0 —— 路由通了但讀不到資料，檢查 SUPABASE_SERVICE_KEY" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "      ⚠ 回傳不是合法 JSON" -ForegroundColor Yellow
    }
}

# ── 4. 其餘匯入端點存在嗎 ───────────────────────────
# 不帶金鑰打，看的是「有沒有這條路由」：
#   401 = 路由在，被金鑰擋下（正確）
#   404 = 沒部署到
#   503 = 服務掛了
Write-Host ""
foreach ($p in @('reviews', 'translate', 'reconcile', 'airbnb-orders', 'cleaning', 'housekeeping')) {
    Check "路由存在 /api/import/$p" "/api/import/$p" 401 | Out-Null
}

# ── 5. 封存的 seed 端點應該不見了 ───────────────────
# 那四支沒有防重跑機制，呼叫第二次會產生整批重複訂單。
# 收進 archive/ 之後線上不該還找得到 —— 找得到就是沒部署成功。
Write-Host ""
foreach ($p in @('snapshots', 'contracts-seed', 'contracts-general', 'shortterm-seed')) {
    Check "已封存 /api/import/$p 應為 404" "/api/import/$p" 404 | Out-Null
}

# ── 結果 ────────────────────────────────────────────
Write-Host ""
if ($fail -eq 0) {
    Write-Host "  全部通過（$pass 項）" -ForegroundColor Green
    Write-Host ""
    exit 0
} else {
    Write-Host "  $fail 項失敗、$pass 項通過" -ForegroundColor Red
    Write-Host ""
    Write-Host "  常見原因：" -ForegroundColor Yellow
    Write-Host "    503 全站      服務沒起來，SSH 進主機 pm2 list / pm2 logs anxing"
    Write-Host "    404 新路由    還沒部署，先跑 .\deploy.ps1 並等 CI 完成（約 2 分鐘）"
    Write-Host "    401 應為 200  .env.sync 的 IMPORT_KEY 與主機上的 .env.local 不一致"
    Write-Host ""
    exit 1
}
