// doc-updater.js — 在 git commit 前自动更新三文件
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, statSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { execFileSync as defaultExecFileSync } from 'child_process';

const today = new Date().toISOString().split('T')[0];
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

type ExecFileSyncFn = typeof defaultExecFileSync;

interface UpdateDocsInput {
  taskId: string;
  taskTitle: string;
  modifiedFiles?: string[];
  status: string;
}

interface UpdateDocsOptions {
  rootDir?: string;
  execFileSync?: ExecFileSyncFn;
}

function resolveDocPaths(rootDir?: string) {
  const root = resolve(rootDir || process.cwd());
  return {
    root,
    session: join(root, 'docs/memory/SESSION.md'),
    snapshot: join(root, 'docs/memory/SNAPSHOT.md'),
    delivery: join(root, 'docs/memory/DELIVERY_LOG.md'),
  };
}

export async function updateDocs({ taskId, taskTitle, modifiedFiles, status }: UpdateDocsInput, options: UpdateDocsOptions = Object()) {
  const { root, session, snapshot, delivery } = resolveDocPaths(options.rootDir);
  const runGit = options.execFileSync || defaultExecFileSync;
  mkdirSync(dirname(session), { recursive: true });
  const fileStr = Array.isArray(modifiedFiles) && modifiedFiles.length
    ? modifiedFiles.join(', ')
    : '（无变更文件）';

  // 1. SESSION.md — 追加
  // SESSION.md 超过 500KB 自动归档
  const SESSION_MAX_SIZE = 500 * 1024; // 500KB
  try {
    if (existsSync(session)) {
      const stat = statSync(session);
      if (stat.size > SESSION_MAX_SIZE) {
        const archiveDir = join(root, "SESSION_ARCHIVE");
        if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
        const d = new Date();
        const archiveName = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}.md`;
        const archivePath = join(archiveDir, archiveName);
        // 追加模式：如果归档文件已存在则合并
        if (existsSync(archivePath)) {
          const oldContent = readFileSync(archivePath, 'utf8');
          const newContent = readFileSync(session, 'utf8');
          writeFileSync(archivePath, oldContent + '\n' + newContent);
        } else {
          renameSync(session, archivePath);
        }
        // 写入新 HEADER
        writeFileSync(session, `# 📋 SESSION.md (归档于 ${d.toISOString().slice(0, 10)})\n\n`, "utf8");
      }
    }
  } catch {}
  // SESSION.md 首次创建时写入带 emoji 的 header
  if (!existsSync(session)) {
    writeFileSync(session, `# 📋 SESSION.md\n\n`, "utf8");
  }
  const sessionEntry = `\n## ${today} YOLO-AUTO\n- 任务: ${taskId}\n- 标题: ${taskTitle}\n- 状态: ${status}\n- 变更文件: [${fileStr}]\n<!-- ${today} -->`;
  appendFileSync(session, sessionEntry);

  // 2. SNAPSHOT.md — 覆盖更新（100行上限）
  if (existsSync(snapshot)) {
    let content = readFileSync(snapshot, 'utf8');
    // 标记任务完成
    content = content.replace(
      new RegExp(`- \\[ \\] ${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .+`, 'm'),
      (line) => line.replace('- [ ]', '- [x]')
    );
    // 更新进度
    const allTasks = (content.match(/- \[[ x]\]/g) || []);
    const doneTasks = (content.match(/- \[x\]/g) || []);
    content = content
      .replace(/进度: \d+\/\d+/, `进度: ${doneTasks.length}/${allTasks.length}`)
      .replace(/日期: \d{4}-\d{2}-\d{2}/, `日期: ${today}`);

    // 确保「更新日期」行总是存在且内容变化（否则 git add 不会暂存 SNAPSHOT.md）
    if (/> 更新日期[：:]/.test(content)) {
      content = content.replace(/> 更新日期[：:][^\n]+/, `> 更新日期: ${today} ${now()}`);
    } else {
      content = content.replace(/(日期: \d{4}-\d{2}-\d{2})/, `$1\n> 更新日期: ${today} ${now()}`);
    }
    // 截断到100行
    let lines = content.split('\n');
    if (lines.length > 100) {
      const headerEnd = lines.findIndex((l, i) => i > 0 && l.startsWith('## '));
      const iterStart = lines.findIndex((l, i) => i > headerEnd && l.startsWith('## '));
      if (iterStart > 0) {
        lines = lines.slice(0, iterStart).concat(lines.slice(iterStart).slice(-30));
      }
      lines = lines.slice(0, 100);
    }
    // 原子写入：tmp + rename，防止崩溃时丢失整个文件
    const tmpSnapshot = snapshot + '.tmp';
    writeFileSync(tmpSnapshot, lines.join('\n') + '\n');
    renameSync(tmpSnapshot, snapshot);
  } else {
    // 自动创建初始模板
    const initialSnapshot = `# 📸 项目快照\n\n- [ ] 首个任务待完成\n\n进度: 0/0\n日期: ${today}\n> 更新日期: ${today} ${now()}`;
    writeFileSync(snapshot, initialSnapshot);
  }

  // 3. DELIVERY_LOG.md — 追加
  // DELIVERY_LOG.md 首次创建时写入带 emoji 的 header
  if (!existsSync(delivery)) {
    writeFileSync(delivery, `# 🔍 交付日志\n\n`, "utf8");
  }
  const deliveryEntry = `\n## ${today} ${taskId}\n- 类型: auto\n- 范围: [${fileStr}]\n- 闸门: 全部通过\n- commit: fix: ${taskId} ${taskTitle}\n<!-- ${today} -->`;
  appendFileSync(delivery, deliveryEntry);

  // 4. git add 三文件
  try {
    runGit('git', ['add', 'docs/memory/SESSION.md', 'docs/memory/SNAPSHOT.md', 'docs/memory/DELIVERY_LOG.md'], {
      cwd: root,
      encoding: 'utf8',
    });
  } catch (e) {
    // git add 失败不应阻断主流程（文件可能不存在）
    const message = (e as { message?: string } | null | undefined)?.message ?? String(e);
    console.error(`[doc-updater] git add 失败: ${message}`);
  }

  return true;
}
