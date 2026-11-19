# Drives the player in the real app through Windows UI Automation: it was started with a film on its
# command line, so the page is open and the film plays. Looks for the controls by name, pauses, and goes on.
# Windows PowerShell 5.1; ASCII only.
#
#   powershell -NoProfile -File uia-player.ps1 -ProcessId <pid> -ShotDir <folder>
param([Parameter(Mandatory = $true)][int]$ProcessId, [string]$ShotDir = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$failures = New-Object System.Collections.ArrayList
function Check($ok, $what) {
    if ($ok) { Write-Host "ok    $what" } else { Write-Host "FAIL  $what"; [void]$failures.Add($what) }
}
$proc = Get-Process -Id $ProcessId
for ($i = 0; $i -lt 40 -and $proc.MainWindowHandle -eq 0; $i++) { Start-Sleep -Milliseconds 500; $proc.Refresh() }
Check ($proc.MainWindowHandle -ne 0) 'the app has a window'
if ($proc.MainWindowHandle -eq 0) { exit 1 }
$root = $AE::FromHandle($proc.MainWindowHandle)
function Named($pattern, $type) {
    foreach ($e in $root.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($e.Current.Name -like $pattern) {
            if ($null -eq $type -or $e.Current.ControlType -eq $type) { return $e }
        }
    }
    return $null
}
function Wait-For($pattern, $type) {
    for ($i = 0; $i -lt 40; $i++) {
        $e = Named $pattern $type
        if ($null -ne $e) { return $e }
        Start-Sleep -Milliseconds 250
    }
    return $null
}
function Invoke-It($e) {
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return $true }
    return $false
}
function Shot($name) {
    if ($ShotDir -eq '') { return }
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $ShotDir $name))
}

$pause = Wait-For 'Pause' $CT::Button
Check ($null -ne $pause) 'the film given on the command line plays: the button offers the pause'
Check ($null -ne (Wait-For 'Abspielen' $CT::Text)) 'the page is the one of the player'
Check ($null -ne (Named 'Stelle im Film' $CT::Slider)) 'the place in the film is a slider by name'
Check ($null -ne (Named 'Lautst*rke' $CT::Slider)) 'and so is the volume'
Check ($null -ne (Named 'Tempo *' $CT::Button)) 'the speed can be changed'
Start-Sleep -Seconds 2
Shot 'app-player.png'
if ($null -ne $pause) {
    Check (Invoke-It $pause) 'the pause can be invoked'
    Check ($null -ne (Wait-For 'Abspielen' $CT::Button)) 'and then the button offers to go on'
    $go = Named 'Abspielen' $CT::Button
    if ($null -ne $go) {
        [void](Invoke-It $go)
        Check ($null -ne (Wait-For 'Pause' $CT::Button)) 'it plays again'
    }
}
Write-Host ''
if ($failures.Count -gt 0) { Write-Host ("{0} check(s) failed" -f $failures.Count); exit 1 }
Write-Host 'all checks passed'
exit 0
