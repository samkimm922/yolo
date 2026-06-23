/**
 * config.js — 统一配置加载器
 *
 * 默认从 scripts/yolo/config.yaml 读取配置，也支持 SDK 调用方传入配置路径。
 * 不依赖外部 YAML 库，使用内置简单解析器。
 *
 * 用法:
 *   import { config, loadConfig } from './lib/config.js';
 *   console.log(config.project.name);
 *   const fresh = loadConfig(true); // 强制重新加载（绕过缓存）
 *   const custom = loadConfig({ path: './yolo.config.yaml', forceReload: true });
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findProjectRoot(startDir) {
  let dir = resolve(startDir);
  const root = resolve('/');
  while (dir !== root) {
    if (existsSync(join(dir, 'package.json'))) {
      // A dist/package.json copied by the build is not the project root;
      // prefer the parent directory when it also contains package.json.
      if (basename(dir) === 'dist') {
        const parent = dirname(dir);
        if (existsSync(join(parent, 'package.json'))) return parent;
      }
      return dir;
    }
    dir = dirname(dir);
  }
  // Fallback to the legacy heuristic when no package.json is found.
  return resolve(__dirname, '..', '..', '..');
}

function resolveDefaultConfigPath(startDir) {
  const projectRoot = findProjectRoot(startDir);
  const rootConfig = resolve(projectRoot, 'config.yaml');
  if (existsSync(rootConfig)) return rootConfig;

  const distConfig = basename(projectRoot) === 'dist'
    ? resolve(projectRoot, 'config.yaml')
    : resolve(projectRoot, 'dist', 'config.yaml');
  if (existsSync(distConfig)) return distConfig;

  return rootConfig;
}

const DEFAULT_CONFIG_PATH = resolveDefaultConfigPath(__dirname);
const ENV_CONFIG_PATH = process.env.YOLO_CONFIG ? resolve(process.env.YOLO_CONFIG) : null;
const CONFIG_PATH = ENV_CONFIG_PATH || DEFAULT_CONFIG_PATH;

// ---- 默认值（当 config.yaml 不存在或解析失败时使用） ----
const DEFAULTS = {
  version: '2.0',

  project: {
    name: 'project',
    root: '../..',
    src: 'src',
    source_roots: ['src'],
    source_extensions: ['.ts', '.tsx', '.js', '.jsx'],
    framework: 'generic',
    exclude: ['node_modules', 'dist', '.git'],
  },

  build: {
    business_globs: [],
    type_check: 'npx tsc --noEmit',
    lint: '',
    test: 'node --import tsx --test __tests__/*.test.ts',
    build: 'npm run build --silent',
  },

  ai: {
    executor: 'claude',
    model: 'claude-sonnet-4-6',
    timeout_ms: 480000,
    settings: 'settings-minimal.json',
    claude_permission_mode: 'acceptEdits',
  },

  gate: {
    timeout: {
      type_check: 120000,
      lint: 90000,
      test: 120000,
      build: 240000,
    },
    max_files: 5,
    max_lines_per_file: 150,
  },

  runner: {
    max_retries: { 1: 3, 2: 1 },
    circuit_breaker: 2,
    session_timeout_h: 4,
    task_timeout_m: 30,
    task_timeout_floor_s: 120,
    stash_prefix: 'temp-stash-for-',
  },

  state: {
    dir: 'state',
    max_events: 500,
    max_changes: 500,
    max_runs: 100,
  },

  docs: {
    dir: '.',
    auto_generate: true,
    archive_max: 50,
  },

  learn: {
    enabled: true,
    auto_evolve: true,
    decay_days: 10,
    min_confidence: 3,
  },

  progress_server: {
    port: 3456,
  },
};

// ============================================================
// 简单 YAML 解析器（只处理 YOLO 配置文件需要的子集）
// ============================================================

/**
 * 解析 YAML 字符串，返回 JavaScript 对象。
 * 支持: 嵌套缩进（2空格/4空格/制表符）、字符串、数字、布尔、数组（- item）、注释（#）。
 */
