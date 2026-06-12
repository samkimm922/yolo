#!/usr/bin/env node
/**
 * 12 维度全量代码审查
 *
 * 维度:
 * 1. code-quality    — 代码质量（页面、组件、hooks）
 * 2. service-layer   — Service 层（数据操作、错误处理、分层违规）
 * 3. security        — 安全漏洞（硬编码、注入、XSS、数据泄露）
 * 4. type-safety     — 类型安全（as 断言、any 泄漏、接口定义）
 * 5. performance     — 性能（重渲染、N+1、无限循环、大列表）
 * 6. platform-compat — 小程序兼容（Taro vs wx、H5 降级、生命周期）
 * 7. cloud-database  — 云数据库专项（原子操作、事务、分页、索引）
 * 8. data-model      — 数据模型一致性（新旧模型、读写不同源）
 * 9. state-mgmt      — 状态管理（TanStack Query 缓存、staleTime、乐观更新）
 * 10. dead-code      — 死代码检测（废弃文件、未使用 export、不可达分支）
 * 11. error-resilience — 错误边界与韧性（ErrorBoundary、全局异常、断线恢复）
 * 12. dependency     — 依赖审计（已知漏洞、废弃包、版本冲突）
 *
 * 用法: node scripts/yolo/closed-loop/full-review-all.mjs [--parallel N]
 */

import { execSync } from "child_process";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const LOOP_DIR = __dirname;

// ── 参数解析 ──────────────────────────────────────────────
function getArgValue(name) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.split("=").slice(1).join("=") : undefined;
}

const PARALLEL = parseInt(getArgValue("parallel") || "4", 10);
const TIMEOUT_MS = 600000; // 10 minutes per dimension

