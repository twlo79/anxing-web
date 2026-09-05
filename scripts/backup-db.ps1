# ══════════════════════════════════════════════════════════════
# 本機備份 —— 把資料庫抓一份到自己的電腦
# ══════════════════════════════════════════════════════════════
#
# 2026-08-31 使用者：「可以備份資料庫 到 github 或是我地端」
#
# 用法（PowerShell）:
#     cd C:\Users\ASUS\Desktop\anxing-web
#     .\scripts\backup-db.ps1
#
# 第一次跑之前要做兩件事,腳本會自己檢查並告訴你怎麼做。
#
# ══════════════════════════════════════════════════════════════
# 【★★★ 這一支跟 GitHub 那一支不一樣，是刻意的】
#
#   .github/workflows/backup.yml  用 Supabase CLI（要 Docker）
#   這一支                        用 pg_dump（不用 Docker）
#
#   為什麼不統一:Supabase CLI 的 `db dump` 是**開一個 Docker 容器**
#   在裡面跑 pg_dump。在 GitHub 的機器上 Docker 是現成的,不花成本;
#   在你的電腦上那代表要裝 Docker Desktop（幾 GB、開機常駐）——
#   為了一支備份腳本裝那個東西不划算。
#
#   ★★ 代價要說清楚:這一支**只備份 public 與 supabase_migrations**,
#     不含 auth（登入帳號）與 storage（上傳的檔案）。
#
#     也就是說它救得回:訂單、支出、流水、契約、客戶、評價、班表、
#                       請款、押金、標案 —— 你手上所有的營運資料。
#     它救不回:員工的登入帳號（要重新邀請）、上傳的收據圖檔。
#
#   ★ GitHub 那一支是完整的。這一支是「快、隨時可跑、放在自己手上」的那一份。
#     兩份的用途不同,不是二選一。
#
# ══════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'

# ── 備份放哪 ────────────────────────────────────
#
# ★★ **不要放在專案資料夾裡。**
#   放在 C:\Users\ASUS\Desktop\anxing-web 底下的話:
#     1. 有一天會不小心 commit 進 git（那等於把資料庫公開）
#     2. 而且備份跟被備份的東西在同一顆硬碟上 —— 硬碟壞了兩邊一起沒
#
# ★★★ 資料夾名稱**只能用英數字**（2026-08-31 踩過）。
#
#   原本叫「安幸資料庫備份」，結果 pg_dump 回：
#       could not open output file "...\安幸資料庫備份\anxing_xxx.sql":
#       No such file or directory
#
#   而那個資料夾**確實存在** —— PowerShell 自己建的。
#
#   原因是 Windows PowerShell 5.1 把參數傳給**原生程式**（.exe）時，
#   是用系統的 ANSI codepage（繁中是 Big5）轉的。pg_dump.exe 收到的
#   是一串亂碼路徑，於是它去找一個不存在的資料夾。
#
#   ★ 這跟 .ps1 要存成 UTF-8 with BOM 是**同一個根源**：
#     PowerShell 5.1 在「跨出 PowerShell 世界」的邊界上不用 UTF-8。
#     所以規則是:**任何要交給 .exe 的路徑，一律純英數字。**
#
# ══════════════════════════════════════════════════════════════
# ★★★ 用 `$env:USERPROFILE`，**不要用 `GetFolderPath('MyDocuments')`**
#   （2026-08-31 踩過）
#
#   原本是 `GetFolderPath('MyDocuments')`。它回傳
#   `C:\Users\ASUS\Documents` —— 而那個資料夾**實際上不存在**：
#   OneDrive 把「文件」接管之後，真正的位置是
#   `C:\Users\ASUS\OneDrive\Documents`，但那個 API 仍然回舊路徑。
#
#   ★ `GetFolderPath` 回的是**登錄檔裡登記的位置**，不是「現在真的在哪」。
#     兩者在沒裝 OneDrive 的機器上一樣，裝了就可能不一樣 ——
#     而症狀是 pg_dump 說「找不到路徑」，聽起來像它的問題。
#
#   ★★ `$env:USERPROFILE`（`C:\Users\ASUS`）是**一定存在**的。
#     沒有雲端同步、沒有重新導向、路徑短、純英數字。
#     備份要的就是這種無聊的可靠。
#
# 想換地方就改這一行。★ 兩個要求:**不要中文、不要放在專案資料夾裡**。
$BackupDir = Join-Path $env:USERPROFILE 'anxing-db-backup'

