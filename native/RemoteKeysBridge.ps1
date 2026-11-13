#requires -Version 5.1
<#
  YouTube 遥控器本机助手（Windows PowerShell 5.1）

  - 读取 remote-keys.json，在系统级安装 WH_KEYBOARD_LL 键盘钩子。
  - 当前台软件的进程名/窗口标题匹配时，把配置中的单个遥控按键转发为目标快捷键。
  - 未匹配的按键、带 Ctrl/Alt/Shift/Win 的组合原样通过；助手自己发出的按键会被标记并忽略，
    遥控器或配套软件通过 SendInput 注入的按键仍会正常匹配。
  - 配置文件更新后约 1.5 秒自动重载；托盘菜单可暂停、重载、打开配置和日志。

  用法：
    powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File .\RemoteKeysBridge.ps1
    powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File .\RemoteKeysBridge.ps1 -Validate
    powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File .\RemoteKeysBridge.ps1 -Config D:\path\remote-keys.json
#>
[CmdletBinding()]
param(
  [string]$Config = "",
  [switch]$Validate
)

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Config) { $Config = Join-Path $scriptDir "remote-keys.json" }
$Config = [System.IO.Path]::GetFullPath($Config)
$logPath = Join-Path $scriptDir "remote-keys.log"

function Write-StartupLog {
  param([string]$Message)
  try {
    Add-Content -LiteralPath $logPath -Value "$([DateTime]::Now.ToString('HH:mm:ss'))  $Message" -Encoding UTF8
  } catch { }
}