// ── Shell 转义 ────────────────────────────────────────────
function sh(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// ── 12 维度定义 ───────────────────────────────────────────

const DIMENSIONS = [
  // ── 1. code-quality ────────────────────────────────────
  {
    id: "code-quality",
    label: "代码质量",
    buildPrompt: () =>
      `你是高级代码审查专家。对盲盒库存管理微信小程序（Taro + React + TypeScript + 微信云数据库）进行【代码质量】专项审查。

## 审查范围
src/pages/、src/components/、src/hooks/ 下所有 .ts/.tsx 文件

## 重点检查
1. 代码重复：是否存在复制粘贴逻辑应提取为公共函数/hook
2. 超大函数：单个函数超过 80 行的应拆分
3. 缺失错误处理：未处理异常、缺少 try/catch、空 catch 块
4. 不当 React 模式：
   - useEffect 缺少依赖项或依赖项过多
   - 闭包中引用了过期状态（stale closure）
   - effect 中未做清理（事件监听器、订阅未取消）
   - 在渲染函数中直接调用 setState
5. 条件渲染中的 key 缺失或不稳定
6. Props drilling 过深（超过 3 层）

## 规则
- 只输出确实有问题的条目。没有问题的不要输出，不要写确认性描述。
- 每条 finding 必须是一个需要修复的 bug 或违规
- 只输出 JSON，不要其他内容

## 输出格式（严格遵循）
\`\`\`json
{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"src/path/file.ts","line":42,"description":"问题","suggestion":"建议"}],"summary":{"critical":0,"high":0,"medium":0,"low":0}}
\`\`\``,
  },

  // ── 2. service-layer ──────────────────────────────────
  {
    id: "service-layer",
    label: "Service 层",
    buildPrompt: () =>
      `你是高级代码审查专家。对盲盒库存管理微信小程序（Taro + React + TypeScript + 微信云数据库）进行【Service 层】专项审查。

## 审查范围
src/services/ 下所有文件，以及 pages/components 中是否存在绕过 service 层直接调用数据库的代码

## 重点检查
1. 分层违规：pages/ 或 components/ 中是否直接调用了 wx.cloud.database() 或 Taro.cloud，而非通过 service 层
2. 空 catch 块：catch(e) {} 或 catch(e) { console.log(e) }，缺少 logger 调用
3. 不一致错误处理：某些 service 函数 throw，某些返回 null，某些返回 { success: false }
4. 应使用事务但未使用的场景：涉及多文档写入、库存扣减等原子操作
5. 缺少输入校验：service 函数未校验必要参数
6. 错误信息泄露：将内部错误直接返回给前端

## 规则
- 只输出确实有问题的条目。没有问题的不要输出，不要写确认性描述。
- 每条 finding 必须是一个需要修复的 bug 或违规
- 只输出 JSON，不要其他内容

## 输出格式（严格遵循）
\`\`\`json
{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"src/path/file.ts","line":42,"description":"问题","suggestion":"建议"}],"summary":{"critical":0,"high":0,"medium":0,"low":0}}
\`\`\``,
  },

  // ── 3. security ──────────────────────────────────────
  {
    id: "security",
    label: "安全漏洞",
    buildPrompt: () =>
      `你是高级安全审计专家。对盲盒库存管理微信小程序（Taro + React + TypeScript + 微信云数据库）进行【安全】专项审计。

## 审查范围
全部 src/ 目录下文件，重点关注 config、service、cloud functions

## 重点检查
1. 硬编码敏感信息：API Key、AppID、AppSecret、token、密码等写死在代码中
2. Math.random() 用于安全场景（如随机抽奖、token 生成、订单号）
3. 未消毒的用户输入：直接将用户输入拼接到数据库查询或渲染为 HTML
4. 敏感数据写入日志：console.log 中包含用户手机号、openid、密码等
5. 文件上传漏洞：未校验文件类型、大小限制
6. 云函数安全：未校验调用者身份、未限制云函数调用频率
7. 数据权限：客户端是否可以直接操作不应访问的集合

## 规则
- 只输出确实有问题的条目。没有问题的不要输出，不要写确认性描述。
- 每条 finding 必须是一个需要修复的 bug 或违规
- 只输出 JSON，不要其他内容

## 输出格式（严格遵循）
\`\`\`json
{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"src/path/file.ts","line":42,"description":"问题","suggestion":"建议"}],"summary":{"critical":0,"high":0,"medium":0,"low":0}}
\`\`\``,
  },

  // ── 4. type-safety ──────────────────────────────────
  {
    id: "type-safety",
    label: "类型安全",
    buildPrompt: () =>
      `你是 TypeScript 类型系统专家。对盲盒库存管理微信小程序（Taro + React + TypeScript + 微信云数据库）进行【类型安全】专项审查。

## 审查范围
全部 src/ 目录下 .ts/.tsx 文件

## 重点检查
1. \`as\` 类型断言滥用：特别是 as any、as unknown as Xxx，应该用类型守卫（type guard）替代
2. any 类型泄漏：显式 : any、隐式 any（未标注类型）、@ts-ignore / @ts-nocheck
3. 缺失泛型：Hooks 和 Service 函数调用时未提供泛型参数（如 useQuery<MyType>）
4. 接口定义与实际数据不匹配：interface 定义了字段但实际数据库返回结构不同，或反过来
5. Service 层与 Hooks 之间的类型不匹配：service 返回 A 类型但 hook 期望 B 类型
6. 可能为 null/undefined 的值未做判空处理：可选链和空值合并使用不当
7. 枚举不一致：字符串字面量应使用联合类型或 enum 但散落各处

## 规则
- 只输出确实有问题的条目。没有问题的不要输出，不要写确认性描述。
- 每条 finding 必须是一个需要修复的 bug 或违规
- 只输出 JSON，不要其他内容

## 输出格式（严格遵循）
\`\`\`json
{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"src/path/file.ts","line":42,"description":"问题","suggestion":"建议"}],"summary":{"critical":0,"high":0,"medium":0,"low":0}}
\`\`\``,
  },

  // ── 5. performance ──────────────────────────────────
  {
    id: "performance",
    label: "性能",
    buildPrompt: () =>
      `你是前端性能优化专家。对盲盒库存管理微信小程序（Taro + React + TypeScript + 微信云数据库）进行【性能】专项审查。

## 审查范围
全部 src/ 目录下文件，重点关注页面组件和 hooks

## 重点检查
1. 不必要的重渲染：
   - JSX 中内联创建对象 { style: { color: 'red' } } 或函数 onClick={() => ...}
   - 缺少 React.memo / useMemo / useCallback
   - Context value 每次渲染都创建新对象
2. N+1 查询模式：列表渲染中每个 item 都触发一次独立数据库请求
3. 无界查询：未设置 limit 的数据库查询，可能返回海量数据
4. 无限循环风险：useEffect 依赖设置不当导致无限循环
5. 大组件应拆分：单文件超过 300 行的组件应考虑拆分
6. 图片/资源未做懒加载或压缩
7. 列表渲染未使用虚拟列表（当列表可能超过 100 项时）

## 规则
- 只输出确实有问题的条目。没有问题的不要输出，不要写确认性描述。
- 每条 finding 必须是一个需要修复的 bug 或违规
- 只输出 JSON，不要其他内容

## 输出格式（严格遵循）
\`\`\`json
{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"src/path/file.ts","line":42,"description":"问题","suggestion":"建议"}],"summary":{"critical":0,"high":0,"medium":0,"low":0}}
\`\`\``,
  },

  // ── 6. platform-compat ─────────────────────────────
  {
    id: "platform-compat",
    label: "小程序兼容",
    buildPrompt: () =>
      `你是 Taro + 微信小程序开发专家。对盲盒库存管理微信小程序（Taro + React + TypeScript + 微信云数据库）进行【平台兼容性】专项审查。

## 审查范围
全部 src/ 目录下文件

## 重点检查
1. 浏览器 API 使用：window.、document.、navigator.、localStorage 等在小程序中不可用
   - 应使用 Taro.getApp()、Taro.getStorageSync() 等替代
2. Taro API vs wx API：
   - 是否有直接调用 wx.xxx 而非 Taro.xxx 的地方（H5 环境会报错）
   - 是否使用了 Taro 未封装的 wx 专有 API 且未做平台判断
3. 生命周期问题：
   - useEffect vs useDidShow/useDidHide 的使用场景是否正确
   - 页面 onLoad/onReady/onUnload 对应的 Taro hooks 是否正确使用
   - 每次页面显示时需要刷新的数据是否放在 useDidShow 而非 useEffect
4. H5 vs 小程序行为差异：
   - 路由跳转方式差异
   - CSS 样式差异（如 rpx vs px）
   - 组件名称差异
5. 条件编译：是否有需要平台判断但未处理的代码

## 规则
- 只输出确实有问题的条目。没有问题的不要输出，不要写确认性描述。
- 每条 finding 必须是一个需要修复的 bug 或违规
- 只输出 JSON，不要其他内容

## 输出格式（严格遵循）
\`\`\`json
{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"src/path/file.ts","line":42,"description":"问题","suggestion":"建议"}],"summary":{"critical":0,"high":0,"medium":0,"low":0}}
\`\`\``,
  },

  // ── 7. cloud-database ───────────────────────────────
  {
    id: "cloud-database",
    label: "云数据库专项",
    buildPrompt: () =>
      `你是微信云数据库专家。对盲盒库存管理微信小程序（Taro + React + TypeScript + 微信云数据库）进行【云数据库】专项审查。

## 审查范围
全部 src/services/ 文件及任何涉及数据库操作的代码

## 重点检查
1. read-then-write 模式：先读取再写入的原子性问题（如库存扣减应该用 _.inc() 而非先 get 再 set）
2. 连续 .where() 调用：第二个 .where() 会覆盖第一个条件而非叠加，应合并
3. 缺少分页限制：查询未设置 .limit() 或 .skip()，可能导致超时或内存溢出
4. 云调用错误处理：缺少 try/catch，或未处理网络异常
5. 事务使用：
   - 应该使用事务（涉及多文档原子操作）但未使用
   - 事务中做了非数据库操作（如发请求）
   - 事务未正确回滚
6. count() 调用未设 limit：大数据量 count 可能超时
7. 索引不匹配：查询条件未命中索引（如果能看到 schema）
8. 使用 update 而非 set 的场景不正确：部分更新 vs 全量更新混淆

## 规则
- 只输出确实有问题的条目。没有问题的不要输出，不要写确认性描述。
- 每条 finding 必须是一个需要修复的 bug 或违规
- 只输出 JSON，不要其他内容

## 输出格式（严格遵循）
\`\`\`json
{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"src/path/file.ts","line":42,"description":"问题","suggestion":"建议"}],"summary":{"critical":0,"high":0,"medium":0,"low":0}}
\`\`\``,
  },

  // ── 8. data-model ──────────────────────────────────
  {
    id: "data-model",
    label: "数据模型一致性",
    buildPrompt: () =>
      `你是数据架构专家。对盲盒库存管理微信小程序（Taro + React + TypeScript + 微信云数据库）进行【数据模型一致性】专项审查。

## 审查范围
src/services/ 下所有文件，包括旧文件（如 series.ts, items.ts 等）和新文件（如 series.service.ts）

## 重点检查
1. 新旧服务文件并存：
   - 旧文件 series.ts 和新文件 series.service.ts 是否同时存在
   - 是否有页面仍在 import 旧文件（如 from '../../services/series' 而非 from '../../services/series.service'）
2. 读写不同源：
   - 从新 model 读取数据但写入走旧 model，或反之
   - 查询使用的集合名与写入使用的集合名不一致
3. 集合名不一致：
   - 同一业务实体使用了不同的 collection name（如 'series' vs 'box_series'）
   - 集合名硬编码散落在各处而非集中在常量中
4. 字段名不一致：
   - 同一语义字段在不同地方使用不同名称（如 id vs _id vs seriesId）
5. 类型定义分散：同一数据模型的 interface 在多处重复定义

## 规则
- 只输出确实有问题的条目。没有问题的不要输出，不要写确认性描述。
- 每条 finding 必须是一个需要修复的 bug 或违规
- 只输出 JSON，不要其他内容

## 输出格式（严格遵循）
\`\`\`json
{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"src/path/file.ts","line":42,"description":"问题","suggestion":"建议"}],"summary":{"critical":0,"high":0,"medium":0,"low":0}}
\`\`\``,
  },

  // ── 9. state-mgmt ──────────────────────────────────
  {
    id: "state-mgmt",
    label: "状态管理",
    buildPrompt: () =>
      `你是 TanStack Query (React Query) 状态管理专家。对盲盒库存管理微信小程序（Taro + React + TypeScript + 微信云数据库）进行【状态管理】专项审查。

## 审查范围
全部 src/ 目录下使用 useQuery、useMutation、useInfiniteQuery 的文件

## 重点检查
1. staleTime / cacheTime (gcTime) 设置：
   - 未设置 staleTime 导致过度 refetch
   - staleTime 设置过长导致数据不一致
   - cacheTime 与 staleTime 关系不当
2. Query invalidation 时机：
   - mutation 成功后未 invalidate 相关 query
   - invalidate 范围过大（invalidate 全部而非特定 key）
   - 应该 invalidate 但使用了 refetch 的反模式
3. 竞态条件：
   - mutation 回调中引用了过期状态
   - 多个 mutation 并发时的顺序问题
4. 乐观更新（Optimistic Update）：
   - 乐观更新后 onError 未正确回滚
   - 乐观更新逻辑与实际响应结构不匹配
5. 不必要的 refetching：
   - useEffect 中手动 refetch 而非利用 staleTime
   - 页面切换时重复创建 query

## 规则
- 只输出确实有问题的条目。没有问题的不要输出，不要写确认性描述。
- 每条 finding 必须是一个需要修复的 bug 或违规
- 只输出 JSON，不要其他内容

## 输出格式（严格遵循）
\`\`\`json
{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"src/path/file.ts","line":42,"description":"问题","suggestion":"建议"}],"summary":{"critical":0,"high":0,"medium":0,"low":0}}
\`\`\``,
  },

  // ── 10. dead-code ──────────────────────────────────
  {
    id: "dead-code",
    label: "死代码检测",
    buildPrompt: () =>
      `你是代码清理专家。对盲盒库存管理微信小程序（Taro + React + TypeScript + 微信云数据库）进行【死代码检测】专项审查。

## 审查范围
全部 src/ 目录下文件

## 重点检查
1. 未被导入的文件：src/ 中存在但从未被任何其他文件 import 的 .ts/.tsx 文件
2. 未使用的 export：函数、类型、常量被 export 但从未被其他文件导入
3. 不可达代码：if (false) 块、return 之后的代码、永远不会执行的分支
4. 已废弃的文件：文件名含 .old.、.bak.、.deprecated.、.v1. 等标记
5. 注释中的 TODO/FIXME/HACK 累积过多（超过 5 个未处理的）
6. 未使用的 import：导入了但未在代码中使用的模块
7. 测试文件中 import 了已不存在的模块

## 规则
- 只输出确实有问题的条目。没有问题的不要输出，不要写确认性描述。
- 每条 finding 必须是一个需要修复的 bug 或违规
- 只输出 JSON，不要其他内容

## 输出格式（严格遵循）
\`\`\`json
{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"src/path/file.ts","line":42,"description":"问题","suggestion":"建议"}],"summary":{"critical":0,"high":0,"medium":0,"low":0}}
\`\`\``,
  },

  // ── 11. error-resilience ────────────────────────────
  {
    id: "error-resilience",
    label: "错误边界与韧性",
    buildPrompt: () =>
      `你是容错系统设计专家。对盲盒库存管理微信小程序（Taro + React + TypeScript + 微信云数据库）进行【错误边界与韧性】专项审查。

## 审查范围
全部 src/ 目录下文件

## 重点检查
1. React ErrorBoundary：
   - 是否有全局 ErrorBoundary 包裹路由
   - 关键组件是否有局部 ErrorBoundary
   - ErrorBoundary 的 fallback 是否用户友好
2. 未处理的 Promise 拒绝：
   - async 函数中缺少 .catch 或 try/catch
   - useEffect 中的 async 操作未捕获异常
3. 全局异常处理：
   - 是否有 Taro.onUnhandledRejection 或全局错误监听
   - 错误是否上报到监控系统
4. 网络故障恢复：
   - 云数据库/云函数调用失败后的重试逻辑
   - 离线状态检测和提示
   - 断线恢复后数据同步策略
5. 重试逻辑：
   - 云操作失败是否有重试
   - 重试次数是否有限制
   - 是否使用指数退避
6. 用户反馈：
   - 加载状态是否正确显示
   - 错误状态是否给用户反馈（Toast / Modal）
   - 空状态是否有占位提示

## 规则
- 只输出确实有问题的条目。没有问题的不要输出，不要写确认性描述。
- 每条 finding 必须是一个需要修复的 bug 或违规
- 只输出 JSON，不要其他内容

## 输出格式（严格遵循）
\`\`\`json
{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"src/path/file.ts","line":42,"description":"问题","suggestion":"建议"}],"summary":{"critical":0,"high":0,"medium":0,"low":0}}
\`\`\``,
  },

  // ── 12. dependency ──────────────────────────────────
  // Dimension 12 is handled separately via npm audit
  {
    id: "dependency",
    label: "依赖审计",
    buildPrompt: null, // handled by runDependencyAudit()
  },
];

// ── 解析 Claude 输出中的 JSON ──────────────────────────────
function parseJson(raw) {
  // Try to extract JSON from markdown code block
  const m = raw.match(/```json\s*([\s\S]*?)```/);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      /* fall through */
    }
  }
  // Try to parse raw as JSON directly
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  // Try to find first { ... } block
  const braceMatch = raw.match(/\{[\s\S]*?\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      /* fall through */
    }
  }
  return {
    findings: [],
    summary: { critical: 0, high: 0, medium: 0, low: 0 },
    _parse_error: true,
    _raw_preview: raw.slice(0, 500),
  };
}

