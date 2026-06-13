import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = join(__dirname, 'fixed-issues-index.json');

function loadIndex() {
  if (!existsSync(INDEX_FILE)) return { version: 1, entries: [] };
  try { return JSON.parse(readFileSync(INDEX_FILE, 'utf-8')); }
  catch { return { version: 1, entries: [] }; }
}

function saveIndex(index) {
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

/**
 * 检查一个 finding 是否已被修复
 * @param {string} file - 目标文件路径
 * @param {number} line - 问题所在行号
 * @param {string} description - 问题描述
 * @returns {boolean}
 */
export function isAlreadyFixed(file, line, description) {
  const index = loadIndex();
  const descPrefix = (description || '').slice(0, 40);
  return index.entries.some(e => {
    // 文件匹配且描述前缀匹配（同一 bug 的不同描述通常前 40 字相似）
    return e.file === file &&
           Math.abs(e.line - line) <= 2 && // 行号允许 2 行误差
           e.description_prefix === descPrefix;
  });
}

/**
 * 添加已修复 issue 到索引
 * @param {object} task - PRD task 对象
 * @param {string} commitHash - git commit hash
 */
export function addFixedIssue(task, commitHash) {
  const index = loadIndex();
  const targetFile = task.constraints?.target_file || '';

  // 从 description 中提取行号（格式通常是 "file.ts:123"）
  const lineMatch = (task.description || '').match(/:(\d+)/);
  const line = lineMatch ? parseInt(lineMatch[1], 10) : 0;
  const descPrefix = (task.description || '').slice(0, 40);

  // 避免重复添加
  const exists = index.entries.some(e =>
    e.task_id === task.id && e.file === targetFile
  );
  if (exists) return;

  index.entries.push({
    task_id: task.id,
    file: targetFile,
    line,
    description_prefix: descPrefix,
    commit_hash: commitHash || '',
    fixed_at: new Date().toISOString(),
  });

  saveIndex(index);
}