function parseYAML(yaml) {
  const lines = yaml.split('\n');
  const root = Object();
  // 栈: [{ obj, indent, key }], key 是该节点在父对象中的属性名
  const stack = [{ obj: root, indent: -1, key: null }];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trimEnd();

    // 跳过空行或纯注释行
    if (trimmed === '' || /^\s*#/.test(trimmed)) continue;

    // 行内注释处理
    let content = trimmed;
    const commentIdx = findCommentIndex(content);
    if (commentIdx !== -1) {
      content = content.substring(0, commentIdx).trimEnd();
      if (content === '') continue;
    }

    const indent = countIndent(rawLine);
    const trimmedStart = content.trimStart();

    // ---- 处理 - item 数组行（必须在 pop 之前） ----
    if (trimmedStart.startsWith('- ')) {
      const val = parseScalar(trimmedStart.substring(2).trim());

      // 找到所属数组: 回退到 indent 小于当前行的栈节点
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }

      const top = stack[stack.length - 1];
      // 如果栈顶是空对象占位符 → 转换为数组
      if (!Array.isArray(top.obj) && top.key !== null &&
          typeof top.obj === 'object' && Object.keys(top.obj).length === 0) {
        // 需要找到这个空对象实际属于哪个父节点
        // top.obj 本身是空对象，而 top.key 是它在父节点中的键
        // 从栈中拿到父节点（往下找一层）
        // top 的父节点是 stack[stack.length - 2]（如果有的话）
        const parentNode = stack.length >= 2 ? stack[stack.length - 2].obj : root;
        parentNode[top.key] = [];
        top.obj = parentNode[top.key]; // 原地替换引用
      }

      if (Array.isArray(top.obj)) {
        top.obj.push(val);
      }
      continue;
    }

    // ---- key: value 行 ----
    const colonIdx = findKeyColonIndex(content);
    if (colonIdx === -1) continue;

    const key = content.substring(0, colonIdx).trim();
    const rawValue = content.substring(colonIdx + 1).trim();

    // 回退栈：当前 indent 小于或等于栈顶 indent 时弹出
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;

    if (rawValue === '' || rawValue === undefined) {
      // 空的 value → 嵌套对象的父 key
      const newObj = Object();
      parent[key] = newObj;
      stack.push({ obj: newObj, indent, key });
    } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      // 单行数组 [a, b, c]
      parent[key] = parseInlineArray(rawValue);
    } else if (rawValue.startsWith('[')) {
      // Malformed inline array (opening '[' without matching closing ']').
      // Skip the assignment so deepMerge keeps the default value. Without
      // this guard the value would fall through to parseScalar and silently
      // become a string (e.g. "[src, test"), which later crashes consumers
      // that expect an array (e.g. scanner.ts sourceRoots.some()).
      console.warn(`[config] 跳过格式错误的内联数组 (缺少 ']'): ${key}: ${rawValue}`);
    } else {
      // 标量值
      parent[key] = parseScalar(rawValue);
    }
  }

  return root;
}

/**
 * 查找行内注释起始位置（忽略引号内内容）。
 */
function findCommentIndex(line) {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    else if (ch === '#' && !inSingleQuote && !inDoubleQuote) return i;
  }
  return -1;
}

/**
 * 计算行首缩进量（空格数）。
 */
function countIndent(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 2; // tab 当作 2 空格
    else break;
  }
  return n;
}

/**
 * 查找 key: value 中的冒号位置（忽略引号内的冒号）。
 */
function findKeyColonIndex(line) {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    else if (ch === ':' && !inSingleQuote && !inDoubleQuote) return i;
  }
  return -1;
}

/**
 * 解析 YAML 标量值（字符串、数字、布尔）。
 */
function parseScalar(val) {
  if (val === null || val === undefined || val === '') return '';
  const v = val.trim();

  // 去掉引号
  if ((v.startsWith("'") && v.endsWith("'")) ||
      (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1);
  }

  // null
  if (v === 'null' || v === '~') return null;

  // 布尔值
  if (v === 'true' || v === 'TRUE' || v === 'True' || v === 'yes' || v === 'Yes') return true;
  if (v === 'false' || v === 'FALSE' || v === 'False' || v === 'no' || v === 'No') return false;

  // 整数：纯数字（允许负号）
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);

  // 浮点数
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);

  return v;
}

/**
 * 解析单行数组 [a, b, "c"]
 */
function parseInlineArray(raw) {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];

  const items = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
    } else if (ch === ',' && !inSingleQuote && !inDoubleQuote) {
      items.push(parseScalar(current.trim()));
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') {
    items.push(parseScalar(current.trim()));
  }

  return items;
}

// ============================================================
// 深度合并（defaults 为底，parsed 覆盖）
// ============================================================