// ── 执行单维度 Claude 审查 ─────────────────────────────────
function runClaudeReview(dimension) {
  const prompt = dimension.buildPrompt();
  const cmd = `claude -p ${sh(prompt)} --dangerously-skip-permissions --settings settings-minimal.json --output-format text 2>/dev/null`;

  try {
    const raw = execSync(cmd, {
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      cwd: ROOT,
      encoding: "utf-8",
    }).trim();

    return parseJson(raw);
  } catch (err) {
    return {
      findings: [],
      summary: { critical: 0, high: 0, medium: 0, low: 0 },
      _error: err.message.slice(0, 300),
    };
  }
}

// ── 维度 12: 依赖审计 (npm audit) ──────────────────────────
function runDependencyAudit() {
  try {
    const raw = execSync("npm audit --json 2>/dev/null", {
      timeout: 120000,
      maxBuffer: 5 * 1024 * 1024,
      cwd: ROOT,
      encoding: "utf-8",
    }).trim();

    const audit = JSON.parse(raw);

    // Check for deprecated packages
    let deprecatedFindings = [];
    try {
      const lsOut = execSync("npm ls --json --all 2>/dev/null", {
        timeout: 60000,
        maxBuffer: 5 * 1024 * 1024,
        cwd: ROOT,
        encoding: "utf-8",
      }).trim();
      const ls = JSON.parse(lsOut);
      deprecatedFindings = findDeprecated(ls);
    } catch {
      // npm ls may return non-zero exit code, that's okay
    }

    // Check for unused dependencies
    let unusedFindings = [];
    try {
      const pkgJson = JSON.parse(
        readFileSync(resolve(ROOT, "package.json"), "utf-8"),
      );
      const deps = Object.keys(pkgJson.dependencies || {});
      unusedFindings = findUnusedDeps(deps);
    } catch {
      // ignore
    }

    // Parse vulnerabilities
    const vulns = audit.vulnerabilities || {};
    const findings = [];

    for (const [pkg, info] of Object.entries(vulns)) {
      const severity = (info.severity || "medium").toUpperCase();
      const mappedSeverity =
        {
          CRITICAL: "CRITICAL",
          HIGH: "HIGH",
          MEDIUM: "MEDIUM",
          LOW: "LOW",
          INFO: "LOW",
        }[severity] || "MEDIUM";

      const advisories = info.via || [];
      const desc = Array.isArray(advisories)
        ? advisories
            .filter((a) => typeof a === "object")
            .map((a) => a.title || a.message || String(a))
            .join("; ")
        : String(advisories);

      findings.push({
        severity: mappedSeverity,
        file: "package.json",
        line: 0,
        description: `依赖漏洞: ${pkg}@${info.range || "?"} — ${desc || "see npm audit"}`,
        suggestion: `运行 npm audit fix 或手动升级 ${pkg}`,
      });
    }

    findings.push(...deprecatedFindings, ...unusedFindings);

    const critical = findings.filter((f) => f.severity === "CRITICAL").length;
    const high = findings.filter((f) => f.severity === "HIGH").length;
    const medium = findings.filter((f) => f.severity === "MEDIUM").length;
    const low = findings.filter((f) => f.severity === "LOW").length;

    return {
      findings,
      summary: { critical, high, medium, low },
    };
  } catch (err) {
    return {
      findings: [],
      summary: { critical: 0, high: 0, medium: 0, low: 0 },
      _error: err.message.slice(0, 300),
    };
  }
}