Write-StartupLog "正在启动助手；配置：$Config"

Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace RemoteKeys
{
    public class ProfileSpec
    {
        public string Process = "";
        public string Title = "";
        public Dictionary<int, string> Bindings = new Dictionary<int, string>();
    }

    public static class Bridge
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_KEYUP = 0x0101;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_SYSKEYUP = 0x0105;
        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        // Marks events sent by this helper so the hook can ignore its own output without ignoring
        // remotes or companion software that emulate a keyboard through SendInput. The value is
        // deliberately arbitrary; dwExtraInfo is otherwise unused by keyboard input.
        private static readonly IntPtr InjectedMarker = (IntPtr)0x52454D4F5445;

        private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public INPUTUNION u;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);
        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        private static HookProc _proc;
        private static IntPtr _hook = IntPtr.Zero;
        private static ProfileSpec[] _profiles = new ProfileSpec[0];
        private static bool _enabled = true;
        private static readonly HashSet<int> Suppressed = new HashSet<int>();
        private static readonly ConcurrentQueue<string> Logs = new ConcurrentQueue<string>();
        private static readonly Dictionary<string, int> VkMap = BuildVkMap();

        public static int ProfileCount { get; private set; }

        public static void SetEnabled(bool enabled)
        {
            _enabled = enabled;
            Suppressed.Clear();
        }

        public static void Configure(bool enabled, List<ProfileSpec> profiles)
        {
            _enabled = enabled;
            _profiles = profiles == null ? new ProfileSpec[0] : profiles.ToArray();
            ProfileCount = _profiles.Length;
            Suppressed.Clear();
            Log("配置已加载：" + _profiles.Length + " 个软件；映射启用=" + enabled);
        }

        public static string[] DrainLogs()
        {
            var list = new List<string>();
            string line;
            while (Logs.TryDequeue(out line)) list.Add(line);
            return list.ToArray();
        }

        public static bool Start()
        {
            if (_hook != IntPtr.Zero) return true;
            _proc = HookCallback;
            _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
            if (_hook == IntPtr.Zero)
            {
                Log("安装键盘钩子失败，错误码 " + Marshal.GetLastWin32Error());
                return false;
            }
            Log("键盘钩子已安装");
            return true;
        }

        public static void Stop()
        {
            if (_hook == IntPtr.Zero) return;
            UnhookWindowsHookEx(_hook);
            _hook = IntPtr.Zero;
            Suppressed.Clear();
            Log("键盘钩子已卸载");
        }

        private static void Log(string text)
        {
            Logs.Enqueue(DateTime.Now.ToString("HH:mm:ss") + "  " + text);
            while (Logs.Count > 400)
            {
                string ignored;
                Logs.TryDequeue(out ignored);
            }
        }

        private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0)
                {
                    KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    // Ignore only our own forwarded keys. Software remotes send injected events too.
                    if (data.dwExtraInfo != InjectedMarker)
                    {
                        int vk = (int)data.vkCode;
                        int message = wParam.ToInt32();
                        if (message == WM_KEYUP || message == WM_SYSKEYUP)
                        {
                            if (Suppressed.Remove(vk)) return (IntPtr)1;
                        }
                        else if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)
                        {
                            if (Suppressed.Contains(vk)) return (IntPtr)1;
                            string target;
                            if (TryResolve(vk, out target))
                            {
                                Suppressed.Add(vk);
                                SendChord(target);
                                return (IntPtr)1;
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                // An exception escaping a native hook callback would terminate the process.
                Log("钩子处理异常：" + ex.Message);
            }
            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        private static bool TryResolve(int vk, out string target)
        {
            target = null;
            if (!_enabled || _profiles.Length == 0) return false;
            if (ModifierDown()) return false;
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return false;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            string process = "";
            try { process = Process.GetProcessById((int)pid).ProcessName; } catch { }
            string title = WindowTitle(hwnd);
            foreach (ProfileSpec profile in _profiles)
            {
                if (!MatchProcess(profile.Process, process)) continue;
                if (!string.IsNullOrEmpty(profile.Title) &&
                    title.IndexOf(profile.Title, StringComparison.OrdinalIgnoreCase) < 0) continue;
                string found;
                if (profile.Bindings.TryGetValue(vk, out found))
                {
                    target = found;
                    Log("匹配 " + (profile.Process.Length > 0 ? profile.Process : profile.Title) +
                        "：" + CodeName(vk) + " -> " + target + "（" +
                        (process.Length > 0 ? process : "?") + " / " + title + "）");
                    return true;
                }
                // First matching profile wins, even for keys it does not map: later profiles must not
                // unexpectedly take over a key meant to pass through.
                return false;
            }
            return false;
        }

        private static string WindowTitle(IntPtr hwnd)
        {
            var text = new StringBuilder(1024);
            GetWindowText(hwnd, text, text.Capacity);
            return text.ToString();
        }

        private static bool MatchProcess(string expected, string actual)
        {
            expected = (expected ?? "").Trim();
            if (expected.Length == 0) return true;
            try { expected = Path.GetFileName(expected); } catch { }
            string wanted = expected;
            if (wanted.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                wanted = wanted.Substring(0, wanted.Length - 4);
            string name = (actual ?? "").Trim();
            if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                name = name.Substring(0, name.Length - 4);
            return string.Equals(wanted, name, StringComparison.OrdinalIgnoreCase);
        }

        private static bool ModifierDown()
        {
            // Only plain remote keys are intercepted. Alt+Tab, Ctrl+C and similar chords stay native.
            return Down(0x11) || Down(0x12) || Down(0x10) || Down(0x5B) || Down(0x5C);
        }

        private static bool Down(int vk)
        {
            return (GetAsyncKeyState(vk) & 0x8000) != 0;
        }

        private static void SendChord(string chord)
        {
            if (string.IsNullOrEmpty(chord)) return;
            string[] parts = chord.Split('+');
            var modifiers = new List<int>();
            for (int i = 0; i < parts.Length - 1; i++)
            {
                switch (parts[i].Trim())
                {
                    case "Ctrl": modifiers.Add(0x11); break;
                    case "Alt": modifiers.Add(0x12); break;
                    case "Shift": modifiers.Add(0x10); break;
                    case "Meta": modifiers.Add(0x5B); break;
                }
            }
            int key = VkFromCode(parts[parts.Length - 1].Trim());
            if (key == 0)
            {
                Log("无法识别的目标快捷键：" + chord);
                return;
            }
            var inputs = new List<INPUT>();
            foreach (int mod in modifiers) inputs.Add(KeyInput(mod, false, false));
            bool extended = IsExtended(key);
            inputs.Add(KeyInput(key, false, extended));
            inputs.Add(KeyInput(key, true, extended));
            for (int i = modifiers.Count - 1; i >= 0; i--) inputs.Add(KeyInput(modifiers[i], true, false));
            INPUT[] array = inputs.ToArray();
            uint sent = SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(INPUT)));
            if (sent != array.Length) Log("SendInput 只发送了 " + sent + "/" + array.Length + " 个事件");
        }

        private static INPUT KeyInput(int vk, bool up, bool extended)
        {
            var input = new INPUT();
            input.type = 1; // INPUT_KEYBOARD
            input.u.ki = new KEYBDINPUT();
            input.u.ki.wVk = (ushort)vk;
            input.u.ki.wScan = 0;
            input.u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
            input.u.ki.time = 0;
            input.u.ki.dwExtraInfo = InjectedMarker;
            return input;
        }

        private static bool IsExtended(int vk)
        {
            return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x2F ||
                   vk == 0x90 || vk == 0x6F || vk == 0xA3 || vk == 0xA5;
        }

        public static bool IsSupportedTarget(string chord)
        {
            if (string.IsNullOrEmpty(chord)) return false;
            string[] parts = chord.Split('+');
            var seen = new HashSet<string>();
            for (int i = 0; i < parts.Length - 1; i++)
            {
                string mod = parts[i].Trim();
                if (mod != "Ctrl" && mod != "Alt" && mod != "Shift" && mod != "Meta") return false;
                if (!seen.Add(mod)) return false;
            }
            return VkFromCode(parts[parts.Length - 1].Trim()) != 0;
        }

        public static int VkFromCode(string code)
        {
            if (string.IsNullOrEmpty(code)) return 0;
            code = code.Trim();
            if (code.Length == 1)
            {
                char c = char.ToUpperInvariant(code[0]);
                if (c >= 'A' && c <= 'Z') return 0x41 + (c - 'A');
                if (c >= '0' && c <= '9') return 0x30 + (c - '0');
            }
            if (code.StartsWith("Key", StringComparison.OrdinalIgnoreCase) && code.Length == 4)
            {
                char c = char.ToUpperInvariant(code[3]);
                if (c >= 'A' && c <= 'Z') return 0x41 + (c - 'A');
            }
            if (code.StartsWith("Digit", StringComparison.OrdinalIgnoreCase) && code.Length == 6)
            {
                char c = code[5];
                if (c >= '0' && c <= '9') return 0x30 + (c - '0');
            }
            int f;
            if (code.Length >= 2 && char.ToUpperInvariant(code[0]) == 'F' &&
                int.TryParse(code.Substring(1), out f) && f >= 1 && f <= 24)
                return 0x70 + (f - 1);
            int result;
            if (VkMap.TryGetValue(code, out result)) return result;
            return 0;
        }

        private static string CodeName(int vk)
        {
            foreach (KeyValuePair<string, int> pair in VkMap)
                if (pair.Value == vk) return pair.Key;
            if (vk >= 0x41 && vk <= 0x5A) return "Key" + (char)vk;
            if (vk >= 0x30 && vk <= 0x39) return "Digit" + (char)vk;
            if (vk >= 0x70 && vk <= 0x87) return "F" + (vk - 0x70 + 1);
            return "VK_" + vk.ToString("X2");
        }

        private static Dictionary<string, int> BuildVkMap()
        {
            var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            map["Backspace"] = 0x08; map["Tab"] = 0x09; map["Enter"] = 0x0D; map["Escape"] = 0x1B;
            map["Space"] = 0x20; map["PageUp"] = 0x21; map["PageDown"] = 0x22; map["End"] = 0x23;
            map["Home"] = 0x24; map["ArrowLeft"] = 0x25; map["ArrowUp"] = 0x26; map["ArrowRight"] = 0x27;
            map["ArrowDown"] = 0x28; map["PrintScreen"] = 0x2C; map["Insert"] = 0x2D; map["Delete"] = 0x2E;
            map["CapsLock"] = 0x14; map["NumLock"] = 0x90; map["ScrollLock"] = 0x91; map["Pause"] = 0x13;
            map["Backquote"] = 0xC0; map["Minus"] = 0xBD; map["Equal"] = 0xBB; map["BracketLeft"] = 0xDB;
            map["BracketRight"] = 0xDD; map["Backslash"] = 0xDC; map["Semicolon"] = 0xBA; map["Quote"] = 0xDE;
            map["Comma"] = 0xBC; map["Period"] = 0xBE; map["Slash"] = 0xBF;
            map["Numpad0"] = 0x60; map["Numpad1"] = 0x61; map["Numpad2"] = 0x62; map["Numpad3"] = 0x63;
            map["Numpad4"] = 0x64; map["Numpad5"] = 0x65; map["Numpad6"] = 0x66; map["Numpad7"] = 0x67;
            map["Numpad8"] = 0x68; map["Numpad9"] = 0x69;
            map["NumpadMultiply"] = 0x6A; map["NumpadAdd"] = 0x6B; map["NumpadSubtract"] = 0x6D;
            map["NumpadDecimal"] = 0x6E; map["NumpadDivide"] = 0x6F;
            map["AudioVolumeMute"] = 0xAD; map["AudioVolumeDown"] = 0xAE; map["AudioVolumeUp"] = 0xAF;
            map["MediaTrackNext"] = 0xB0; map["MediaTrackPrevious"] = 0xB1; map["MediaStop"] = 0xB2;
            map["MediaPlayPause"] = 0xB3;
            map["BrowserBack"] = 0xA6; map["BrowserForward"] = 0xA7; map["BrowserRefresh"] = 0xA8;
            map["BrowserStop"] = 0xA9; map["BrowserSearch"] = 0xAA; map["BrowserFavorites"] = 0xAB;
            map["BrowserHome"] = 0xAC;
            return map;
        }
    }
}
'@

