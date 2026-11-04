# data/ —— 试玩数据（进版本库的）

这个目录放**要给外人看的**东西：真人试玩产生的对局记录 + 自动生成的报告。
和 `gameserver/logs/`（运行时原始日志，已被 .gitignore 忽略）区分开。

## 为什么要把数据提交进 git

1. 对局记录只存在跑对战服的那台电脑上，电脑重装/换机器就没了；
2. **git 提交时间戳是不可事后倒填的时间线**——它能证明这些记录是当时产生的，
   不是事后编的。面试官问「数据怎么保证没被改」时，这是最直接的答案；
3. 面试/谈发行时，仓库里直接有一份可查的报告，而不是口头说「我组织过测试」。

## 每次试玩收工后（30 秒）

```bash
cd gameserver
npm run report        # 读 logs/ → 生成 ../data/analysis.md，并复制原始记录到 ../data/raw/
cd ..
git add data
git commit -m "data: 11-04 试玩 8 局，4 名玩家"
git push
```

## 文件说明

| 文件 | 内容 |
|---|---|
| `analysis.md` | 总览 / 留存 / 玩家明细，一页 Markdown，自动生成，别手改 |
| `raw/rounds-YYYY-MM-DD.jsonl` | 原始记录副本，一行一局，可导入 backend `/api/matches` |

## 口径

- **局**：打到结算才落盘，中途解散的不计入；
- **玩家**：按客户端 `playerId` 去重（存在玩家设备上，服务重启不变）；
- **胜**：敌人出完且你是敌人 = 胜；你是乌龟且出完牌 = 胜；
- 当前 `raw/` 里的记录包含开发阶段的自动化测试数据（P1…P12、bot1… 这类），
  正式拉真人试玩前建议把旧记录挪走，让留存数据干净：

```bash
mkdir -p gameserver/logs/_dev-archive
mv gameserver/logs/rounds-*.jsonl gameserver/logs/_dev-archive/ 2>/dev/null
mv data/raw/*.jsonl data/raw/_dev-archive/ 2>/dev/null
```

（注意：`data/raw/` 里旧文件一旦提交过，删掉要单独 commit，git 历史里仍能查到。）