// ── 查找废弃包 ────────────────────────────────────────────
function findDeprecated(lsTree, findings = []) {
  if (lsTree && typeof lsTree === "object" && lsTree.deprecated) {
    findings.push({
      severity: "LOW",
      file: "package.json",
      line: 0,
      description: `废弃包: ${lsTree.name || "unknown"}@${lsTree.version || "?"} 已被标记为 deprecated`,
      suggestion: `查找 ${lsTree.name} 的替代包并迁移`,
    });
  }
  if (lsTree && lsTree.dependencies) {
    for (const dep of Object.values(lsTree.dependencies)) {
      findDeprecated(dep, findings);
    }
  }
  return findings;
}

// ── 查找未使用依赖（粗略检查） ─────────────────────────────
function findUnusedDeps(deps) {
  const findings = [];
  const skipPatterns = [
    "@tarojs",
    "@babel",
    "typescript",
    "eslint",
    "postcss",
    "tailwindcss",
    "webpack",
  ];

  for (const dep of deps) {
    if (skipPatterns.some((p) => dep.startsWith(p))) continue;

    try {
      const grepResult = execSync(
        `grep -r "${dep}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" src/ 2>/dev/null | head -1`,
        { timeout: 10000, cwd: ROOT, encoding: "utf-8" },
      ).trim();

      if (!grepResult) {
        findings.push({
          severity: "LOW",
          file: "package.json",
          line: 0,
          description: `未使用依赖: "${dep}" 在 src/ 中未发现 import 或 require`,
          suggestion: `确认 "${dep}" 是否仍需要，考虑从 dependencies 中移除`,
        });
      }
    } catch {
      // grep returns non-zero when no matches found — that's the "unused" case
      findings.push({
        severity: "LOW",
        file: "package.json",
        line: 0,
        description: `可能未使用依赖: "${dep}" 在 src/ 中未发现引用`,
        suggestion: `确认 "${dep}" 是否仍需要，考虑从 dependencies 中移除`,
      });
    }
  }

  return findings;
}

