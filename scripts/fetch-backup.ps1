# ══════════════════════════════════════════════════════════════
# 把 GitHub 最新那份備份抓回自己的電腦
# ══════════════════════════════════════════════════════════════
#
# 2026-08-31 使用者：「GitHub 每天台灣 04:00，然後打開電腦時載下來嗎？」
#
# 用法（平常不用手動跑，登入時會自動執行）:
#     .\scripts\fetch-backup.ps1
#
# 第一次要做的設定在下面的錯誤訊息裡，腳本會自己教你。
#
# ══════════════════════════════════════════════════════════════
# 【跟 backup-db.ps1 的分工】
#
#   backup-db.ps1   自己連資料庫 dump 一份　→「我現在就要一份」
#   fetch-backup.ps1 下載 GitHub 已經跑好的　→「每天自動有一份在我電腦上」
#
# ★★ 兩支都留（使用者選的）。GitHub 那邊掛掉的日子還有第一支可以走 ——
#   而備份系統最不該有的就是單一路徑。
#
# ★ 平常用這一支就好:少跑一次全量 dump（資料庫不用被拉一次）、
#   而且本機那份跟雲端那份**保證是同一批 bytes**。
#   各自 dump 的話兩份差幾分鐘，出事時要比對「哪一份比較新」。
#
# ══════════════════════════════════════════════════════════════
# 【為什麼用 gh CLI 而不是自己打 API】
#
# 下載 artifact 要 `actions:read` 的權限。自己打 API 的話得先建一個
# personal access token，然後**把它存在某個地方** ——
# 而那個地方遲早會是一個純文字檔。
#
# `gh` 用系統的認證管道（Windows 是憑證管理員），token 不落地。
# ══════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'

# ★ 跟 backup-db.ps1 同一個資料夾 —— 兩支的產物放在一起，
#   找備份時只要看一個地方。純英數字（見 backup-db.ps1 開頭的說明）。
$BackupDir = Join-Path $env:USERPROFILE 'anxing-db-backup'
$KeepDays  = 30
$Repo      = 'twlo79/anxing-web'
$Workflow  = 'backup.yml'

# ★ 登入時自動跑的話，畫面是背景視窗，訊息要寫進檔案才看得到。
$LogFile = Join-Path $BackupDir 'fetch.log'

function Say($msg, $color = 'Gray') {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Write-Host $msg -ForegroundColor $color
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
}

# ══════════════════════════════════════════════════════════════
# ★★★ 任何沒接住的錯誤都要寫進 fetch.log（2026-10-20）
#   8/31～10/19 這支每次都停在「找最新一次成功的備份⋯」之後，log 裡什麼都沒有 ——
#   $ErrorActionPreference = 'Stop' 下，gh 往 stderr 印的東西（例如「有新版 gh」）
#   被 2>&1 併進來之後讓 ConvertFrom-Json 爆掉，而那個錯誤只出現在一個隱藏的視窗裡。
#   結果是本機 49 天沒有新備份，而沒有人知道。
# ══════════════════════════════════════════════════════════════
trap { Say "✗ 出錯停下來了：$($_.Exception.Message)" 'Red'; exit 1 }

# 跑 gh：stdout 與 stderr 分開收，stderr 不會變成會讓整支停下來的錯誤
function Gh {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $errFile = [System.IO.Path]::GetTempFileName()
    # ★★ gh 輸出是 UTF-8，Windows PowerShell 5.1 預設用 Big5 解 —— 中文標題會變亂碼、
    #   把 JSON 的引號吃掉，ConvertFrom-Json 報「未結束的字串」（2026-10-20 踩到）
    $prevEnc = [Console]::OutputEncoding
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    try {
        $out = & $ghPath @args 2>$errFile
        $script:GhCode = $LASTEXITCODE
        $script:GhErr = (Get-Content $errFile -Raw -ErrorAction SilentlyContinue)
        return ($out -join "`n")
    } finally {
        Remove-Item $errFile -Force -ErrorAction SilentlyContinue
        [Console]::OutputEncoding = $prevEnc
        $ErrorActionPreference = $prev
    }
}

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

Write-Host ''
Write-Host '═══ 下載 GitHub 上最新的備份 ═══' -ForegroundColor Cyan
Write-Host ''

