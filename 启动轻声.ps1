param([switch]$NoBrowser, [switch]$DockerAccess)
$ErrorActionPreference = 'Stop'
$voiceRoot = 'D:\BASE\桌面\其他工作区\语音'
$healthUrl = 'http://127.0.0.1:8080/health'
$logDir = Join-Path $env:LOCALAPPDATA 'BreezeReader'
$voiceLibrary = 'D:\BASE\桌面\work\素材库\音色'
$startupMutex = $null
$startupMutexHeld = $false

function Test-Breeze {
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        return $health.status -eq 'ok' -and $health.sample_rate -eq 24000
    } catch { return $false }
}

try {
    $startupMutex = [System.Threading.Mutex]::new($false, 'Local\BreezeReaderStartup')
    try { $startupMutexHeld = $startupMutex.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] { $startupMutexHeld=$true }
    if (-not $startupMutexHeld) { throw '已有轻声启动任务正在进行，请稍后重试。' }
    $schemeKey = 'HKCU:\Software\Classes\breeze-reader'
    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $launchScript = Join-Path $PSScriptRoot '启动轻声.ps1'
    # No URL argument is passed to PowerShell; every protocol URL runs this fixed launcher only.
    $schemeCommand = '"' + $powershellExe + '" -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launchScript + '" -NoBrowser'
    $oldSchemeCommand = $null
    if (Test-Path -LiteralPath "$schemeKey\shell\open\command") { $oldSchemeCommand = (Get-Item -LiteralPath "$schemeKey\shell\open\command").GetValue('') }
    if ($oldSchemeCommand -ne $schemeCommand) {
        if ($oldSchemeCommand -and (Get-Item -LiteralPath $schemeKey).GetValue('') -ne '轻声本地语音启动') { throw '轻声启动入口名称已被其他程序使用，未覆盖它。' }
        New-Item -Path "$schemeKey\shell\open\command" -Force | Out-Null
        Set-Item -LiteralPath $schemeKey -Value '轻声本地语音启动'
        New-ItemProperty -LiteralPath $schemeKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
        Set-Item -LiteralPath "$schemeKey\shell\open\command" -Value $schemeCommand
    }
    $python = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
    if (-not (Test-Path -LiteralPath $python)) { throw '找不到 Python 3.12，无法启动轻声本机接口。' }
    $bridgeScript = Join-Path $PSScriptRoot 'bridge.py'
    $preparedLibrary = Join-Path $logDir 'model-voices'
    $preparedOutput = & $python $bridgeScript --voices $voiceLibrary --prepare-voices --prepared $preparedLibrary
    if ($LASTEXITCODE -ne 0) { throw '音色准备失败，请确认音色文件已保存。' }
    $prepared = ($preparedOutput -join "`n") | ConvertFrom-Json
    if ($prepared.count -eq 0) { throw '指定目录没有有效的 .breeze 音色。' }
    $server = Join-Path $voiceRoot 'runtime\breeze-tts-2-v0.1.3-windows-x64-vulkan\breeze-server.exe'
    if (Test-Breeze) {
        $reloadModel = $false
        if ($DockerAccess) {
            foreach ($modelPid in @(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)) {
                $runningModel=Get-CimInstance Win32_Process -Filter "ProcessId=$modelPid"
                if ($runningModel.CommandLine -notmatch '--host 0\.0\.0\.0') { $reloadModel=$true }
            }
        }
        try {
            $loadedVoices = @(Invoke-RestMethod 'http://127.0.0.1:8080/v1/voices' -TimeoutSec 5)
            foreach ($voiceId in $prepared.ids) { if ($voiceId -notin $loadedVoices.id) { $reloadModel=$true;break } }
        } catch { $reloadModel=$true }
        if ($reloadModel) {
            Write-Host '音色库有更新，正在重新加载…'
            foreach ($modelPid in @(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)) {
                $modelProcess = Get-Process -Id $modelPid -ErrorAction Stop
                if ($modelProcess.Path -ne $server) { throw '8080 不是轻声模型进程，未停止其他程序。' }
                Stop-Process -Id $modelPid -Force
                $modelProcess.WaitForExit(10000) | Out-Null
            }
        }
    }
    if (-not (Test-Breeze)) {
        $server = Join-Path $voiceRoot 'runtime\breeze-tts-2-v0.1.3-windows-x64-vulkan\breeze-server.exe'
        $model = Join-Path $voiceRoot 'breeze-tts-2-q8_0.gguf'
        if (-not (Test-Path -LiteralPath $server) -or -not (Test-Path -LiteralPath $model)) {
            throw '找不到本地模型或运行程序，请检查语音文件夹。'
        }
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $modelHost = if ($DockerAccess) { '0.0.0.0' } else { '127.0.0.1' }
        $modelArguments = 'breeze-tts-2-q8_0.gguf --host ' + $modelHost + ' --port 8080 --voices-dir "' + $preparedLibrary + '" --webui'
        $process = Start-Process -FilePath $server -ArgumentList $modelArguments -WorkingDirectory $voiceRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$stamp.stdout.log") -RedirectStandardError (Join-Path $logDir "$stamp.stderr.log") -PassThru
        Write-Host '正在准备本地声音…'
        $ready = $false
        for ($attempt = 0; $attempt -lt 90; $attempt++) {
            if (Test-Breeze) { $ready = $true; break }
            if ($process.HasExited) { throw "模型启动失败，请查看 $logDir 中的日志。" }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw '模型仍在准备中，稍后重试；已启动的服务会继续加载。' }
    }
    $bridgeReady = $false
    try { $bridgeHealth = Invoke-RestMethod 'http://127.0.0.1:8789/health' -TimeoutSec 2; $bridgeReady = $bridgeHealth.bridge -eq 'breeze-reader-3' } catch {}
    if (-not $bridgeReady) {
        foreach ($oldBridgePid in @(Get-NetTCPConnection -LocalPort 8789 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)) {
            $oldBridge = Get-CimInstance Win32_Process -Filter "ProcessId=$oldBridgePid"
            if ($oldBridge.Name -ne 'python.exe' -or -not $oldBridge.CommandLine.Contains('breeze-reader\bridge.py')) { throw '8789 被其他程序占用，未停止它。' }
            Stop-Process -Id $oldBridgePid -Force
        }
        $python = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
        if (-not (Test-Path -LiteralPath $python)) { throw '找不到 Python 3.12，无法启动轻声本机接口。' }
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $bridgeStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $bridgeScript = Join-Path $PSScriptRoot 'bridge.py'
        $bridgeArgs = '"' + $bridgeScript + '" --voices "' + $voiceLibrary + '" --origin http://192.168.31.178:8000 --origin http://127.0.0.1:8000 --origin http://localhost:8000'
        $bridgeProcess = Start-Process -FilePath $python -ArgumentList $bridgeArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$bridgeStamp.bridge.stdout.log") -RedirectStandardError (Join-Path $logDir "$bridgeStamp.bridge.stderr.log") -PassThru
        for ($bridgeAttempt=0; $bridgeAttempt -lt 15; $bridgeAttempt++) {
            try { $bridgeHealth = Invoke-RestMethod 'http://127.0.0.1:8789/health' -TimeoutSec 2; if ($bridgeHealth.bridge -eq 'breeze-reader-3') { $bridgeReady=$true;break } } catch {}
            if ($bridgeProcess.HasExited) { throw '轻声本机接口启动失败，请查看 BreezeReader 日志。' }
            Start-Sleep -Seconds 1
        }
        if (-not $bridgeReady) { throw '轻声本机接口尚未就绪。' }
    }
    Write-Host "轻声已就绪，已准备 $($prepared.count) 个音色。"
    if (-not $NoBrowser) { Start-Process 'http://192.168.31.178:8000/' }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (-not $NoBrowser) { Read-Host '按回车关闭' }
    exit 1
} finally {
    if ($startupMutexHeld) { $startupMutex.ReleaseMutex() }
    if ($startupMutex) { $startupMutex.Dispose() }
}
