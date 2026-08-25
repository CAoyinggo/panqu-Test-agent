# Memory 存储与迁移

## 适用范围

Agent Memory 统一依赖 `TestMemory` 接口。JSON、SQLite 以及后续 PostgreSQL
实现必须保持相同的保存和检索语义，业务 Agent 不直接依赖具体存储驱动。

## 当前短期方案：并发安全 JSON

JSON 后端适用于本地开发、单机工具和低写入量场景，写入协议为：

```text
获取 <memory>.lock
  → 读取当前强内容哈希
  → 版本变化时重新读取并按 record.id 合并（CAS）
  → 写入 <memory>.<uuid>.tmp
  → fsync(tmp)
  → 原子 rename
  → fsync(directory)
  → 释放 owner 匹配的锁
```

安全约束：

- 临时文件使用 UUID，不存在多个实例共享固定 `.tmp` 的覆盖窗口。
- 锁通过 `O_EXCL` 创建，记录 owner、PID 和主机名；只释放自己的锁。
- 陈旧锁仅在能够确认本机持有进程已死亡时接管。跨主机状态无法确认时默认超时，禁止冒险双写。
- CAS 使用 SHA-256 内容指纹，避免相同文件大小和修改时间造成误判。
- 写入失败会清理临时文件；损坏 JSON 会隔离为 `.corrupt-<timestamp>`。

JSON 文件锁不是分布式锁。共享 NFS、多个容器或多节点服务不得继续使用 JSON Memory。

## SQLite：单机长期运行

SQLite 后端使用 WAL、`BEGIN IMMEDIATE`、busy timeout 和主键 UPSERT，适用于单机服务：

```bash
node dist/bin/run-agent.js "测试需求" --memory=output/agent-memory.sqlite
```

`.sqlite` / `.db` 扩展名会自动选择 SQLite；其他路径默认使用并发安全 JSON。

## PostgreSQL：多节点目标

多 Worker、多副本或 Kubernetes 部署应迁移 PostgreSQL。平台已经具备 PostgreSQL
连接、迁移和仓储基础设施；Agent Memory 迁移按以下顺序执行：

1. 建立 `memory_records` 表和 `(type, created_at)` 索引。
2. 离线导入 JSON/SQLite 历史记录，以 `id` 幂等 UPSERT。
3. 对比记录总数、ID 集合及内容校验和。
4. 灰度启用 PostgreSQL 读写，保留旧存储只读回滚窗口。
5. 稳定后停止 JSON 写入并归档原文件。

迁移期间禁止两个后端分别生成不同 ID；写入幂等键始终使用 `MemoryRecord.id`。
