param([ValidateSet('Inspect','Hide')][string]$Mode = 'Inspect')
$ErrorActionPreference = 'Stop'
$resultPath = 'C:/Users/showp/.code-ai/remote-agent/window-control/result.json'
if ($env:COMPUTERNAME -ne 'ME' -or $env:USERNAME -ne 'showp') { exit 41 }
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CodeAiConsoleControl {
 public delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int command);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint id);
 [DllImport("kernel32.dll")] public static extern bool FreeConsole();
 [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern bool SetConsoleTitle(string title);
}
'@
$processes = @(Get-CimInstance Win32_Process)
$runner = @($processes | Where-Object {
 $_.Name -eq 'node.exe' -and $_.CommandLine -like '*remote-agent/releases/20261008-v1/runner.mjs*'
})
if ($runner.Count -ne 1) { exit 42 }
$rootPid = $runner[0].ProcessId
$consoleHandle = [IntPtr]::Zero
$attached = $false
$marker = 'CodeAI ME background agent ' + $rootPid
[void][CodeAiConsoleControl]::FreeConsole()
try {
 $attached = [CodeAiConsoleControl]::AttachConsole($rootPid)
 if ($attached) {
  $consoleHandle = [CodeAiConsoleControl]::GetConsoleWindow()
  if ($Mode -eq 'Hide') {
   [void][CodeAiConsoleControl]::SetConsoleTitle($marker)
   if ($consoleHandle -ne [IntPtr]::Zero) {
    [void][CodeAiConsoleControl]::ShowWindowAsync($consoleHandle,0)
   }
  }
 }
} finally {
 if ($attached) { [void][CodeAiConsoleControl]::FreeConsole() }
}
if ($Mode -eq 'Hide') { Start-Sleep -Milliseconds 800 }
$windows = New-Object Collections.Generic.List[object]
[CodeAiConsoleControl]::EnumWindows({param($handle,$unused)
 if ([CodeAiConsoleControl]::IsWindowVisible($handle)) {
  $class = New-Object Text.StringBuilder 200
  [void][CodeAiConsoleControl]::GetClassName($handle,$class,200)
  if ($class.ToString() -match 'ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS') {
   $title = New-Object Text.StringBuilder 1000
   [void][CodeAiConsoleControl]::GetWindowText($handle,$title,1000)
   [uint32]$owner = 0
   [void][CodeAiConsoleControl]::GetWindowThreadProcessId($handle,[ref]$owner)
   $process = $processes | Where-Object ProcessId -eq $owner | Select-Object -First 1
   $isAgent = $title.ToString().Contains($marker)
   $hidden = $false
   $tabs = $null
   if ($Mode -eq 'Hide' -and $isAgent) {
    if ($class.ToString() -eq 'CASCADIA_HOSTING_WINDOW_CLASS') {
     try {
      Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
      $element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
      $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)
      $tabs = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition).Count
     } catch { $tabs = -1 }
    } else { $tabs = 1 }
    # Do not hide a shared terminal containing other user tabs.
    if ($tabs -eq 1) {
     [void][CodeAiConsoleControl]::ShowWindowAsync($handle,0)
     Start-Sleep -Milliseconds 100
     $hidden = ![CodeAiConsoleControl]::IsWindowVisible($handle)
    }
   }
   $windows.Add([pscustomobject]@{
    handle=$handle.ToInt64(); ownerPid=$owner; ownerName=$process.Name;
    className=$class.ToString(); agentWindow=$isAgent; hidden=$hidden;
    terminalTabs=$tabs; titleIsNode=($title.ToString() -match 'node');
    titleIsSsh=($title.ToString() -match 'ssh');
   })
  }
 }
 return $true
},[IntPtr]::Zero) | Out-Null
$result = [pscustomobject]@{
 mode=$Mode; probeSessionId=(Get-Process -Id $PID).SessionId;
 agentPid=$rootPid; attached=$attached; consoleHandle=$consoleHandle.ToInt64();
 ownConsoleVisible=($consoleHandle -ne [IntPtr]::Zero -and [CodeAiConsoleControl]::IsWindowVisible($consoleHandle));
 windows=$windows.ToArray(); agentAlive=[bool](Get-Process -Id $rootPid -ErrorAction SilentlyContinue)
}
$result | ConvertTo-Json -Depth 7 -Compress | Set-Content -LiteralPath $resultPath -Encoding UTF8
