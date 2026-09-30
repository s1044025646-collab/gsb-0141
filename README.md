# 二值图像形态学与连通域测量后端

纯本地运行的后端：**TypeScript + Node.js + 内置 `node:sqlite`**（无原生模块、无外部图像服务、无网页、无检测模型）。
输入为二值矩阵、像元物理尺寸与有效区域掩膜；管理原图版本、结构元素、锚点、处理步骤、连通域标签与测量报告。

## 依赖

- Node.js ≥ 22（推荐 24/25，内置 `node:sqlite`；本项目在 Node v25 验证）
- 仅开发依赖：`typescript`、`tsx`、`vitest`、`@types/node`

```powershell
npm install
```

所有数据、SQLite 文件与临时文件都写在本项目 `data/` 下；服务只绑定 `127.0.0.1`，端口传 `0` 由系统自动分配。

## 核心语义（集合运算，不是邻域计数）

### 结构元素、锚点与反射

- 结构元素 `B` 是与图像同坐标系的 0/1 网格，**允许任意非对称形状**；
- 锚点 `(ar,ac)` 必须落在形状内部；成员的锚点相对位移为 `t = (r-ar, c-ac)`；
- **反射**：`B` 关于锚点的反射为 `B̂ = { -t : t ∈ B }`。

实现使用锚点位移的直接集合定义（对非对称形状逐一手工核对，见测试）：

| 运算 | 集合定义 | 实现方式 |
| --- | --- | --- |
| 膨胀 `A⊕B` | `⋃_{b∈B} A_b` | 对每个前景像元平移每个成员位移 `t` 后取并集 |
| 腐蚀 `A⊖B` | `{ p : B_p ⊆ A }` | 仅当 `{p+t : t∈B}` 全部落在前景时 `p` 为前景 |
| 开 `A∘B` | `(A⊖B)⊕B` | 同一 SE、同一锚点 |
| 闭 `A•B` | `(A⊕B)⊖B` | 同一 SE、同一锚点 |

### 图像外部取值规则（显式并写入报告）

- 形态学：**图像边界外一律按背景 0（zero-padding）**，`boundaryPolicy = outside-as-zero`；
  - 因此贴边前景会被腐蚀收缩；膨胀只在矩阵内写结果；
- 掩膜：掩膜外像元恒为背景，**不参与运算、不参与连通、不计入面积分母**；膨胀结果也不会写到掩膜外；
- 连通测量中的“外部背景”（不成孔洞）：接触图像外框、或按**背景自身连通性**邻接到掩膜外像元的背景分量。

### 连通性与测量

- 前景可选 **4 连通或 8 连通**；背景强制采用**互补连通性**（前景 8→背景 4，前景 4→背景 8）；
- 两遍并查集标记，标签按**行优先首次出现从 1 确定编号**；
- 每个区域输出：像元数量、**物理面积（像元数 × 像元高 × 像元宽，与像元数量分开）**、
  质心（像元坐标与物理坐标）、包围盒、是否触边、孔洞标签/数量、孔洞像元数、
  分量欧拉数 `1 − 孔洞数`；
- 整幅报告另给：有效像元/面积、前景像元/面积、前景占有效区域比例、区域数、总孔洞数、
  整体欧拉数 `区域数 − 孔洞数`（全空为 0）；
- **对角接触**：角对角围出的格子在“前景 8 + 背景 4”下是孔洞、在“前景 4 + 背景 8”下墙壁断开孔洞消失（夹具已覆盖）；
- **触边孔洞**：接触边界或掩膜外的背景算外部，不算孔洞；
- **零面积**：全空图像区域数为 0、面积 0、占比 0、欧拉数 0。

### 版本、人工操作与历史

- 导入即原图 **v1（永不改写）**；每个处理步骤在事务内写入“来源版本 + 结果版本 + 中间矩阵 + 边界策略”；
- 人工**合并**为两版本逐像元并集；人工**过滤**按连通标签保留；两者都生成新版本，绝不修改原图；
- `/replay` 从链首来源版本逐步重算并与存储结果逐像元比对，验证历史可复现。