# 保留幾天。跟 GitHub 那邊一致（使用者選的 30 天）。
$KeepDays = 30

Write-Host ''
Write-Host '═══ 安幸 ERP 資料庫備份 ═══' -ForegroundColor Cyan
Write-Host ''

# ══════════════════════════════════════════════════════════════
# 一、檢查 pg_dump 在不在
# ══════════════════════════════════════════════════════════════
#
# ★ 先檢查再開始。跑到一半才發現沒裝的話,前面等的那段時間白費,
#   而且會留下一個寫到一半的檔案 —— 那個檔案看起來像備份。
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue

if (-not $pgDump) {
    # ★ 裝了但沒加進 PATH 是最常見的情況。幾個常見位置都找一下 ——
    #   叫使用者自己去設 PATH 的成本，比這幾行高得多。
    $paths = @(
        $env:PG_DUMP                                     # 自己指定的（解壓縮版用這個）
        'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe'   # 官方 installer
        'C:\Program Files (x86)\PostgreSQL\*\bin\pg_dump.exe'
        "$env:LOCALAPPDATA\Programs\PostgreSQL\*\bin\pg_dump.exe"
        "$env:USERPROFILE\pgsql\bin\pg_dump.exe"          # zip 解壓縮的慣例位置
        "$env:USERPROFILE\Downloads\pgsql\bin\pg_dump.exe"
    ) | Where-Object { $_ }

    foreach ($p in $paths) {
        $hit = Get-ChildItem $p -ErrorAction SilentlyContinue |
               Sort-Object FullName -Descending | Select-Object -First 1
        if ($hit) { $pgDump = $hit.FullName; break }
    }
    if ($pgDump) { Write-Host "找到 pg_dump：$pgDump" -ForegroundColor DarkGray }
}

if (-not $pgDump) {
    Write-Host '找不到 pg_dump。' -ForegroundColor Red
    Write-Host ''
    Write-Host '裝一次就好，兩種方式挑一種：'
    Write-Host ''
    Write-Host '  【A】官方安裝程式（推薦，裝完這支腳本會自己找到）' -ForegroundColor Yellow
    Write-Host '    1. 開 https://www.postgresql.org/download/windows/'
    Write-Host '       → Download the installer → 選最新版 Windows x86-64'
    Write-Host '    2. 安裝精靈的 Select Components 那一頁：'
    Write-Host '       只勾 Command Line Tools，其他三個全部取消'
    Write-Host '       （PostgreSQL Server / pgAdmin 4 / Stack Builder 都用不到）'
    Write-Host '    3. 之後一路 Next。密碼那頁隨便填（本機沒裝 server，用不到）'
    Write-Host '    4. 裝完重開 PowerShell，再跑一次這支腳本'
    Write-Host ''
    Write-Host '  【B】免安裝壓縮檔（不用系統管理員權限）' -ForegroundColor Yellow
    Write-Host '    1. 開 https://www.enterprisedb.com/download-postgresql-binaries'
    Write-Host '    2. 下載 Windows x86-64 的 zip，解壓縮'
    Write-Host "    3. 把裡面的 pgsql 資料夾整個放到 $env:USERPROFILE\pgsql"
    Write-Host '    4. 再跑一次這支腳本'
    Write-Host ''
    exit 1
}
$pgDumpPath = if ($pgDump -is [string]) { $pgDump } else { $pgDump.Source }

# ══════════════════════════════════════════════════════════════
# 二、拿連線字串
# ══════════════════════════════════════════════════════════════
#
# ★★★ **連線字串不寫在這個檔案裡。**
#
#   它裡面有資料庫密碼,而這個檔案是要 commit 進 git 的 ——
#   寫進去就等於把密碼公開,而且 git 的歷史**刪不乾淨**
#   （改掉之後舊的 commit 裡還在）。
#
#   所以從環境變數讀。設定方式在下面的錯誤訊息裡。
$dbUrl = $env:SUPABASE_DB_URL

if (-not $dbUrl) {
    # .env.local 裡有的話也接受 —— 那個檔案已經在 .gitignore 裡
    $envFile = Join-Path $PSScriptRoot '..\.env.local'
    if (Test-Path $envFile) {
        $line = Select-String -Path $envFile -Pattern '^SUPABASE_DB_URL=' -ErrorAction SilentlyContinue |
                Select-Object -First 1
        if ($line) { $dbUrl = ($line.Line -replace '^SUPABASE_DB_URL=', '').Trim().Trim('"').Trim("'") }
    }
}

