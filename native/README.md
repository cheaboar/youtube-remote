# Windows 本机助手

遥控器可以控制 YouTube，但浏览器扩展不能向其他 Windows 程序发送按键。这个助手补上这一段：它读取扩展设置页导出的 `remote-keys.json`，在当前前台软件匹配时，把遥控按键转换成该软件的快捷键。

适用于 PotPlayer / VLC / mpv 等播放器、PowerPoint / WPS 演示、Spotify 等音乐软件、抖音电脑版，以及任何接受键盘快捷键的 Windows 程序。

## 要求

- Windows 10 / 11。
- Windows PowerShell 5.1（系统自带）。请用 `powershell.exe` 运行，不要用 PowerShell 7 的 `pwsh.exe`；脚本依赖 .NET Framework 的 WinForms 与 `Add-Type` 行为。
- 通常不需要管理员权限。目标软件以管理员身份运行时，助手也需要以管理员身份运行，否则 Windows 会阻止模拟按键。

## 安装与启动

1. 在扩展设置页打开「Windows 软件快捷键」，添加软件配置并保存。抖音电脑版可直接点「添加抖音电脑版」生成预设，再按需修改目标快捷键。
2. 点击「下载 remote-keys.json」，把文件放到本目录（与 `RemoteKeysBridge.ps1` 同目录）。也可以复制 `remote-keys.example.json` 为 `remote-keys.json` 后手动修改。
3. 双击 `start-remote-keys.cmd` 启动（保留控制台窗口，便于看错误），或双击 `start-remote-keys-hidden.vbs` 隐藏窗口启动。启动后系统托盘会出现助手图标。
4. 切换到一个已配置的软件，按映射中的遥控按键。配置文件修改后约 1.5 秒自动重载，也可以右键托盘图标选择「重新加载配置」。

首次启动时会检查配置；配置无效或无法安装键盘钩子会弹出错误框并退出。

### 托盘菜单

- **状态 / 暂停映射**：临时停用全部转发，不退出助手。
- **重新加载配置**：立即重读 `remote-keys.json`，不必重启。
- **打开配置文件 / 打开日志**：用记事本打开。
- **退出**：卸载键盘钩子并退出。

### 开机自启

在「运行」中输入 `shell:startup` 打开启动文件夹，把 `start-remote-keys-hidden.vbs` 的**快捷方式**放进去。不要直接复制脚本，避免工作目录不同。

## 配置格式

```json
{
  "version": 1,
  "enabled": true,
  "profiles": [
    {
      "name": "PotPlayer",
      "process": "PotPlayerMini64.exe",
      "title": "",
      "bindings": [
        { "source": "ArrowRight", "target": "Ctrl+ArrowRight" },
        { "source": "ArrowUp", "target": "AudioVolumeUp" },
        { "source": "Enter", "target": "Space" }
      ]
    }
  ]
}
```

设置页会生成此文件；`version` 和 `generatedAt` 仅作标记，助手不依赖它们。

### 软件配置

- `process`：进程名，大小写不敏感，`.exe` 可省略；也可写完整路径，助手只取文件名。任务管理器 →「详细信息」可查看，例如 `PotPlayerMini64.exe`、`vlc.exe`、`POWERPNT.EXE`、`wpp.exe`（WPS 演示）。
- `title`：可选的窗口标题子串，大小写不敏感，用于区分同一软件的不同窗口（例如只匹配标题包含「影片」的窗口）。
- `process` 和 `title` 都留空表示**全局配置**：匹配所有前台窗口。请谨慎使用，尤其不要让它拦截浏览器里的按键。设置页最多允许一个全局配置。
- 多个配置同时匹配时，**按文件中的顺序取第一个**。第一个匹配配置中没有列出的按键会原样通过，不会继续尝试后面的配置。
- 设置页中取消勾选的配置不会写入导出文件。

### 抖音电脑版预设

在设置页点击「添加抖音电脑版」会插入一个匹配 `douyin.exe` 的配置（前台窗口的进程名就是 `douyin.exe`，`douyin_guard` 是后台守护进程，不需要匹配）：

| 遥控按键 | 转发为 | 作用 |
| --- | --- | --- |
| 确认（`Enter`） | `Space` | 播放 / 暂停 |
| `Home` | `KeyZ` | 点赞 |
| `PageUp` | `ArrowUp` | 上一条视频 |
| `PageDown` | `ArrowDown` | 下一条视频 |

方向键不能映射到自身，因此预设用 `Home` / `PageUp` / `PageDown` 作为来源键。抖音客户端各版本的快捷键可能不同，以客户端内「快捷键设置」为准；若默认值不一致，直接在设置页改「目标快捷键」再重新导出即可（例如评论键改为 `KeyX` 或 `KeyC`）。

确认键会被转发成空格，所以在评论框、搜索框里按确认只会插入一个空格；需要正常打字时，右键托盘图标选择「暂停映射」。

### 按键名

`source`（遥控按键）必须是单个按键，不能带修饰键。使用浏览器 `KeyboardEvent.code` 名称：

