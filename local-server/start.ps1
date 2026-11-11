param(
    [string]$Python,
    [string]$OutputDir,
    [string]$DistDir,
    [string]$Config,
    [int]$Port = 0,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$taskCandidates = @()
if ($Python) {
    $taskCommand = Get-Command -Name $Python -CommandType Application -ErrorAction Stop
    $taskCandidates += @{ Command = $taskCommand.Source; Prefix = @() }
} else {
    $taskVenv = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $taskVenv -PathType Leaf) {
        $taskCandidates += @{ Command = $taskVenv; Prefix = @() }
    }
    foreach ($taskName in @('py', 'python')) {
        $taskCommand = Get-Command -Name $taskName -CommandType Application -ErrorAction SilentlyContinue
        if ($taskCommand) {
            $taskPrefix = if ($taskName -eq 'py') { @('-3') } else { @() }
            $taskCandidates += @{ Command = $taskCommand.Source; Prefix = $taskPrefix }
        }
    }
}

$taskSelected = $null
$taskReasons = @()
foreach ($taskCandidate in $taskCandidates) {
    $taskPrefix = $taskCandidate.Prefix
    $taskVersion = & $taskCandidate.Command @taskPrefix -c "import sys; print('.'.join(map(str, sys.version_info[:3]))); sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>&1
    if ($LASTEXITCODE -eq 0) {
        $taskSelected = $taskCandidate
        break
    }
    $taskReasons += ($taskCandidate.Command + ': ' + ($taskVersion -join ' '))
}
if (-not $taskSelected) {
    throw ('未找到 Python 3.10 或更新版本。请安装 Python，或使用 -Python 指定 python.exe。' + [Environment]::NewLine + ($taskReasons -join [Environment]::NewLine))
}

$taskPrefix = $taskSelected.Prefix
& $taskSelected.Command @taskPrefix -c 'from PIL import Image'
if ($LASTEXITCODE -ne 0) {
    throw '缺少 Pillow。请用同一个 Python 执行：python -m pip install -r local-server\requirements.txt'
}

$taskArguments = @($taskPrefix) + @('-B', (Join-Path $PSScriptRoot 'gui_server.py'), '--serve')
if ($OutputDir) { $taskArguments += @('--output-dir', $OutputDir) }
if ($DistDir) { $taskArguments += @('--dist-dir', $DistDir) }
if ($Config) { $taskArguments += @('--config', $Config) }
if ($Port -ne 0) { $taskArguments += @('--port', [string]$Port) }
if (-not $NoOpen) { $taskArguments += '--open' }
& $taskSelected.Command @taskArguments
if ($LASTEXITCODE -ne 0) { throw ('本机服务已退出，退出码：' + $LASTEXITCODE) }