if (-not $dbUrl) {
    Write-Host '找不到連線字串。' -ForegroundColor Red
    Write-Host ''
    Write-Host '設定一次（只有第一次需要）：'
    Write-Host ''
    Write-Host '  1. 去 Supabase Dashboard → 右上角 Connect → Session pooler'
    Write-Host '     複製那一整串 postgresql://... 的字'
    Write-Host '  2. 把 [YOUR-PASSWORD] 換成資料庫密碼'
    Write-Host '  3. 在 PowerShell 跑（只要跑一次，會永久記住）：'
    Write-Host ''
    Write-Host '     [Environment]::SetEnvironmentVariable(' -ForegroundColor Yellow -NoNewline
    Write-Host "'SUPABASE_DB_URL', '貼在這裡', 'User')" -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  4. 關掉 PowerShell 重開，再跑一次這支腳本'
    Write-Host ''
    Write-Host '  ★ 那串字裡面有資料庫密碼。不要貼進聊天室、不要 commit。' -ForegroundColor DarkYellow
    Write-Host ''
    exit 1
}

# ══════════════════════════════════════════════════════════════
# 三、備份
# ══════════════════════════════════════════════════════════════
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

# ══════════════════════════════════════════════════════════════
# ★★★ 先確認「PowerShell 寫得進去」（2026-08-31 踩過第二次）
#
#   pg_dump 只會回一句 "could not open output file ... No such file
#   or directory" —— 那一句話**同時涵蓋三種完全不同的原因**:
#     · 資料夾真的不存在
#     · 資料夾存在但沒有寫入權限
#     · 資料夾存在也寫得進去，但**路徑傳到 pg_dump 時被轉壞了**
#
#   PowerShell 自己先寫一個測試檔，就能把前兩種跟第三種分開 ——
#   而分不開的話只能一直猜。
# ══════════════════════════════════════════════════════════════
$probe = Join-Path $BackupDir '.write-test'
try {
    [System.IO.File]::WriteAllText($probe, 'ok')
    Remove-Item $probe -Force
} catch {
    Write-Host ''
    Write-Host "這個資料夾寫不進去：$BackupDir" -ForegroundColor Red
    Write-Host "  原因：$($_.Exception.Message)"
    Write-Host '  最常見的情況是「文件」被 OneDrive 接管了。'
    Write-Host '  改用這個路徑試試 —— 編輯腳本開頭的 $BackupDir：'
    Write-Host "      `$BackupDir = '$env:USERPROFILE\anxing-db-backup'" -ForegroundColor Yellow
    exit 1
}

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$fileName = "anxing_$stamp.sql"
$outFile = Join-Path $BackupDir $fileName

Write-Host "備份到：$outFile"
Write-Host '匯出中⋯（幾千筆流水大約十幾秒）'

