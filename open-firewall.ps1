# Run as Administrator: opens inbound TCP 3000 for the SAP Monitor
$port = 3000
$name = "SAP Monitor (TCP $port)"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Please run this script in PowerShell 'Run as Administrator'."
    exit 1
}

if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
    Write-Host "Firewall rule '$name' already exists."
} else {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any -ErrorAction Stop | Out-Null
    Write-Host "Firewall rule '$name' created."
}
