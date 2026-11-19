# Drives the real app the way a screen reader user does, through Windows UI Automation: finds things by
# name, opens a menu, chooses a tool, types into the search, shuts a menu with Escape.
# Windows PowerShell 5.1; ASCII only on purpose (5.1 reads a script without a BOM as ANSI).
#
#   powershell -NoProfile -File uia-app.ps1 -ProcessId <pid>
param([Parameter(Mandatory = $true)][int]$ProcessId, [string]$ShotDir = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
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

function Everything { $root.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }
function Named($pattern, $type) {
    foreach ($e in (Everything)) {
        if ($e.Current.Name -like $pattern) {
            if ($null -eq $type -or $e.Current.ControlType -eq $type) { return $e }
        }
    }
    return $null
}
# The tree answers with the next frame: ask until the thing is there, or give up.
function Wait-For($pattern, $type) {
    for ($i = 0; $i -lt 24; $i++) {
        $e = Named $pattern $type
        if ($null -ne $e) { return $e }
        Start-Sleep -Milliseconds 250
    }
    return $null
}
function Wait-Gone($pattern, $type) {
    for ($i = 0; $i -lt 24; $i++) {
        if ($null -eq (Named $pattern $type)) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}
# A picture of the whole screen, when asked for a folder to put it in.
function Shot($name) {
    if ($ShotDir -eq '') { return }
    Add-Type -AssemblyName System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $ShotDir $name))
}
function Invoke-It($e) {
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return $true }
    return $false
}

# The first question wakes the tree up.
$all = Everything
for ($i = 0; $i -lt 30 -and $all.Count -lt 10; $i++) { Start-Sleep -Milliseconds 500; $all = Everything }
Write-Host ("the tree has {0} elements" -f $all.Count)
Write-Host '--- what a screen reader sees at the start:'
foreach ($e in $all) {
    $r = $e.Current.BoundingRectangle
    Write-Host ("{0,-26} name='{1}' rect={2:N0},{3:N0} {4:N0}x{5:N0}" -f $e.Current.ControlType.ProgrammaticName, $e.Current.Name, $r.X, $r.Y, $r.Width, $r.Height)
}
Write-Host '---'

Check ($root.Current.Name -like 'Sondra*') 'the window is named Sondra'
Check ($null -ne (Named 'Sondra' $null)) 'the wordmark is read as Sondra'
Check ($null -ne (Named 'Datei ausw*hlen' $CT::Button)) 'the way in has its button'
Check ($null -ne (Named 'Von Adresse laden' $CT::Button)) 'and the other one'
foreach ($tab in @('Start', 'Merkliste', 'Ordner', 'Abspielen', 'Herunterladen')) {
    Check ($null -ne (Named $tab $CT::Button)) "the tab $tab is a button by name"
}

# The Merkliste: empty at first (the app was started on an empty data folder), a series typed in, the step
# forward, and the file on disk written to.
$merk = Named 'Merkliste' $CT::Button
if ($null -ne $merk) {
    Check (Invoke-It $merk) 'the tab Merkliste can be invoked'
    Check ($null -ne (Wait-For 'Noch nichts auf der Merkliste' $CT::Text)) 'an empty list says what to do'
    $type = Wait-For 'Eine Serie eintippen' $CT::Button
    Check ($null -ne $type) 'and offers to type a series in'
    if ($null -ne $type) {
        [void](Invoke-It $type)
        $name = Wait-For 'Name der neuen Serie' $CT::Edit
        Check ($null -ne $name) 'the field for the name is an edit by name'
        if ($null -ne $name) {
            $name.SetFocus()
            Start-Sleep -Milliseconds 600
            [System.Windows.Forms.SendKeys]::SendWait('Frieren{ENTER}')
            $line = Wait-For 'Frieren' $CT::ListItem
            Check ($null -ne $line) 'the typed series is a line of the list'
            if ($null -ne $line) {
                Check ($line.Current.HelpText -like 'Staffel 1, Folge 1.*') ('it stands at the first episode: ' + $line.Current.HelpText)
                $plus = Wait-For 'Staffel 1, Folge 1 von Frieren als gesehen markieren' $CT::Button
                Check ($null -ne $plus) 'the step forward is a button that says what it does'
                if ($null -ne $plus) {
                    Check (Invoke-It $plus) 'it can be invoked'
                    $moved = $false
                    for ($i = 0; $i -lt 24 -and -not $moved; $i++) {
                        $again = Named 'Frieren' $CT::ListItem
                        if ($null -ne $again -and $again.Current.HelpText -like 'Staffel 1, Folge 2.*') { $moved = $true } else { Start-Sleep -Milliseconds 250 }
                    }
                    Check $moved 'the line moved on to the second episode'
                }
            }
            Shot 'app-merkliste.png'
        }
    }
    $file = if ($env:SONDRA_DATA) { Join-Path $env:SONDRA_DATA 'Merkliste.sqlite' } else { '' }
    Check (($file -ne '') -and (Test-Path $file) -and ((Get-Item $file).Length -gt 4096)) 'the list was written to its file'
}

# A group of tabs is a menu: open it, find its tools, choose one.
$group = Named 'Ton' $CT::Button
Check ($null -ne $group) 'the group Ton is in the row'
if ($null -ne $group) {
    Check (Invoke-It $group) 'it can be invoked'
    $mix = Wait-For 'Mischen' $CT::MenuItem
    Check ($null -ne $mix) 'its menu appeared, with Mischen as a menu item'
    foreach ($tool in @('Spuren trennen', 'Lautst*rke', 'Zerschneiden', 'Tonart')) {
        Check ($null -ne (Named $tool $CT::MenuItem)) "the menu holds $tool"
    }
    if ($null -ne $mix) {
        Check (Invoke-It $mix) 'a menu item can be invoked'
        $heading = Wait-For 'Mischen' $CT::Text
        Check ($null -ne $heading) 'the tool opened: its heading is on the page'
        Check ($null -ne (Wait-For 'Ton * Mischen' $CT::Button)) 'the group names the tool chosen in it'
        Check (Wait-Gone 'Spuren trennen' $CT::MenuItem) 'the menu shut by the choice'
    }
}

# Back to the start, then the search by keyboard.
$start = Named 'Start' $CT::Button
if ($null -ne $start) { [void](Invoke-It $start) }
$field = Wait-For 'Werkzeuge durchsuchen' $CT::Edit
Check ($null -ne $field) 'the search field is an edit by name'
if ($null -ne $field) {
    $field.SetFocus()
    Start-Sleep -Milliseconds 600
    [System.Windows.Forms.SendKeys]::SendWait('ordner')
    $tile = Wait-For 'Ordner durchsehen*' $CT::Button
    Check ($null -ne $tile) 'typing into the search finds the tool'
    Check ($null -ne (Named 'Werkzeuge durchsuchen' $CT::Edit)) 'the field is still there'
}

# A menu shuts with Escape.
$bearbeiten = Named 'Bearbeiten' $CT::Button
if ($null -ne $bearbeiten) {
    [void](Invoke-It $bearbeiten)
    $item = Wait-For 'Umwandeln' $CT::MenuItem
    Check ($null -ne $item) 'another group opens its menu'
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    Check (Wait-Gone 'Umwandeln' $CT::MenuItem) 'Escape shuts it'
}

# Leave a menu open for the picture.
$group = Named 'Ton' $CT::Button
if ($null -ne $group) { [void](Invoke-It $group) }
Start-Sleep -Seconds 1

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host ("{0} check(s) failed" -f $failures.Count)
    exit 1
}
Write-Host 'all checks passed'
exit 0
