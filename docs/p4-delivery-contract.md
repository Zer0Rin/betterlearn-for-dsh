# P4 本地交付接口

P3验收通过后实施。只交付DSH插件，CLI用于管理本地插件与SQLite，不是另一套应用。

## CLI

打包 `bin/betterlearn.mjs`，Node24，命令：

- `install --home <BetterLearn目录> --dsh <DSH可执行文件> --dsh-version <已安装版本> [--python <Python3.12>] [--package <tarball>]`：专用DSH profile `betterlearn`，DSH_HOME放在home/dsh（可选显式dsh-home），Python venv放在home/venv，数据放home/data，配置home/config.json；配置不可放进被旧守卫约束的数据目录。只在空目录初始化ownership marker，已有未知数据不删。安装DSH base/web-app与插件tarball，保留DSH服务与conversation.view。
- `start --home ... [--port N]`：从持久配置设置Core环境，前台启动DSH profile，Ctrl-C退出。实际安装无需用户手填ownership token。
- `backup --home ... --to <文件.sqlite>`：使用SQLite在线备份API，允许Core运行中，目标不得覆盖现有文件或放进data目录。
- `restore --home ... --from <文件.sqlite>`：Core必须停止；通过已有CoreLease持锁保证。先确认备份是当前产品schema且可读；恢复前保存当前库副本至home/backups；SQLite backup回写，不能直接复制运行中db/WAL。恢复后提示恢复前副本路径。
- `upgrade --home ... --package <新tarball>`：停止Core后先备份，再用DSH plugin add安装指定包，保持data、token和模型数据；失败不删除原数据。当前只支持本产品schema内兼容升级，不迁移旧v8。
- `uninstall --home ...`：移除DSH插件注册；默认保留data、backups和配置供重装。不得删除共享DSH或用户数据。

可提供 `status` 但不强制；不做后台守护进程/系统服务/自动更新。专用profile隔离现有历史patch对其他DSH功能的影响。CLI参数错误显示简短usage；不打印token。配置保留本机路径，只存本机。

## Python维护入口

`python -m nobei_core.maintenance backup --data-root ROOT --to FILE` 或 `restore --data-root ROOT --ownership-token TOKEN --from FILE --backup-dir DIR`。实现是一次性维护，不在正常读写中加入扫描。恢复验证仅在显式恢复操作做。root文件保持phase1.db以兼容Core现有路径。

## rc.8

产品的DSH peer范围仅扩大到实际验收过的rc.7/rc.8；开发依赖保留rc.7，无全量版本pinset扩建。fake-provider也使用peer以避免把rc.7服务实现重复安装到rc.8。在隔离runtime安装真实DSH rc.8并从tarball执行完整生命周期，最后核对SQLite实际知识点。该兼容性必须实跑，不能以版本字符串改动代替。