function deepMerge(base, override, keyPath = '') {
  if (override === undefined || override === null) return base;
  // Array-typed defaults must stay arrays. A scalar/object override from a
  // hand-written YAML config would otherwise crash consumers that call array
  // methods such as .map()/.some().
  if (Array.isArray(base) && !Array.isArray(override)) {
    const received = typeof override === 'object' ? '对象' : '标量';
    console.warn(`[config] 跳过类型不匹配的字段${keyPath ? ` (${keyPath})` : ''}: 期望数组, 收到${received}`);
    return base;
  }
  if (isPlainObject(base) && !isPlainObject(override)) {
    const received = Array.isArray(override) ? '数组' : '标量';
    console.warn(`[config] 跳过类型不匹配的字段${keyPath ? ` (${keyPath})` : ''}: 期望对象, 收到${received}`);
    return base;
  }
  if (base !== undefined && base !== null && typeof base !== 'object') {
    const expected = typeof base;
    const received = Array.isArray(override) ? '数组' : typeof override === 'object' ? '对象' : typeof override;
    const compatible = typeof override === expected && (expected !== 'number' || Number.isFinite(override));
    if (!compatible) {
      console.warn(`[config] 跳过类型不匹配的字段${keyPath ? ` (${keyPath})` : ''}: 期望${expected}, 收到${received}`);
      return base;
    }
  }
  // If override is an array or scalar, use it directly (replaces base)
  if (Array.isArray(override) || typeof override !== 'object') {
    return override;
  }
  // Both are plain objects — merge recursively
  if (typeof base === 'object' && base !== null && !Array.isArray(base)) {
    const result = { ...base };
    for (const key of Object.keys(override)) {
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      result[key] = deepMerge(base[key], override[key], childPath);
    }
    return result;
  }
  // base is scalar/undefined/null but override is object — return override
  return override;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseConfigContent(content, path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return JSON.parse(content);
  if (ext === '.yaml' || ext === '.yml') return parseYAML(content);

  try {
    return JSON.parse(content);
  } catch (_) {
    return parseYAML(content);
  }
}

const RECOGNIZED_CONFIG_KEYS = new Set([
  'version',
  'schema_version',
  'project',
  'paths',
  'policy',
  'build',
  'ai',
  'gate',
  'runner',
  'state',
  'docs',
  'learn',
  'progress_server',
]);

function parsedConfigWarnings(parsed) {
  if (!isPlainObject(parsed)) return ['配置不是对象'];

  const keys = Object.keys(parsed);
  if (keys.length === 0) return ['配置为空'];

  const hasRecognizedKey = keys.some((key) => RECOGNIZED_CONFIG_KEYS.has(key));
  const warnings = [];
  if (!hasRecognizedKey) warnings.push('缺少可识别的顶层配置字段');
  if (Object.prototype.hasOwnProperty.call(parsed, 'build')) {
    if (!isPlainObject(parsed.build) || Object.keys(parsed.build).length === 0) {
      warnings.push('build 段为空');
    }
  }
  return warnings;
}

// ============================================================
// 公共 API
// ============================================================

/**
 * 配置单例 — 模块加载时自动初始化。
 * 使用 `export let`，因此 loadConfig(true) 后 import 方会看到新引用。
 */
export let config;
let loadedConfigPath;

/**
 * Public options accepted by {@link loadConfig}.
 *
 * `loadConfig` is re-exported through the SDK entry point (`sdk.ts`), so this
 * type is part of the published contract. It accepts either an options object
 * or (for backwards compatibility) a bare boolean meaning "force reload".
 */
export interface LoadConfigOptions {
  /** Path to a yolo config file. Defaults to the canonical config path. */
  path?: string;
  /** Alias of `path` accepted by the loader for convenience. */
  configPath?: string;
  /** Bypass the config cache and reload from disk. */
  forceReload?: boolean;
}

/**
 * 标准化配置加载参数，兼容旧的 loadConfig(true) 调用。
 */
export function normalizeLoadConfigOptions(input: LoadConfigOptions | boolean | null | undefined = undefined) {
  if (input === null || input === undefined) {
    return { forceReload: false, path: CONFIG_PATH };
  }

  if (typeof input === 'boolean') {
    return { forceReload: input, path: CONFIG_PATH };
  }

  const rawPath = input.path || input.configPath || process.env.YOLO_CONFIG || CONFIG_PATH;
  return {
    forceReload: Boolean(input.forceReload),
    path: isAbsolute(rawPath) ? rawPath : resolve(rawPath),
  };
}

/**
 * 加载并返回合并后的配置对象。
 * @param {boolean|object} options - true 表示强制重载；对象支持 path/configPath/forceReload。
 * @returns {object} 配置对象
 */
export function loadConfig(options: LoadConfigOptions | boolean | null | undefined = undefined) {
  const { forceReload, path } = normalizeLoadConfigOptions(options);

  if (config !== undefined && loadedConfigPath === path && !forceReload) {
    return config;
  }

  let parsed = Object();
  let parsedFromFile = false;

  try {
    const content = readFileSync(path, 'utf-8');
    parsed = parseConfigContent(content, path);
    parsedFromFile = true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`[config] ${path} 不存在，使用默认配置`);
    } else {
      console.warn(`[config] ${path} 配置解析失败/为空: ${err.message}；回退默认，可能导致命令不可用`);
    }
  }

  if (parsedFromFile) {
    const warnings = parsedConfigWarnings(parsed);
    if (warnings.length > 0) {
      console.warn(`[config] ${path} 配置解析失败/为空: ${warnings.join('；')}；回退默认，可能导致命令不可用`);
    }
  }

  config = deepMerge(DEFAULTS, parsed);
  loadedConfigPath = path;
  return config;
}

// 模块加载时自动初始化 config
loadConfig(true);

/**
 * 获取配置路径（方便其他模块引用）。
 */
export { CONFIG_PATH, DEFAULT_CONFIG_PATH };
