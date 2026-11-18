# Asks the demo window what a screen reader would ask, through Windows UI Automation.
# Run with Windows PowerShell 5.1 (it ships the UIA client; PowerShell 7 does not reliably).
# The script is ASCII only on purpose: 5.1 reads a script without a BOM as ANSI.
#
#   powershell -NoProfile -File uia-check.ps1 -ProcessId <pid>
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [string]$WorkDir = (Get-Location).Path
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$failures = New-Object System.Collections.ArrayList
function Check($ok, $what) {
    if ($ok) { Write-Host "ok    $what" } else { Write-Host "FAIL  $what"; [void]$failures.Add($what) }
}

$proc = Get-Process -Id $ProcessId
for ($i = 0; $i -lt 40 -and $proc.MainWindowHandle -eq 0; $i++) { Start-Sleep -Milliseconds 500; $proc.Refresh() }
Check ($proc.MainWindowHandle -ne 0) 'the demo has a window'
if ($proc.MainWindowHandle -eq 0) { exit 1 }

$root = $AE::FromHandle($proc.MainWindowHandle)
Write-Host ("window name: '{0}', class: '{1}'" -f $root.Current.Name, $root.Current.ClassName)

function Everything {
    $root.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}
# The first question wakes the tree up; the app answers with the next frame.
$all = Everything
for ($i = 0; $i -lt 30 -and $all.Count -lt 5; $i++) { Start-Sleep -Milliseconds 500; $all = Everything }

Write-Host '--- what a screen reader sees:'
foreach ($e in $all) {
    $r = $e.Current.BoundingRectangle
    Write-Host ("{0,-26} name='{1}' rect={2:N0},{3:N0} {4:N0}x{5:N0} focusable={6} enabled={7}" -f `
        $e.Current.ControlType.ProgrammaticName, $e.Current.Name, $r.X, $r.Y, $r.Width, $r.Height, $e.Current.IsKeyboardFocusable, $e.Current.IsEnabled)
}
Write-Host '---'

function Named($pattern) { foreach ($e in (Everything)) { if ($e.Current.Name -like $pattern) { return $e } } return $null }

Check ($root.Current.Name -like 'Sondra*') 'the window is named'
$title = Named 'Frieren*Folge 12 von 28'
Check ($null -ne $title) 'the title text is there with its name'

$play = Named 'Abspielen'
Check ($null -ne $play) 'the play button is there by name'
if ($null -ne $play) {
    Check ($play.Current.ControlType.ProgrammaticName -eq 'ControlType.Button') 'it is a button'
    $r = $play.Current.BoundingRectangle
    Check (($r.Width -gt 20) -and ($r.Height -gt 10)) 'it has a real size on screen'
    $wr = $root.Current.BoundingRectangle
    Check (($r.X -ge $wr.X) -and ($r.Y -ge $wr.Y) -and (($r.X + $r.Width) -le ($wr.X + $wr.Width + 2))) 'its place is inside the window'
    $invoke = $null
    $has = $play.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)
    Check $has 'it can be invoked'
    if ($has) {
        Remove-Item -ErrorAction SilentlyContinue (Join-Path $WorkDir 'activated.txt')
        $invoke.Invoke()
        $seen = $false
        for ($i = 0; $i -lt 20 -and -not $seen; $i++) { Start-Sleep -Milliseconds 250; $seen = Test-Path (Join-Path $WorkDir 'activated.txt') }
        Check $seen 'invoking it reached the app'
    }
}

$mute = Named 'Stumm'
Check ($null -ne $mute) 'the mute switch is there by name'
if ($null -ne $mute) {
    $toggle = $null
    $has = $mute.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)
    Check $has 'it can be toggled'
    if ($has) {
        $before = $toggle.Current.ToggleState
        $toggle.Toggle()
        $changed = $false
        for ($i = 0; $i -lt 20 -and -not $changed; $i++) {
            Start-Sleep -Milliseconds 250
            $again = Named 'Stumm'
            $t = $null
            if ($again.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$t)) { $changed = ($t.Current.ToggleState -ne $before) }
        }
        Check $changed 'toggling it changed its state in the tree'
    }
}

$search = Named 'Suche'
Check ($null -ne $search) 'the search field is there by name'
if ($null -ne $search) {
    Check ($search.Current.IsKeyboardFocusable) 'it can take the keyboard focus'
    $search.SetFocus()
    $focused = $false
    for ($i = 0; $i -lt 20 -and -not $focused; $i++) {
        Start-Sleep -Milliseconds 250
        $now = $AE::FocusedElement
        $focused = ($null -ne $now) -and ($now.Current.Name -eq 'Suche')
    }
    Check $focused 'moving the focus there worked, and the tree says so'
}

$status = Named 'Status'
Check ($null -ne $status) 'the status readout is there by name'

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host ("{0} check(s) failed" -f $failures.Count)
    exit 1
}
Write-Host 'all checks passed'
exit 0