# ★ `--no-owner --no-privileges`:不要帶 supabase_admin 那些擁有者資訊。
#   帶著的話還原到新專案時會一路噴 "role does not exist"。
# ★ `--schema=public`:只有我們自己的表。
#   `--schema=supabase_migrations`:migration 的執行紀錄 ——
#     沒有它的話還原之後 `schema_migrations` 是空的,
#     而那會讓人以為所有 migration 都沒跑過。
# ★ `--no-comments` **不加** —— 那些 `comment on column` 是這個專案
#   把「為什麼」寫在資料庫裡的方式,丟掉就沒了。
# ══════════════════════════════════════════════════════════════
# ★★★ 先 cd 進備份資料夾，只把**純檔名**交給 pg_dump
#
#   2026-08-31 這一段換過兩次寫法。原本傳完整路徑:
#       --file="C:\Users\ASUS\Documents\anxing-db-backup\anxing_xxx.sql"
#   pg_dump 一直回 "No such file or directory"，而那個資料夾**確實存在**、
#   PowerShell 也寫得進去（上面的 write-test 證明了）。
#
#   Windows PowerShell 5.1 把參數交給原生程式（.exe）時要經過一次
#   字串重組，含反斜線與等號的長路徑在這一關容易被轉壞 ——
#   而 .exe 收到的東西我們看不到，只看得到它抱怨檔案不存在。
#
#   ★ 解法是**不要讓路徑經過那一關**:先 cd 進去，只給 `anxing_日期.sql`。
#     檔名是純英數字、沒有反斜線，沒有東西可以被轉壞。
#
#   ★★ `Push-Location` / `Pop-Location` 成對 —— 用 `Set-Location` 的話，
#     腳本跑完使用者的 PowerShell 會停在備份資料夾裡，
#     而他下一句多半是 `.\deploy.ps1`，然後發現「找不到檔案」。
# ══════════════════════════════════════════════════════════════
#   ★★★ `Push-Location` **不夠**。PowerShell 的「目前位置」跟
#     .NET／原生程序的工作目錄是**兩個不同的東西** ——
#     `Push-Location` 只改前者，而 `pg_dump.exe` 繼承的是後者。
#     不同步的話它會把檔案寫到 PowerShell 啟動時的資料夾（多半是專案資料夾），
#     **而且會成功** —— 那比失敗更糟:你以為備份在 A，其實在 B。
$prevCwd = [System.Environment]::CurrentDirectory
Push-Location $BackupDir
[System.Environment]::CurrentDirectory = $BackupDir
try {
    & $pgDumpPath `
        "$dbUrl" `
        --no-owner --no-privileges `
        --schema=public --schema=supabase_migrations `
        --quote-all-identifiers `
        --file=$fileName
} finally {
    Pop-Location
    [System.Environment]::CurrentDirectory = $prevCwd
}

if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host "pg_dump 失敗（代碼 $LASTEXITCODE）。" -ForegroundColor Red
    # ★★ 把 pg_dump 自己印的那一行**看懂再轉述**。
    #   籠統地說「大概是密碼錯了」會把人帶去查錯的地方 ——
    #   2026-08-31 那次真正的原因是路徑有中文，而訊息卻寫著「密碼改過了」。
    Write-Host '看上面那一行 pg_dump 的訊息：'
    Write-Host '  password authentication failed  → 密碼錯了，或中括號沒拿掉'
    Write-Host '  could not translate host name   → 連線字串複製時少了一段'
    Write-Host '  could not open output file      → 備份路徑有問題（不能有中文）'
    Write-Host '  server version mismatch         → pg_dump 版本比資料庫舊，裝新版'
    # ★ 失敗時把半成品刪掉。留著的話下次看到那個檔名會以為有備份。
    if (Test-Path $outFile) { Remove-Item $outFile -Force }
    exit 1
}

# ══════════════════════════════════════════════════════════════
# 四、★★★ 驗證備份不是空的
# ══════════════════════════════════════════════════════════════
#
# pg_dump 有可能回 0 但只寫出檔頭（權限不足時就是這樣）。
# **沒有驗證的備份不算備份** —— 而發現的時機通常是你最需要它的那一天。
$size = (Get-Item $outFile).Length
$sizeMB = [math]::Round($size / 1MB, 2)

$missing = @()
foreach ($t in @('bank_transactions', 'orders', 'expenses', 'contracts')) {
    if (-not (Select-String -Path $outFile -Pattern "public`".`"$t" -Quiet -SimpleMatch:$false)) {
        $missing += $t
    }
}

if ($size -lt 10KB -or $missing.Count -gt 0) {
    Write-Host ''
    Write-Host "⚠ 這份備份看起來是壞的（$sizeMB MB）" -ForegroundColor Red
    if ($missing.Count -gt 0) { Write-Host "  找不到這幾張表：$($missing -join '、')" -ForegroundColor Red }
    Write-Host '  檔案留著讓你看，但**不要當成有備份**。' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host "✓ 備份完成　$sizeMB MB" -ForegroundColor Green

# ══════════════════════════════════════════════════════════════
# 五、清掉過期的
# ══════════════════════════════════════════════════════════════
#
# ★ 只刪**這支腳本自己產生的檔名格式**（anxing_*.sql）。
#   刪整個資料夾裡的舊檔案的話,萬一有人把別的東西放進去就一起被刪了。
$old = Get-ChildItem $BackupDir -Filter 'anxing_*.sql' |
       Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) }

if ($old) {
    $old | Remove-Item -Force
    Write-Host "已清掉 $($old.Count) 份超過 $KeepDays 天的舊備份" -ForegroundColor DarkGray
}

$all = @(Get-ChildItem $BackupDir -Filter 'anxing_*.sql')
Write-Host "資料夾裡現在有 $($all.Count) 份備份"
Write-Host ''
Write-Host '要還原的時候看 README〈十二、備份與還原〉。' -ForegroundColor DarkGray
Write-Host ''
