# ══════════════════════════════════════════════════════════════
# 把「登入時自動下載備份」登記進 Windows 工作排程器
# ══════════════════════════════════════════════════════════════
#
# 2026-08-31 使用者：「打開電腦時 載下來嗎？」→ 選了「登入時自動跑」
#
# 用法（**只要跑一次**）:
#     cd C:\Users\ASUS\Desktop\anxing-web
#     .\scripts\register-backup-task.ps1
#
# 之後每次開機登入，背景就會去把 GitHub 上最新那份備份抓回來。
#
# ══════════════════════════════════════════════════════════════
# 【為什麼要自動】
#
# 「要記得按」的備份，大多數人兩個禮拜後就不按了 ——
# 而不按的那幾週不會有任何提示，直到需要它的那一天。
#
# ★ 自動化的價值不是省那三十秒，是**把「記得」這件事從人身上拿掉**。
#
# ══════════════════════════════════════════════════════════════
# 【★★ 幾個刻意的設定】
#
#   延遲 3 分鐘   登入的那一刻網路多半還沒好,而且開機已經夠慢了
#   不用系統管理員 只讀自己的 GitHub、只寫自己的資料夾,不需要
#   沒網路就跳過   出門在外開機不會跳出錯誤視窗
#   隱藏視窗      每次開機閃一個黑框會讓人想把它關掉
#
# ★ 移除的方式寫在最後面 —— 裝了但不知道怎麼拆的東西，
#   下一個人只敢繞過它，不敢動它。
# ══════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'

$TaskName = 'AnxingBackupFetch'
$Script   = Join-Path $PSScriptRoot 'fetch-backup.ps1'

if (-not (Test-Path $Script)) {
    Write-Host "找不到 $Script" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '═══ 登記「登入時自動下載備份」═══' -ForegroundColor Cyan
Write-Host ''

# ★ 先看在不在。重跑這支要安全 —— 舊的先移除再重建，
#   而不是建第二個同名的（那會失敗，錯誤訊息還很難懂）。
$exists = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($exists) {
    Write-Host '已經登記過了，先移除舊的再重建⋯' -ForegroundColor DarkGray
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# ══════════════════════════════════════════════════════════════
# 動作
# ══════════════════════════════════════════════════════════════
#
# ★★ 用 `powershell.exe` 不是 `pwsh` —— 你的機器上跑的是
#   Windows PowerShell 5.1（那也是 BOM 那個坑的來源）。
#   寫 pwsh 的話沒裝 PowerShell 7 的機器上會靜靜地失敗。
#
# ★ `-WindowStyle Hidden`:每次開機閃一個黑框會讓人想把它關掉,
#   而關掉的方式多半是把整個排程刪了。
# ★ `-ExecutionPolicy Bypass`:預設政策會擋沒有簽章的 .ps1。
#   只作用在這一次執行，不改機器的設定。
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`""

# ══════════════════════════════════════════════════════════════
# 觸發:登入後 3 分鐘
# ══════════════════════════════════════════════════════════════
#
# ★★ 延遲是必要的。登入那一刻 Wi-Fi 多半還沒連上 ——
#   立刻跑的結果是每次開機都失敗一次,而失敗訊息在背景沒有人看到。
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT3M'

# ══════════════════════════════════════════════════════════════
# 設定
# ══════════════════════════════════════════════════════════════
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -MultipleInstances IgnoreNew

# ★ 沒網路就跳過,不要跳錯誤。出門在外開機是常態,
#   而那時跳出來的紅字只會教人「這東西常常壞，不用管它」。
$settings.RunOnlyIfNetworkAvailable = $true

# ★ `-RunLevel Limited`:**不要**系統管理員權限。
#   它只讀自己的 GitHub、只寫自己的資料夾 —— 給到最小。
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Limited `
    -Description '登入後把 GitHub 上最新的資料庫備份下載到 %USERPROFILE%\anxing-db-backup（安幸 ERP）' `
    | Out-Null

Write-Host '✓ 登記完成' -ForegroundColor Green
Write-Host ''
Write-Host '  什麼時候跑：每次登入後 3 分鐘（背景，不會有視窗）'
Write-Host "  下載到：    $env:USERPROFILE\anxing-db-backup\"
Write-Host "  紀錄看這裡：$env:USERPROFILE\anxing-db-backup\fetch.log"
Write-Host ''
Write-Host '  現在馬上跑一次試試：' -ForegroundColor Yellow
Write-Host "      Start-ScheduledTask -TaskName $TaskName"
Write-Host ''
Write-Host '  以後不想要了：' -ForegroundColor DarkGray
Write-Host "      Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host ''