## HTTP API（仅本机，自动端口）

启动后端口写入 `data/server.port`。所有错误返回 `{ "error": { "code", "message" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/images` | 导入 `{name,matrix,mask?,pixelHeight,pixelWidth,unit?,connectivity?}` |
| GET | `/images?page=&pageSize=` | 分页列出图像 |
| GET | `/images/:id` | 图像详情 |
| GET | `/images/:id/versions` / `/chains` | 分页查询版本 / 操作链 |
| POST/GET | `/struct-elements` | 注册 / 列出结构元素 |
| POST | `/chains/run` | 执行操作链（可带 `idempotencyKey`、`startVersionId`） |
| GET | `/chains/:id` | 查看链步骤（含来源/结果版本、边界策略） |
| POST | `/chains/:id/replay` | 历史复现核对 |
| GET | `/versions/:id/measure?connectivity=&page=&pageSize=` | 区域测量（区域分页） |
| GET | `/versions/:id/holes` | 孔洞及定位 |
| GET | `/versions/:id/labels?connectivity=` | 导出标签矩阵 |
| GET | `/versions/diff?before=&after=` | 比较处理前后（新增/消失坐标） |

操作步骤类型：`dilate | erode | open | close`（带 `se`）、`merge`（`params.versionId`）、`filter`（`params.keepLabels`）。

主要错误码：`INVALID_MATRIX / INVALID_MASK / INVALID_PIXEL_SIZE / INVALID_CONNECTIVITY /
INVALID_STRUCT_ELEMENT / INVALID_FILTER / INVALID_OP / INVALID_JSON / PAYLOAD_TOO_LARGE /
IMAGE_NOT_FOUND / VERSION_NOT_FOUND / CHAIN_NOT_FOUND / MERGE_VERSION_NOT_FOUND / NOT_FOUND`。

## CLI

CLI 在关键操作前后打印状态（前景像元数、版本号、编号定位）：

```powershell
# 导入（含掩膜、像元尺寸、连通性）
npx tsx src/cli/cli.ts import demo examples/matrix.json --mask examples/mask.json --pixel-h 0.5 --pixel-w 0.5 --unit mm --conn 8

npx tsx src/cli/cli.ts images
npx tsx src/cli/cli.ts versions 1
npx tsx src/cli/cli.ts se cross examples/cross.json 1 1
npx tsx src/cli/cli.ts chain 1 examples/chain.json
npx tsx src/cli/cli.ts regions 3
npx tsx src/cli/cli.ts holes 3
npx tsx src/cli/cli.ts diff 1 3
npx tsx src/cli/cli.ts labels 3 --out data/labels.json
npx tsx src/cli/cli.ts replay 1
npx tsx src/cli/cli.ts show 1
```

全局 `--db <path>` 可指定数据库（默认 `data/morph.db`）。

## 可复现演示与测试

```powershell
npm run demo       # 固定时钟+固定种子 RNG 的端到端演示（含幂等、过滤/合并、复现）
npm test           # vitest 全量自动化测试（42 个用例）
npm run typecheck  # 仅类型检查
```

测试夹具覆盖：单像元、环形、对角相连、触边区域、非对称结构元素、全空、全满；
手工小矩阵逐像元核对膨胀/腐蚀/开/闭集合结果；并核对确定性编号、像元→物理面积换算、
远离边界时开闭运算幂等、掩膜隔离、历史复现、失败路径错误码、**单步事务原子回滚**、
重复提交幂等，以及关闭重开数据库后的**持久化状态**与可重复迁移。

## 启动 / 停止 / 清理（只管理本项目）

```powershell
npm start                 # 绑定 127.0.0.1 + 自动端口；打印端口，写 data/server.port / data/server.pid
npm run stop              # 只停止 data/server.pid 记录的本项目服务进程
npm run clean             # 只删除本项目 data/ 与 dist/
```

也可用环境变量：`MORPH_DB=data/custom.db`、`MORPH_PORT_FILE=data/custom.port`。
停止脚本只对记录的 PID / 经 `/health` 确认为本服务的本机端口操作，不管理任何项目外进程。
