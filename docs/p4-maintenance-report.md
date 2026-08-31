# P4 SQLite维护实现记录

2026-08-31。仅维护模块范围，无真实模型调用。

入口：

```text
python -m nobei_core.maintenance backup --data-root ROOT --to FILE
python -m nobei_core.maintenance restore --data-root ROOT --ownership-token TOKEN --from FILE --backup-dir DIR
```

成功 stdout 单行JSON：备份 `{backupPath}`；恢复 `{restoredFrom,previousBackup}`。失败 stderr 简短错误、退出码1，不打印token。Node交付CLI负责传入已存配置。

- 在线备份使用 `sqlite3.Connection.backup`，读取已提交WAL内容，允许Core持锁运行；目标必须在data根外且不存在。新文件权限0600，不覆盖已有目标。
- 恢复源以只读连接和显式读事务固定，显式恢复只检查来源产品schema标识/表集及SQLite quick_check，不比较建表SQL、不扫描外键。未知/损坏备份不触碰目标。在线备份仅确认产品schema标识/表集，然后使用SQLite备份API。
- 恢复持有已有 `CoreLease`，因此运行中Core明确 `CORE_INSTANCE_CONFLICT`。当前库先用SQLite backup保存至backup-dir唯一文件；保存失败时不执行恢复。随后用SQLite backup回写当前连接，不原始复制数据库、不删WAL。
- 新增 `python/tests/test_maintenance.py`：6项通过（简化校验后定向复测）。覆盖运行中WAL备份、知识点/文档/证据/审核幂等数据全部相等、变更后离线恢复与重新打开、恢复前副本完整、运行中恢复拒绝、损坏/未知schema备份拒绝不改变目标、禁止覆盖/根内目标、保存失败中止，以及CLI JSON/不泄露token。

不新增迁移、后台任务或正常读取时扫描。实际DSH安装升级卸载闭环由根任务单独验收。

限制：恢复仍须先成功保存当前数据库。如果当前库已损坏到SQLite备份API无法读取，操作会失败并停止，不绕过保存步骤覆盖现库；需另行人工处理损坏数据库。