// ── 批量执行（串行，execSync 阻塞事件循环） ──────────────────
// 注：因使用 execSync，各维度实际串行执行。PARALLEL 仅控制批次大小。
async function runInBatches(dimensions, batchSize) {
  const results = {};
  let completed = 0;

  for (let i = 0; i < dimensions.length; i += batchSize) {
    const batch = dimensions.slice(i, i + batchSize);
    const promises = batch.map(async (dim) => {
      const dimId = dim.id;

      if (dimId === "dependency") {
        // Dimension 12: npm audit
        console.log(`  📦 [${dimId}] 运行 npm audit...`);
        const result = runDependencyAudit();
        results[dimId] = result;
        completed++;
        console.log(`  ✅ [${dimId}] 完成 (${completed}/${dimensions.length})`);
        return;
      }

      // Dimensions 1-11: Claude review
      console.log(`  🔍 [${dimId}] 开始审查 — ${dim.label}...`);
      return new Promise((resolve) => {
        // Use setImmediate to allow batch parallelism
        setImmediate(() => {
          const result = runClaudeReview(dim);
          results[dimId] = result;
          completed++;
          const count = (result.findings || []).length;
          console.log(
            `  ✅ [${dimId}] 完成 — ${count} 个发现 (${completed}/${dimensions.length})`,
          );
          resolve();
        });
      });
    });

    await Promise.all(promises);
  }

  return results;
}