Write-StartupLog "内嵌 C# 已编译"

function Read-BridgeConfig {
  param([string]$Path)
  Write-StartupLog "读取配置：[$Path]"
  if (-not (Test-Path -LiteralPath $Path)) { throw "找不到配置文件：$Path" }
  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if (-not $raw -or -not $raw.Trim()) { throw "配置文件为空。" }
  try { $data = $raw | ConvertFrom-Json } catch { throw "JSON 解析失败：$($_.Exception.Message)" }
  if ($null -eq $data) { throw "配置文件内容无效。" }

  $profiles = New-Object 'System.Collections.Generic.List[RemoteKeys.ProfileSpec]'
  $warnings = New-Object 'System.Collections.Generic.List[string]'
  $count = 0
  $profileNumber = 0
  foreach ($item in @($data.profiles)) {
    $profileNumber++
    if ($null -eq $item) { continue }
    $label = [string]$item.name
    if (-not $label) { $label = [string]$item.process }
    if (-not $label) { $label = [string]$item.title }
    if (-not $label) { $label = "配置 $profileNumber" }

    $spec = New-Object RemoteKeys.ProfileSpec
    $spec.Process = [string]$item.process
    $spec.Title = [string]$item.title
    $spec.Bindings = New-Object 'System.Collections.Generic.Dictionary[int,string]'

    $bindingNumber = 0
    foreach ($row in @($item.bindings)) {
      $bindingNumber++
      if ($null -eq $row) { continue }
      $source = ([string]$row.source).Trim()
      $target = ([string]$row.target).Trim()
      if (-not $source -or -not $target) { continue }
      $vk = [RemoteKeys.Bridge]::VkFromCode($source)
      if ($vk -le 0) {
        $warnings.Add("$label 第 $bindingNumber 行：不支持的遥控按键 $source")
        continue
      }
      if (-not [RemoteKeys.Bridge]::IsSupportedTarget($target)) {
        $warnings.Add("$label 第 $bindingNumber 行：不支持的目标快捷键 $target")
        continue
      }
      if ([string]::Equals($source, $target, [System.StringComparison]::OrdinalIgnoreCase)) {
        $warnings.Add("$label 第 $bindingNumber 行：不能映射到自身，已忽略")
        continue
      }
      if ($spec.Bindings.ContainsKey($vk)) {
        $warnings.Add("$label 中遥控按键 $source 重复，后一条已忽略")
        continue
      }
      $spec.Bindings[$vk] = $target
      $count++
    }

    if ($spec.Bindings.Count -gt 0) { $profiles.Add($spec) }
    elseif ($item.enabled -ne $false) { $warnings.Add("$label 没有有效映射，已忽略") }
  }

  $enabled = $true
  if ($null -ne $data.enabled) { $enabled = ($data.enabled -ne $false) }
  [pscustomobject]@{
    Enabled = $enabled
    Profiles = $profiles
    Count = $count
    Warnings = $warnings
  }
}