| 类别 | 名称 |
| --- | --- |
| 方向 / 编辑 | `ArrowUp` `ArrowDown` `ArrowLeft` `ArrowRight` `Home` `End` `PageUp` `PageDown` `Insert` `Delete` `Backspace` `Tab` `Enter` `Escape` `Space` |
| 字母 / 数字 | `KeyA`–`KeyZ`、`Digit0`–`Digit9` |
| 功能键 | `F1`–`F24` |
| 符号 | `Backquote` `Minus` `Equal` `BracketLeft` `BracketRight` `Backslash` `Semicolon` `Quote` `Comma` `Period` `Slash` |
| 小键盘 | `Numpad0`–`Numpad9` `NumpadMultiply` `NumpadAdd` `NumpadSubtract` `NumpadDecimal` `NumpadDivide` |
| 媒体 | `AudioVolumeMute` `AudioVolumeDown` `AudioVolumeUp` `MediaTrackNext` `MediaTrackPrevious` `MediaStop` `MediaPlayPause` |
| 浏览器 | `BrowserBack` `BrowserForward` `BrowserRefresh` `BrowserStop` `BrowserSearch` `BrowserFavorites` `BrowserHome` |
| 锁定 | `CapsLock` `NumLock` `ScrollLock` `PrintScreen` `Pause` |

`target`（目标快捷键）由可选的修饰键和**一个**按键组成：

- 修饰键：`Ctrl`、`Alt`、`Shift`、`Meta`（Meta 即 Win 键）。每种最多一次，顺序任意；扩展导出的顺序为 `Ctrl+Alt+Shift+Meta`。
- 最后一段是上表中的按键名，也接受单个字母 / 数字（如 `A`、`5`）和 `F1`–`F24`。
- 示例：`Ctrl+Shift+KeyS`、`Alt+F4`、`PageDown`、`AudioVolumeUp`、`MediaPlayPause`。
- 按键名大小写不敏感；修饰键请写 `Ctrl`、`Alt`、`Shift`、`Meta`（区分大小写）。助手不展开 `Ctrl+S` 这类缩写，请写 `Ctrl+KeyS`。

设置页的「录制目标」会生成规范写法；浏览器占用的组合（如 `Ctrl+W`）可能录不到，直接在输入框填写即可。

## 行为细节

- 只拦截配置中列出的遥控按键，且只在匹配配置的软件位于前台时拦截。
- 物理按住 Ctrl / Alt / Shift / Win 时，所有映射都不触发，避免和 Alt+Tab、Ctrl+C 等系统组合冲突。
- 匹配键的按下和抬起都会被拦截，长按产生的重复按下也被吞掉；每次按下只转发一次目标快捷键，不会连发。
- 助手自己通过 `SendInput` 发出的按键会带上专用标记并被忽略，不会形成循环。遥控器接收器或配套软件通过 `SendInput` 模拟的按键（`LLKHF_INJECTED`）不带有这个标记，仍会正常匹配；这一点对用软件模拟键盘的遥控器很重要。
- 方向、编辑、小键盘除号等按键会带扩展键标志发送，保证在目标程序中按预期工作。
- 目标按键按下后会先释放目标键，再按相反顺序释放修饰键。

## 安全与隐私

- 键盘钩子是系统级能力，能看到所有前台按键。助手源码完全可见，可自行审计：
  - 只在内存中比较按键与配置；
  - 不记录普通按键，不读取输入文字；
  - 日志只记录**已触发**的映射，包括软件名、窗口标题和转发结果；
  - 不联网，不使用 `WebRequest`、套接字或外部程序。
- `remote-keys.log` 是明文日志，可能包含窗口标题。如介意，可退出助手后删除该文件。
- 安全软件可能对键盘钩子报警。这是该类工具的常见行为；如不信任，不要运行。
- 以管理员身份运行助手会扩大它能控制的范围，请只在确有需要时这样做。

## 限制

- UAC 安全桌面、登录界面、锁定屏幕上的按键无法拦截。
- 管理员权限窗口不接受普通权限助手发送的按键（UIPI）。请以相同或更高权限启动助手。
- 使用反作弊或主动阻止模拟输入的游戏可能不响应。
- 部分遥控器把音量 / 播放键作为多媒体键发送，部分作为普通键盘按键发送；可在扩展设置页的「遥控器诊断」中查看实际 `code`，再填入映射。
- 输入法、粘滞键、筛选键等系统辅助功能可能改变按键事件。
- 只支持前台窗口，不区分同一程序的不同标签页或子窗口的键盘焦点；需要区分时请使用窗口标题子串。

## 验证与排错

不安装钩子，只检查配置和 C# 编译：

```powershell
powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File .\RemoteKeysBridge.ps1 -Config .\remote-keys.example.json -Validate
```

有效时输出配置的软件数量与映射数量；不支持的按键、重复按键、映射到自身的行会给出警告。配置不存在或 JSON 无效时退出码为 1。

指定其他配置文件：

```powershell
powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File .\RemoteKeysBridge.ps1 -Config D:\path\remote-keys.json
```

常用排查顺序：

1. 托盘图标是否存在，菜单状态是否为「已启用」。
2. 前台窗口的进程名是否完全匹配（任务管理器 →「详细信息」；WPS 演示是 `wpp.exe`）。
3. 是否避开了全局配置、修饰键按住和浏览器窗口。
4. 查看 `remote-keys.log`；触发成功时会写入 `匹配 …：ArrowUp -> AudioVolumeUp（进程 / 标题）`。
5. 用 `-Validate` 检查 JSON 与按键名。
6. 目标软件以管理员身份运行时，以管理员身份启动助手。