// ── 合并结果并生成报告 ──────────────────────────────────────
function mergeAndReport(allResults) {
  const combined = {
    generated_at: new Date().toISOString(),
    dimensions: {},
    totals: { critical: 0, high: 0, medium: 0, low: 0 },
    all_findings: [],
  };

  for (const [dimId, result] of Object.entries(allResults)) {
    const findings = result.findings || [];
    const summary = result.summary || {};

    combined.dimensions[dimId] = {
      label: DIMENSIONS.find((d) => d.id === dimId)?.label || dimId,
      findings,
      summary,
      _error: result._error || null,
      _parse_error: result._parse_error || null,
    };

    // 用实际 findings 数量而非 Claude 返回的 summary（两者可能不一致）
    for (const f of findings) {
      const sev = (f.severity || "LOW").toUpperCase();
      if (sev === "CRITICAL") combined.totals.critical++;
      else if (sev === "HIGH") combined.totals.high++;
      else if (sev === "MEDIUM") combined.totals.medium++;
      else combined.totals.low++;
    }

    // Tag each finding with its dimension
    for (const f of findings) {
      combined.all_findings.push({ ...f, dimension: dimId });
    }
  }

  combined.total_findings = combined.all_findings.length;

  return combined;
}

// ── 打印最终汇总 ────────────────────────────────────────────
function printSummary(combined) {
  console.log("\n" + "═".repeat(64));
  console.log("  📋 12 维度全量代码审查 — 汇总报告");
  console.log("═".repeat(64));

  // Per-dimension breakdown
  console.log("\n  维度明细:");
  console.log("  ┌────────────────────┬──────┬──────┬──────┬──────┬───────┐");
  console.log("  │ 维度               │ CRIT │ HIGH │ MED  │ LOW  │ Total │");
  console.log("  ├────────────────────┼──────┼──────┼──────┼──────┼───────┤");

  for (const [dimId, dimData] of Object.entries(combined.dimensions)) {
    const s = dimData.summary || {};
    const total =
      (s.critical || 0) + (s.high || 0) + (s.medium || 0) + (s.low || 0);
    const label = dimData.label || dimId;
    const err = dimData._error ? " ⚠" : "";
    const parseErr = dimData._parse_error ? " 📛" : "";
    console.log(
      `  │ ${label.padEnd(18)} │ ${String(s.critical || 0).padStart(4)} │ ${String(s.high || 0).padStart(4)} │ ${String(s.medium || 0).padStart(4)} │ ${String(s.low || 0).padStart(4)} │ ${String(total).padStart(5)} │${err}${parseErr}`,
    );
  }

  console.log("  ├────────────────────┼──────┼──────┼──────┼──────┼───────┤");
  const t = combined.totals;
  const totalAll = t.critical + t.high + t.medium + t.low;
  console.log(
    `  │ ${"合计".padEnd(18)} │ ${String(t.critical).padStart(4)} │ ${String(t.high).padStart(4)} │ ${String(t.medium).padStart(4)} │ ${String(t.low).padStart(4)} │ ${String(totalAll).padStart(5)} │`,
  );
  console.log("  └────────────────────┴──────┴──────┴──────┴──────┴───────┘");

  // CRITICAL / HIGH details
  const blockers = combined.all_findings.filter(
    (f) => f.severity === "CRITICAL" || f.severity === "HIGH",
  );

  if (blockers.length > 0) {
    console.log(`\n  🚨 阻断性问题 (${blockers.length} 个):`);
    for (const f of blockers.slice(0, 20)) {
      console.log(
        `    [${f.severity}][${f.dimension}] ${f.file}${f.line ? ":" + f.line : ""}`,
      );
      console.log(`      ${f.description}`);
    }
    if (blockers.length > 20) {
      console.log(
        `    ... 及另外 ${blockers.length - 20} 个，详见 review-combined.json`,
      );
    }
  }

  // Errors
  const errored = Object.entries(combined.dimensions).filter(
    ([, d]) => d._error || d._parse_error,
  );
  if (errored.length > 0) {
    console.log(`\n  ⚠ 有 ${errored.length} 个维度执行出错:`);
    for (const [dimId, d] of errored) {
      console.log(`    [${dimId}] ${d._error || "JSON parse error"}`);
    }
  }

  console.log("\n" + "═".repeat(64));

  if (t.critical > 0) {
    console.log(`  ❌ 发现 ${t.critical} 个 CRITICAL 问题，必须修复！`);
  } else if (t.high > 0) {
    console.log(`  ⚠️  发现 ${t.high} 个 HIGH 问题，建议优先处理。`);
  } else {
    console.log("  ✅ 无阻断性问题。");
  }

  console.log("═".repeat(64) + "\n");
}

// ── 主函数 ──────────────────────────────────────────────────
async function main() {
  console.log("\n" + "🔬 12 维度全量代码审查");
  console.log(`   并发数: ${PARALLEL}`);
  console.log(`   超时: ${TIMEOUT_MS / 1000}s / 维度`);
  console.log(`   项目根: ${ROOT}`);
  console.log(`   输出目录: ${LOOP_DIR}`);
  console.log("");

  const startTime = Date.now();

  // Run all dimensions in batches
  const allResults = await runInBatches(DIMENSIONS, PARALLEL);

  // Save individual results
  for (const [dimId, result] of Object.entries(allResults)) {
    const outPath = resolve(LOOP_DIR, `review-${dimId}.json`);
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`  💾 已保存: review-${dimId}.json`);
  }

  // Merge all findings
  const combined = mergeAndReport(allResults);

  // Save combined result
  const combinedPath = resolve(LOOP_DIR, "review-combined.json");
  writeFileSync(combinedPath, JSON.stringify(combined, null, 2));
  console.log(`\n  💾 合并结果已保存: review-combined.json`);

  // Print final summary
  printSummary(combined);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  ⏱  总耗时: ${elapsed}s\n`);

  // Exit code
  if (combined.totals.critical > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
