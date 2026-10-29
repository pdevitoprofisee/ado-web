# Builds ado-web and installs it as an always-on app that starts when you sign in.
# Run it again to deploy new changes. Dev keeps port 7331 and its own database.
$ErrorActionPreference = 'Stop'

$port = 7330
$taskName = 'ado-web'
$root = Join-Path $env:LOCALAPPDATA 'ado-web-installed'
$app = Join-Path $root 'app'
$data = Join-Path $root 'data'
$launcher = Join-Path $root 'launch.mjs'
$repo = Split-Path $PSScriptRoot -Parent

# Build first, so a broken build leaves the running app alone.
Push-Location $repo
try {
  pnpm build
  if ($LASTEXITCODE) { throw 'The build failed. The installed app did not change.' }
} finally {
  Pop-Location
}

# Stopping the task can leave node running, and node holds a lock on the
# keyring addon, so stop whatever listens on the port too.
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName
}
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

robocopy (Join-Path $repo '.output') $app /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the build failed (robocopy exit $LASTEXITCODE)." }

# The build leaves the keyring addon external, so the install needs its own
# copy of the package and its Windows binary.
$napi = Join-Path $app 'node_modules\@napi-rs'
New-Item -ItemType Directory -Force $napi | Out-Null
Get-ChildItem (Join-Path $repo 'node_modules\.pnpm') -Directory -Filter '@napi-rs+keyring*' |
  ForEach-Object { Get-ChildItem (Join-Path $_.FullName 'node_modules\@napi-rs') -Directory } |
  ForEach-Object { Copy-Item $_.FullName (Join-Path $napi $_.Name) -Recurse -Force }

# A Scheduled Task cannot set environment variables, so the launcher does. The
# headless console shows nothing, so the launcher also sends output to a log.
$dataJson = ConvertTo-Json $data
$logJson = ConvertTo-Json (Join-Path $root 'ado-web.log')
Set-Content -Path $launcher -Encoding utf8 -Value @"
import { createWriteStream } from 'node:fs'

const log = createWriteStream($logJson, { flags: 'w' })
for (const stream of [process.stdout, process.stderr]) {
  stream.write = (chunk, ...rest) => log.write(chunk, ...rest)
}

process.env.HOST = '127.0.0.1'
process.env.PORT = '$port'
process.env.ADO_WEB_DATA_DIR = $dataJson
await import('./app/server/index.mjs')
"@

# Runs as you so the keyring can read your PAT. conhost --headless keeps the
# console window hidden.
$user = "$env:USERDOMAIN\$env:USERNAME"
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
  -Argument "--headless `"$node`" `"$launcher`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

for ($i = 0; $i -lt 30; $i++) {
  try {
    Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2 | Out-Null
    Write-Host "ado-web is running at http://adoweb.localhost:$port"
    exit 0
  } catch {
    Start-Sleep -Seconds 1
  }
}
throw "ado-web did not answer on port $port. Read $(Join-Path $root 'ado-web.log')."
