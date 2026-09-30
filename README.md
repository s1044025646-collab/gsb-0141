# 二值图像形态学与连通域测量后端

Windows 本地可运行的纯后端：TypeScript + Node.js（内置 `node:sqlite`，无第三方运行时依赖）+ SQLite。
只提供 HTTP API、CLI、合成像素矩阵生成器与自动化测试；**没有网页、没有目标检测模型、不调用任何外部图像服务**。

## 依赖

- Node.js >= 22.5（开发环境为 v25；使用内置实验模块 `node:sqlite`，运行时会有一条 ExperimentalWarning，可忽略）。
- 开发依赖仅 `typescript` 与 `@types/node`，用于 `npm run typecheck`；运行与测试不需要编译步骤。

```powershell
npm install
```

## 形态学语义（实现约定）

结构元素 `B` 用 0/1 形状矩阵加锚点 `[row, col]` 表示，允许**非对称形状**，锚点可不居中、甚至不是前景格。

- 反射 `B̂`：形状旋转 180°，锚点随之映射到 `(h-1-ar, w-1-ac)`（见 `src/morphology.ts` 的 `reflectSE`）。
- 膨胀按集合 Minkowski 和直接计算：输出为 1 当且仅当存在 `b∈B` 使输入在 `p+b` 为 1。
- 腐蚀按集合 Minkowski 腐蚀直接计算：输出为 1 当且仅当对所有 `b∈B`，输入在 `p+b` 均为 1。
- 开运算 = 先腐蚀后膨胀（同一 `B`）；闭运算 = 先膨胀后腐蚀。均为**集合运算**，不存在邻域计数近似。
- 画布外部取值（报告中 `borderMode` 记录实际策略）：
  - `zero`（默认）：外部为背景 0；
  - `one`：外部为前景 1；
  - `mirror`：读取边界反射位置的像元。
- 有效区域掩膜是硬性闸门：`mask=0` 的位置输出恒为 0，永不计入任何面积/分母。

## 连通域与测量语义

- 前景可选四连通或八连通；**背景采用互补连通性**（4↔8），避免对角悖论。
- 触达有效区域边界的背景分量为外部，不计为孔洞；被前景完全包围的背景袋才是孔洞（触边孔洞因此结果明确为“不是孔洞”）。
- 编号确定性：按栅格扫描序（自上而下、自左而右）从 1 开始编号。
- 每个区域输出：`pixelCount`（像元数）与 `area`（物理面积 = 像元数 × `pixelSize.x × pixelSize.y`）**分开表示**；
  另含质心（行列索引与物理坐标）、包围盒、`holes`、`euler = 1 - holes`、`touchesBorder`。
- 全空图像：0 个区域、0 孔洞；全满图像：1 个区域、0 孔洞；零面积/空输入均有确定结果。

## 数据与版本模型（SQLite）

迁移幂等（`CREATE TABLE IF NOT EXISTS`，可重复执行）。表：`images`、`versions`、`structuring_elements`、
`chains`、`steps`。每个处理步骤保存来源版本、中间矩阵、参数、边界策略与标签报告；
**人工合并/过滤只生成新版本，绝不改写原图**，可按父子链完整复现历史。

## 测试

```powershell
npm test
npm run typecheck
```

夹具覆盖：单像元、环形、对角相连、触边区域（C 形开口）、非对称结构元（L 形+偏心锚点）、全空、全满；
另含手工小矩阵集合运算核对、确定性编号、像元/物理面积换算、远离边界的开闭幂等性、掩膜隔离、
历史复现、失败路径、事务回滚、幂等重放、重启持久化与 HTTP 分页/错误码端到端测试。
时钟可注入（服务构造参数 `clock`），合成矩阵使用可播种的确定性 PRNG（`mulberry32`）。

## 可重复演示

```powershell
npm run demo
```

每次先删除 `data/demo.sqlite` 再重建，输出确定的环形区域面积/孔洞数、非对称膨胀增量与幂等重放结果。

## HTTP API（仅绑定 127.0.0.1，自动端口）

启动独立守护进程并写入 `data/server.pid`、`data/server.port`：

```powershell
npm start            # 或 node src/cli.ts serve，端口由 OS 分配
npm stop             # 或 node src/cli.ts stop，只停止本项目 pid 文件记录的进程
```

错误响应统一为 `{ "error": { "code", "message" } }`，错误码：
`VALIDATION_ERROR(400)`、`NOT_FOUND(404)`、`CONFLICT(409)`、`UNSUPPORTED_OP(400)`、`INTERNAL(500)`。

路由：

- `GET  /health`
- `POST /images`（body：`{name, payload:{width,height,data,mask,pixelSize}}`）
- `POST /structuring-elements`（`{name, shape, anchor?}`）
- `POST /images/:id/chains`（`{sourceVersionId, steps[], idempotencyKey?}`，同 key 重放幂等）
- `GET  /images/:id/versions`
- `GET  /chains/:id/regions?page=0&pageSize=50`（分页，`pageSize` 上限 200）
- `GET  /chains/:id/holes?page=0&pageSize=50`（含定位种子像元与包围盒）
- `GET  /chains/:id/labels`（导出标签矩阵 JSON）
- `GET  /versions/compare?a=&b=`（gained/lost/unchangedForeground，忽略掩膜外）
- `GET  /versions/:id/matrix`

操作步骤类型：`dilate | erode | open | close | label | filter | merge`，
参数含 `se`、`connectivity`、`border`、`minArea/maxArea`（物理面积）、`labels`（人工合并）。

## CLI 示例

```powershell
node src/cli.ts import --name ring --file examples/payload-ring.json
node src/cli.ts se --name cross --file examples/se-cross.json
node src/cli.ts chain --image 1 --source-version 1 --file examples/steps.json --idempotency-key k1
node src/cli.ts regions --chain 1 --page 0 --page-size 20
node src/cli.ts holes --chain 1
node src/cli.ts compare --a 1 --b 3
node src/cli.ts export-labels --chain 1 --out tmp/labels.txt
```

`chain` 会打印每步前后前景像元数、区域数与孔洞数。所有数据库与临时文件均在项目内的 `data/`、`tmp/`。