function Open-WithNotepad {
  param([string]$Path)
  Start-Process -FilePath "notepad.exe" -ArgumentList ("`"" + $Path + "`"")
}

if ($Validate) {
  try {
    $checked = Read-BridgeConfig -Path $Config
    Write-Host "配置有效：$($checked.Profiles.Count) 个软件，$($checked.Count) 条映射。"
    foreach ($warning in $checked.Warnings) { Write-Warning $warning }
    exit 0
  } catch {
    [Console]::Error.WriteLine("配置无效：" + $_.Exception.Message)
    exit 1
  }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$mutex = New-Object System.Threading.Mutex($false, "Local\YouTubeRemoteKeysBridge")
$mutexOwned = $false
try { $mutexOwned = $mutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $mutexOwned = $true }
if (-not $mutexOwned) {
  Write-StartupLog "已有另一个助手实例在运行，本次退出。"
  [System.Windows.Forms.MessageBox]::Show("遥控器本机助手已在运行。`n`n可以在系统托盘中找到它。",
    "YouTube 遥控器", "OK", "Information") | Out-Null
  exit 0
}

$script:bridgeConfig = $null
$script:configStamp = ""
$script:paused = $false

function Get-ConfigStamp {
  if (-not (Test-Path -LiteralPath $Config)) { return "missing" }
  $file = Get-Item -LiteralPath $Config
  return $file.LastWriteTimeUtc.Ticks.ToString() + ":" + $file.Length
}

function Update-Tray {
  if ($null -eq $notify) { return }
  if ($script:paused) {
    $statusItem.Text = "状态：已暂停"
    $toggleItem.Text = "恢复映射"
    $notify.Text = "YouTube 遥控器助手（已暂停）"
  } elseif ($null -ne $script:bridgeConfig -and -not $script:bridgeConfig.Enabled) {
    $statusItem.Text = "状态：配置已停用"
    $toggleItem.Text = "暂停映射"
    $notify.Text = "YouTube 遥控器助手（配置停用）"
  } else {
    $statusItem.Text = "状态：已启用（$([RemoteKeys.Bridge]::ProfileCount) 个软件）"
    $toggleItem.Text = "暂停映射"
    $notify.Text = "YouTube 遥控器助手"
  }
}

function Write-BridgeLog {
  param([string[]]$Lines)
  if (-not $Lines -or $Lines.Length -eq 0) { return }
  try { Add-Content -LiteralPath $logPath -Value $Lines -Encoding UTF8 } catch { }
}

function Reload-BridgeConfig {
  try {
    $next = Read-BridgeConfig -Path $Config
    $script:bridgeConfig = $next
    $script:configStamp = Get-ConfigStamp
    [RemoteKeys.Bridge]::Configure(($next.Enabled -and -not $script:paused), $next.Profiles)
    Update-Tray
    $message = "配置已重新加载：$($next.Profiles.Count) 个软件，$($next.Count) 条映射。"
    Write-BridgeLog @("$([DateTime]::Now.ToString('HH:mm:ss'))  $message")
    foreach ($warning in $next.Warnings) { Write-BridgeLog @("$([DateTime]::Now.ToString('HH:mm:ss'))  警告：$warning") }
    $notify.ShowBalloonTip(3000, "YouTube 遥控器助手", $message, [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    $message = "配置加载失败：" + $_.Exception.Message
    Write-BridgeLog @("$([DateTime]::Now.ToString('HH:mm:ss'))  $message")
    $notify.ShowBalloonTip(5000, "配置加载失败", $_.Exception.Message, [System.Windows.Forms.ToolTipIcon]::Error)
  }
}

try {
  $script:bridgeConfig = Read-BridgeConfig -Path $Config
  Write-StartupLog "配置已读取：$($script:bridgeConfig.Profiles.Count) 个软件，$($script:bridgeConfig.Count) 条映射。"
  foreach ($warning in $script:bridgeConfig.Warnings) { Write-StartupLog "警告：$warning" }
} catch {
  Write-StartupLog "无法加载配置：$($_.Exception.Message)"
  [System.Windows.Forms.MessageBox]::Show("无法加载配置：`n$($_.Exception.Message)`n`n$Config",
    "YouTube 遥控器", "OK", "Error") | Out-Null
  $mutex.ReleaseMutex()
  $mutex.Dispose()
  exit 1
}
$script:configStamp = Get-ConfigStamp