# ══════════════════════════════════════════════════════════════
# 一、gh 在不在、登入了沒
# ══════════════════════════════════════════════════════════════
# ★★ 只拿第一個、而且只要真的程式檔（2026-10-20 踩到）：電腦上找得到不只一個 gh 的時候，
#   Get-Command 回的是一串，路徑變成好幾個字串的陣列，「& 路徑」就報「運算式產生的物件無效」。
$gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $gh) {
    $guess = "$env:ProgramFiles\GitHub CLI\gh.exe"
    if (Test-Path $guess) { $gh = $guess }
}
if (-not $gh) {
    Say '找不到 gh（GitHub CLI）。' 'Red'
    Write-Host ''
    Write-Host '裝一次就好：' -ForegroundColor Yellow
    Write-Host '    winget install --id GitHub.cli'
    Write-Host ''
    Write-Host '裝完重開 PowerShell，然後登入（也只要一次）：'
    Write-Host '    gh auth login'
    Write-Host '  選 GitHub.com → HTTPS → 用瀏覽器登入'
    Write-Host ''
    exit 1
}
$ghPath = if ($gh -is [string]) { $gh } else { $gh.Path }
if (-not $ghPath) { Say '找不到 gh.exe 的路徑。' 'Red'; exit 1 }

# ★ 先確認登入狀態。沒登入的話下面那句 `gh run list` 會回一段
#   看起來像網路錯誤的訊息 —— 而真正的原因是沒登入。
$null = Gh auth status
if ($script:GhCode -ne 0) {
    Say 'gh 還沒登入。' 'Red'
    Write-Host '    gh auth login' -ForegroundColor Yellow
    Write-Host '  選 GitHub.com → HTTPS → 用瀏覽器登入（只要做一次）'
    exit 1
}

