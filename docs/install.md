# BetterLearn 本地安装与维护

需要 macOS/Linux、Node.js24、Python3.12，以及已经安装的 DeepSeek Harness（DSH）0.1.0-rc.7 或0.1.0-rc.8。这是DSH插件，不会安装系统服务。安装会下载指定版本的DSH base/web-app及Python依赖；产品本身从交付的tarball安装。不要把数据目录放进共享同步目录。

## 为什么使用维护 CLI

`betterlearn install`在调用标准`dsh plugin --profile betterlearn add <tarball>`之外，还会创建Python 3.12虚拟环境、安装Python依赖、初始化独立SQLite和所有权标记、生成token，并保存启动所需的路径。标准`dsh plugin add`只负责profile里的包与bundle注册，单独执行它不能完成这些步骤。

CLI为DSH注册和启动设置专用`DSH_HOME`，启动时还提供Python模块路径、解释器、数据根目录和token。首次安装按下面的完整命令执行；升级也应使用`betterlearn upgrade`，以保持DSH加载包与Python Core版本一致，并保留升级前备份。不要用一条裸`dsh plugin add`或直接`dsh --profile betterlearn`替代。安装/升级完成后，通过`betterlearn start`重新启动专用profile。

预构建tarball已经包含Host/Client构建产物，使用者不需要在安装时构建TypeScript。当前未提供npm registry或Git源码直接安装渠道，不需要为试用增加`prepare`脚本。

## 安装与启动

先把交付包解压，以其中的CLI安装。以下路径请替换成实际路径：

```sh
mkdir -p "$HOME/Downloads/betterlearn-release"
tar -xzf betterlearn.tgz -C "$HOME/Downloads/betterlearn-release"
node "$HOME/Downloads/betterlearn-release/package/bin/betterlearn.mjs" install \
  --home "$HOME/.betterlearn" \
  --dsh /absolute/path/to/dsh \
  --dsh-version 0.1.0-rc.8 \
  --python /absolute/path/to/python3.12 \
  --package /absolute/path/to/betterlearn.tgz
```

后文`betterlearn`表示上面`node .../bin/betterlearn.mjs`；如果通过npm安装该交付包，npm也会提供同名命令。`--dsh-version`必须与`--dsh`的实际已安装版本一致。命令不会安装另一份全局DSH，也不会修改你的默认DSH profile。

以上述`--home`为例，专用DSH home为`~/.betterlearn/dsh`，profile位于其`profiles/betterlearn`。Python环境在`~/.betterlearn/venv`，SQLite数据在`data/phase1.db`，本地配置在`config.json`，备份在`backups`，交付包源码保存在`packages`，这些相对目录均以`--home`为根。自动生成所有权标记和token，不需要手工填写；配置包含私有token，请勿公开。遇到已有未知数据的目录会拒绝初始化，不会删除它。

```sh
betterlearn start --home "$HOME/.betterlearn" --port 3000
```

前台运行，浏览器打开DSH显示的本地地址。使用DSH正常模型选择器配置你自己的provider/model；真实模型调用可能收费。按Ctrl-C停止DSH后再恢复、升级或卸载。本插件保留DSH WebUI及对话入口，但提取workflow只能返回结构化结果，不能执行其他工具。

## 专用 profile 的能力范围

BetterLearn新增`conversation.view`标签页，并在空会话的输入dock提供导入入口；`order: 50`是标签排序，不会把Chat等其他视图从槽位移除。隔离使用专用profile的原因是随包的`cordis.patch.yml`会覆盖以下宿主配置，影响该profile而不只影响BetterLearn页面：

| 配置行 | 当前设置 | 目的与影响 |
| --- | --- | --- |
| `llm-retry` | 禁用 | 不由该插件自动重发失败请求，重新提取由用户显式发起。 |
| `session-title-llm` | 禁用 | 不为自动生成会话标题另发模型请求。 |
| `tool-workflow`、`tool-bash`、`tool-fs` | 禁用 | 不向模型开放这些工具入口；普通对话也不能依靠这些入口执行编码工作。 |
| `subagent-spawn-in-process` | 启用，provider为`spawn` | 为Host主动发起的提取workflow提供子Agent；不等于恢复模型侧的workflow工具。 |
| `workflow-worker-thread` | 启用，使用`spawn`；并发Agent、总Agent和单次items上限均为1 | 配合串行提取，每次workflow使用一个子Agent；同步与释放宽限均为1000ms。其他workflow消费者也会受到这些profile级设置影响。 |
| `agent-loop` | `agents: []` | 不由这份配置预置常驻Agent；Agent能力保留，Host仍按需创建提取Agent。 |

这些设置服务于受控的资料提取闭环，不能把此profile视为功能完整的日常编码环境。另有仅针对提取父/子Agent的工具限制，只允许`structured_output`。不要为恢复普通编码能力在当前profile随意重新启用工具或重试；多插件共存与编码profile接入尚未验收。维护CLI卸载只移除BetterLearn bundle注册，不会删除其他bundle或用户自行添加的patch，因此也不承诺卸载后自动变回某个“默认编码环境”。

## 备份、恢复与升级

在线备份可以在DSH运行时执行，使用SQLite一致性备份接口：

```sh
betterlearn backup --home "$HOME/.betterlearn" --to "$HOME/Desktop/betterlearn-backup.sqlite"
```

目标必须是不存在的文件，不能位于`data`内。备份包含原文、候选与知识点等本地数据，请妥善保管。不要在运行中直接复制db/WAL文件充当备份。

恢复要求Core停止；活跃Core持有的同一把锁会阻止恢复。先验证备份，再将恢复前数据库保存到`backups`，然后通过SQLite恢复：

```sh
betterlearn restore --home "$HOME/.betterlearn" --from "$HOME/Desktop/betterlearn-backup.sqlite"
```

命令输出`previousBackup`是恢复前副本路径，误恢复时可用它再次恢复。恢复只接受当前产品schema，不支持旧v8数据库迁移。

升级先停止DSH，然后运行：

```sh
betterlearn upgrade --home "$HOME/.betterlearn" --package /absolute/path/to/new-betterlearn.tgz
```

升级持有Core锁，先把当前数据备份，再安装新包对应的Python依赖与DSH插件，成功后更新本机包配置。data、token和用户模型配置保持不变；失败不会删除数据，但依赖或插件安装可能已部分更新，可修复安装问题后重试。升级只支持当前产品schema内兼容版本，不自动更新DSH版本。需要撤回时可重新安装旧tarball并恢复对应备份。

```sh
betterlearn uninstall --home "$HOME/.betterlearn"
```

卸载只移除专用DSH profile中的产品插件注册；默认保留data、backups、配置、Python环境和DSH，便于用同一`install`命令重装。不会删除共享DSH或其他用户数据。真正删除本机数据必须由你自行决定并操作。
