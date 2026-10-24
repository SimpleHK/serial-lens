# VS Code 串口监视扩展特性版图调研

2026-10-25 由后台调研代理对照 marketplace / GitHub 一手来源整理。作为 spec 阶段的输入。

## 核心结论

- **逐行标签高亮：四个扩展都没有**。这是本项目真正的空白点。
- 过滤（include/exclude）与滚动冻结：只有小体量的 FancyMon 提供（951 安装），头部扩展均无。
- Microsoft 官方扩展有长期性能问题（#235 等，归档时未解决）——本项目架构需避开同类陷阱。

## 特性对照表

| 特性 | Microsoft | Eclipse CDT | PlatformIO | FancyMon |
|---|---|---|---|---|
| 端口选择 | Yes | Yes（对话框/WebSerial） | Yes（`monitor_port`） | Yes |
| 波特率 + 自定义 | Yes（`customBaudRates`） | Yes | Yes（`monitor_speed`） | Yes（至 2 Mbps） |
| 数据位/校验/停止位 | Yes | 未文档化 | Yes（含 RTS/DTR） | Yes |
| 行尾配置 | Yes | 未文档化 | Yes（`monitor_eol`） | 未文档化 |
| 发送输入 | Yes | 未文档化（有 API） | Yes（`send_on_enter`） | 未文档化 |
| 时间戳 | Yes（收发均有） | 未文档化 | Yes（`time` filter） | 未文档化 |
| TCP 监视 | Yes（含 SWO） | 未文档化 | No | 未文档化 |
| 多监视器并存 | Yes（上限 3） | 每端口一视图 | 每终端一个 | 未文档化 |
| 逐行标签高亮 | **No** | **No** | **No** | No（仅 ANSI 颜色） |
| 消息过滤 | **No** | **No** | 仅 filter 链 | Yes（include/exclude、正则、历史） |
| 滚动锁定 | **No** | **No** | **No** | Yes（"Frozen View"） |

## 各扩展要点

- **Microsoft** `ms-vscode.vscode-serial-monitor`：Preview，215 万安装，仓库 MIT，2025-08-04 归档，无源码。性能问题 #235（输出卡顿 1s+冻结 1s、发送延迟 2s）、#101（延迟随时间增大）、#209（pollHotplug 周期性冻结）。多监视器上限 3（#152）。
- **Eclipse CDT** `eclipse-cdt.serial-monitor`：31 万安装，EPL-2.0，支持桌面与 Web（WebSerial），`api.openSerial(filter, options, name)`。
- **PlatformIO** `platformio.platformio-ide`：742 万安装，Apache-2.0，串口监视即 `pio device monitor` 终端，靠 `platformio.ini` 的 `monitor_*` 配置与 filter 链。
- **FancyMon** `wombat.fancymon`：951 安装，MIT。include/exclude 实时过滤（含历史）、Frozen View、可配置缓冲（100–1,000,000 行）、ANSI 颜色、按正则提取绘图、保存到文件、DTR/RTS 复位脉冲、addr2line。它的缓冲上限档位可作我们 10,000 行默认值的参照。

## 来源

- Microsoft: https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-serial-monitor · https://github.com/microsoft/vscode-serial-monitor · 性能 #235 https://github.com/microsoft/vscode-serial-monitor/issues/235 · 多监视器 #152 https://github.com/microsoft/vscode-serial-monitor/issues/152 · TCP/SWO #50 https://github.com/microsoft/vscode-serial-monitor/issues/50
- Eclipse CDT: https://marketplace.visualstudio.com/items?itemName=eclipse-cdt.serial-monitor · https://github.com/eclipse-cdt-cloud/vscode-serial-monitor · https://open-vsx.org/extension/eclipse-cdt/serial-monitor
- PlatformIO: https://marketplace.visualstudio.com/items?itemName=platformio.platformio-ide · https://docs.platformio.org/en/latest/integration/ide/vscode.html · https://docs.platformio.org/en/latest/core/userguide/device/cmd_monitor.html
- FancyMon: https://marketplace.visualstudio.com/items?itemName=wombat.fancymon · https://github.com/tom88holmes/fancymon
