param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
try {
    $logDir=Join-Path $env:LOCALAPPDATA 'BreezeReader'
    New-Item -ItemType Directory -Path $logDir -Force|Out-Null
    $keyFile=Join-Path $logDir 'lan-key.txt'
    if(-not (Test-Path -LiteralPath $keyFile)) {
        $bytes=New-Object byte[] 32
        $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
        try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
        [IO.File]::WriteAllText($keyFile,([BitConverter]::ToString($bytes).Replace('-','').ToLower()),[Text.UTF8Encoding]::new($false))
    }
        $env:BREEZE_ACCESS_KEY=[IO.File]::ReadAllText($keyFile).Trim()
    & (Join-Path $PSScriptRoot '启动轻声.ps1') -NoBrowser -DockerAccess
    if($LASTEXITCODE -and $LASTEXITCODE -ne 0){throw '模型启动失败'}
    & docker compose -f (Join-Path $PSScriptRoot 'docker/compose.yaml') up -d
    if($LASTEXITCODE -ne 0){throw '轻声 Docker 接口启动失败，请确保 Docker Desktop 正在运行。'}
    $info=Join-Path $logDir '手机连接说明.txt'
    $key=[IO.File]::ReadAllText($keyFile).Trim()
    [IO.File]::WriteAllText($info,"轻声服务地址：http://192.168.31.178:8790`r`n连接密钥：$key`r`n手机和电脑需在同一局域网。酒馆地址：http://192.168.31.178:8000/`r`n在轻声的连接与音色管理里填写以上服务地址和密钥并保存。`r`n密钥请勿公开；电脑 IP 改动后须更新 docker/compose.yaml 和插件地址。",[Text.UTF8Encoding]::new($true))
    Write-Host "轻声手机连接已启动。连接信息保存在 $info"
    if(-not $NoBrowser){Start-Process notepad.exe -ArgumentList ('"'+$info+'"')}
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    if(-not $NoBrowser){Read-Host '按回车关闭'}
    exit 1
}