[RemoteKeys.Bridge]::Configure($script:bridgeConfig.Enabled, $script:bridgeConfig.Profiles)
if (-not [RemoteKeys.Bridge]::Start()) {
  Write-StartupLog "无法安装键盘钩子。"
  [System.Windows.Forms.MessageBox]::Show("无法安装键盘钩子。`n`n请尝试以管理员身份运行，或检查安全软件是否拦截。",
    "YouTube 遥控器", "OK", "Error") | Out-Null
  $mutex.ReleaseMutex()
  $mutex.Dispose()
  exit 1
}
Write-StartupLog "键盘钩子已安装。"

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = "YouTube 遥控器助手"
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Text = "状态：已启用"
$statusItem.Enabled = $false
$toggleItem = New-Object System.Windows.Forms.ToolStripMenuItem
$toggleItem.Text = "暂停映射"
$reloadItem = New-Object System.Windows.Forms.ToolStripMenuItem
$reloadItem.Text = "重新加载配置"
$openConfigItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openConfigItem.Text = "打开配置文件"
$openLogItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openLogItem.Text = "打开日志"
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = "退出"
[void]$menu.Items.Add($statusItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($toggleItem)
[void]$menu.Items.Add($reloadItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($openConfigItem)
[void]$menu.Items.Add($openLogItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($exitItem)
$notify.ContextMenuStrip = $menu
$notify.Visible = $true
$notify.Add_DoubleClick({ $notify.ShowBalloonTip(2000, "YouTube 遥控器助手", $statusItem.Text, [System.Windows.Forms.ToolTipIcon]::Info) })

$toggleItem.Add_Click({
  $script:paused = -not $script:paused
  [RemoteKeys.Bridge]::SetEnabled(($script:bridgeConfig.Enabled -and -not $script:paused))
  Update-Tray
  Write-BridgeLog @("$([DateTime]::Now.ToString('HH:mm:ss'))  映射" + $(if ($script:paused) { "已暂停" } else { "已恢复" }))
})
$reloadItem.Add_Click({ Reload-BridgeConfig })
$openConfigItem.Add_Click({ Open-WithNotepad -Path $Config })
$openLogItem.Add_Click({
  if (Test-Path -LiteralPath $logPath) { Open-WithNotepad -Path $logPath }
  else { $notify.ShowBalloonTip(2000, "暂无日志", "还没有触发过映射。", [System.Windows.Forms.ToolTipIcon]::Info) }
})
$exitItem.Add_Click({
  $timer.Stop()
  [RemoteKeys.Bridge]::Stop()
  $notify.Visible = $false
  [System.Windows.Forms.Application]::ExitThread()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.Add_Tick({
  $pending = [RemoteKeys.Bridge]::DrainLogs()
  if ($pending.Length -gt 0) { Write-BridgeLog $pending }
  $stamp = Get-ConfigStamp
  if ($stamp -ne $script:configStamp) {
    $script:configStamp = $stamp
    Reload-BridgeConfig
  }
})
$timer.Start()

Update-Tray
Write-BridgeLog @("$([DateTime]::Now.ToString('HH:mm:ss'))  助手已启动；配置：$Config")
Write-BridgeLog @("$([DateTime]::Now.ToString('HH:mm:ss'))  设置文件：$Config")

$context = New-Object System.Windows.Forms.ApplicationContext
Write-StartupLog "托盘与消息循环已启动。"
try {
  [System.Windows.Forms.Application]::Run($context)
} finally {
  $timer.Stop()
  [RemoteKeys.Bridge]::Stop()
  $notify.Visible = $false
  $notify.Dispose()
  $timer.Dispose()
  if ($mutexOwned) { try { $mutex.ReleaseMutex() } catch { } }
  $mutex.Dispose()
}