# ══════════════════════════════════════════════════════════════
# 二、找最新一次**成功**的執行
# ══════════════════════════════════════════════════════════════
#
# ★★ `--status success` 不能省。失敗那次也有 run id，
#   但它沒有 artifact（我們的 workflow 驗證不過就 exit 1，不會上傳）——
#   抓下去只會得到一句「no artifacts found」，
#   而那看起來像「備份不見了」，其實是「那天沒備成功」。
Say '找最新一次成功的備份⋯'
$json = Gh run list --repo $Repo --workflow $Workflow `
    --status success --limit 1 --json 'databaseId,createdAt'

# ★★ 上面那串欄位一定要加引號（2026-10-20 踩到）：PowerShell 會把沒加引號的 a,b,c 當成陣列拆開傳，
#   gh 收到的是三個參數，回「unknown command "createdAt"」—— 8/31 起本機一直沒有新備份就是這個。
if ($script:GhCode -ne 0) { Say "gh run list 失敗：$($script:GhErr)" 'Red'; exit 1 }

$runs = $json | ConvertFrom-Json
if (-not $runs -or $runs.Count -eq 0) {
    Say '⚠ GitHub 上還沒有任何一次成功的備份。' 'Yellow'
    Write-Host '  去 Actions → 每日資料庫備份 → Run workflow 跑一次。'
    exit 1
}

$run  = $runs[0]
$when = ([datetime]$run.createdAt).ToLocalTime()
$age  = (Get-Date) - $when
Say ("最新一份：$($when.ToString('yyyy-MM-dd HH:mm'))（$([int]$age.TotalHours) 小時前）")

# ★★ 太舊要**大聲說**。排程壞掉的症狀是「每天都下載成功」——
#   下載的是同一份三個禮拜前的東西，而畫面上每天都是綠的。
if ($age.TotalDays -gt 2) {
    Say "⚠ 這份備份已經 $([int]$age.TotalDays) 天了 —— 每天 04:00 的排程可能沒在跑，去 Actions 看一下" 'Yellow'
}

# ══════════════════════════════════════════════════════════════
# 三、已經有了就不重抓
# ══════════════════════════════════════════════════════════════
#
# ★ 檔名帶 run id。同一天開關機五次不會下載五份一樣的東西，
#   而且看檔名就知道對應 GitHub 上哪一次執行。
$stamp   = $when.ToString('yyyy-MM-dd')
$destDir = Join-Path $BackupDir "gh_${stamp}_run$($run.databaseId)"

if (Test-Path $destDir) {
    Say "這一份已經下載過了，跳過。" 'DarkGray'
    exit 0
}

# ══════════════════════════════════════════════════════════════
# 四、下載
# ══════════════════════════════════════════════════════════════
Say '下載中⋯'
$tmp = Join-Path $env:TEMP "anxing-bk-$($run.databaseId)"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# ★ 先下載到暫存再搬過去。直接下載到目的地的話，
#   下載到一半斷線會留下一個**看起來像備份的半成品** ——
#   而下次執行看到那個資料夾存在就會跳過。
$null = Gh run download $run.databaseId --repo $Repo --dir $tmp
if ($script:GhCode -ne 0) {
    Say "下載失敗（代碼 $($script:GhCode)）：$($script:GhErr)" 'Red'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# ══════════════════════════════════════════════════════════════
# 五、★★★ 驗證下載到的是真東西
# ══════════════════════════════════════════════════════════════
#
# workflow 那邊已經驗過一次了，但**這裡要再驗一次** ——
# 中間隔了一次網路傳輸與一次解壓縮，任何一段壞掉都會留下
# 一個大小正常、內容是垃圾的檔案。
#
# 「上游驗過了所以這裡不用驗」是備份系統最常見的漏洞:
# 每一段都相信上一段，於是沒有人真的看過最後那個檔案。
$gz = Get-ChildItem $tmp -Recurse -Filter 'anxing.sql.gz' | Select-Object -First 1
if (-not $gz) {
    Say '⚠ 下載到的東西裡面沒有 anxing.sql.gz' 'Red'
    Get-ChildItem $tmp -Recurse | ForEach-Object { Say "    $($_.Name)" 'DarkGray' }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

$sizeMB = [math]::Round($gz.Length / 1MB, 2)
# ★ gzip 過的 SQL 大約剩十分之一。11.9 MB 的原始檔壓完約 1 MB ——
#   低於 300 KB 一定是壞的。
if ($gz.Length -lt 300KB) {
    Say "⚠ anxing.sql.gz 只有 $sizeMB MB —— 這不像是真的備份" 'Red'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# 搬到正式位置（原子性:先確認都對了再搬）
# 檔案備份（憑證圖片等，2026-10-20 起）—— 沒有的話提醒，不擋（資料庫那份才是主體）
$tar = Get-ChildItem $tmp -Recurse -Filter 'storage.tar' | Select-Object -First 1
if ($tar) {
    Say ("  含檔案備份（圖片等）$([math]::Round($tar.Length / 1MB, 1)) MB") 'DarkGray'
    # ══════════════════════════════════════════════════════════════
    # ★★ 檔案併進同一個資料夾（2026-10-21）
    #   GitHub 每天只備「最近 3 天新增／改過的檔案」（整份 400 多 MB 太大），
    #   所以電腦這邊把每天那一小包**解到同一個資料夾**累積起來，
    #   再拿那一包裡的完整清單（manifest.csv）一個一個對有沒有缺。
    #   缺的話（例如電腦超過一週沒開），去 Actions 手動跑一次「整份」。
    # ══════════════════════════════════════════════════════════════
    $mirror = Join-Path $BackupDir 'files'
    New-Item -ItemType Directory -Force -Path $mirror | Out-Null
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & tar -xf $tar.FullName -C $mirror 2>$null
    $tarCode = $LASTEXITCODE; $ErrorActionPreference = $prevEap
    if ($tarCode -ne 0) { Say "  ⚠ 檔案解開失敗（代碼 $tarCode）" 'Yellow' }
    else {
        $man = Join-Path $mirror 'manifest.csv'
        if (Test-Path $man) {
            $rows = @(Import-Csv -Path $man -Header 'bucket','name','size','recent' -Encoding UTF8)
            $miss = @($rows | Where-Object { -not (Test-Path -LiteralPath (Join-Path (Join-Path $mirror 'objects') (Join-Path $_.bucket ($_.name -replace '/', '\')))) })
            if ($miss.Count -eq 0) { Say "  ✓ 檔案齊全：$($rows.Count) 個都在 $mirror" 'Green' }
            else {
                Say "  ⚠ 檔案缺 $($miss.Count) 個（共 $($rows.Count) 個）—— 去 Actions → 每日資料庫備份 → Run workflow（勾「整份」）再抓一次" 'Yellow'
                $miss | Select-Object -First 5 | ForEach-Object { Say "      缺：$($_.bucket)/$($_.name)" 'DarkGray' }
            }
        }
    }
}
else { Say '  ⚠ 這一份沒有檔案備份（storage.tar）—— 圖片沒備到，去 Actions 看「檔案」那一步' 'Yellow' }
Move-Item $tmp $destDir
Say "✓ 下載完成　$sizeMB MB　→　$destDir" 'Green'

# ══════════════════════════════════════════════════════════════
# 六、清掉過期的
# ══════════════════════════════════════════════════════════════
#
# ★ 只刪這支自己產生的（`gh_*`）與 backup-db.ps1 產生的（`anxing_*.sql`）。
#   刪整個資料夾裡的舊東西的話，別人放進來的檔案會一起被刪。
$old = @(Get-ChildItem $BackupDir -Directory -Filter 'gh_*' |
         Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) })
if ($old.Count -gt 0) {
    $old | Remove-Item -Recurse -Force
    Say "已清掉 $($old.Count) 份超過 $KeepDays 天的舊備份" 'DarkGray'
}

$n = @(Get-ChildItem $BackupDir -Directory -Filter 'gh_*').Count
$m = @(Get-ChildItem $BackupDir -Filter 'anxing_*.sql').Count
Say "資料夾裡現在有 $n 份雲端備份、$m 份本機 dump"
Write-Host ''
