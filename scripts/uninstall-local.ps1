# Removes the always-on install that deploy-local.ps1 made. The PAT stays in
# Credential Manager because dev uses the same entry.
$ErrorActionPreference = 'Stop'

$port = 7330
$taskName = 'ado-web'
$root = Join-Path $env:LOCALAPPDATA 'ado-web-installed'

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

if (Test-Path $root) { Remove-Item -Recurse -Force $root }
Write-Host 'ado-web is uninstalled.'
