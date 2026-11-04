# Adds or removes Explorer's "Open with Lasso" for PDFs and images, for this
# user only (HKCU): a right-click entry, and Lasso in the "Open with" list so a
# double-click can be pointed at it.
param(
  [ValidateSet('install', 'uninstall')][string]$Action,
  [string]$Root,
  [string]$Node,
  [string]$Label = 'Open with Lasso'
)
$ErrorActionPreference = 'Stop'

$exts = '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'
$classes = 'HKCU:\Software\Classes'
$progId = 'Lasso.File'
# conhost --headless runs node with no console window flashing up
$command = '"{0}" --headless "{1}" "{2}" "%1"' -f "$env:SystemRoot\System32\conhost.exe", $Node, (Join-Path $Root 'app\open.mjs')

function Set-Default([string]$Key, [string]$Value) {
  if (-not (Test-Path -LiteralPath $Key)) { New-Item -Path $Key -Force | Out-Null }
  Set-Item -LiteralPath $Key -Value $Value
}

if ($Action -eq 'install') {
  foreach ($ext in $exts) {
    $verb = "$classes\SystemFileAssociations\$ext\shell\Lasso"
    Set-Default $verb $Label
    Set-ItemProperty -LiteralPath $verb -Name 'Icon' -Value "`"$Node`""
    Set-Default "$verb\command" $command

    $openWith = "$classes\$ext\OpenWithProgids"
    if (-not (Test-Path -LiteralPath $openWith)) { New-Item -Path $openWith -Force | Out-Null }
    New-ItemProperty -LiteralPath $openWith -Name $progId -PropertyType None -Value ([byte[]]@()) -Force | Out-Null
  }
  Set-Default "$classes\$progId" 'Lasso'
  Set-Default "$classes\$progId\DefaultIcon" "`"$Node`",0"
  Set-Default "$classes\$progId\shell\open\command" $command
  Set-Default "$classes\$progId\Application" ''
  Set-ItemProperty -LiteralPath "$classes\$progId\Application" -Name 'ApplicationName' -Value 'Lasso'
}
else {
  foreach ($ext in $exts) {
    $verb = "$classes\SystemFileAssociations\$ext\shell\Lasso"
    if (Test-Path -LiteralPath $verb) { Remove-Item -LiteralPath $verb -Recurse -Force }
    $openWith = "$classes\$ext\OpenWithProgids"
    if (Test-Path -LiteralPath $openWith) {
      Remove-ItemProperty -LiteralPath $openWith -Name $progId -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path -LiteralPath "$classes\$progId") { Remove-Item -LiteralPath "$classes\$progId" -Recurse -Force }
}

# tell Explorer the associations changed
Add-Type -Namespace Lasso -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, System.IntPtr a, System.IntPtr b);'
[Lasso.Shell]::SHChangeNotify(0x08000000, 0, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
