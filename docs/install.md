# BetterLearn 本地安装与维护

需要 macOS/Linux、Node.js24、Python3.12，以及已经安装的 DeepSeek Harness（DSH）0.1.0-rc.7 或0.1.0-rc.8。这是DSH插件，不会安装系统服务。安装会下载指定版本的DSH base/web-app及Python依赖；产品本身从交付的tarball安装。不要把数据目录放进共享同步目录。

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

安装使用专用profile `betterlearn`，目录为`~/.betterlearn/dsh`；Python环境在`venv`，SQLite数据在`data/phase1.db`，本地配置在`config.json`，备份在`backups`，交付包源码保存在`packages`。自动生成所有权标记和token，不需要手工填写；配置包含私有token，请勿公开。遇到已有未知数据的目录会拒绝初始化，不会删除它。

```sh
betterlearn start --home "$HOME/.betterlearn" --port 3000
```

前台运行，浏览器打开DSH显示的本地地址。使用DSH正常模型选择器配置你自己的provider/model；真实模型调用可能收费。按Ctrl-C停止DSH后再恢复、升级或卸载。本插件保留DSH WebUI及对话入口，但提取workflow只能返回结构化结果，不能执行其他工具。

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
