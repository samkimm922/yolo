#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

interface Args {
  repo?: string
  since?: string
  until?: string
  output?: string
}

interface Commit {
  hash: string
  author: string
  date: string
  message: string
  added: number
  deleted: number
}

function parseCommandLineArgs(): Args {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      output: { type: 'string' }
    }
  })
  return values
}

function getCommits(repo: string, since: string, until: string): Commit[] {
  const cmd = `git -C "${repo}" log --numstat --pretty=format:"%H|%an|%ad|%s" --date=short --since="${since}" --until="${until}"`
  const output = execSync(cmd, { encoding: 'utf-8' }).trim()
  if (!output) return []

  const commits: Commit[] = []
  const lines = output.split('\n')
  let i = 0
  while (i < lines.length) {
    if (lines[i].includes('|')) {
      const [hash, author, date, message] = lines[i].split('|')
      let added = 0
      let deleted = 0
      i++
      while (i < lines.length && !lines[i].includes('|')) {
        if (lines[i].trim()) {
          const [add, del] = lines[i].split('\t')
          if (add !== '-') added += parseInt(add, 10)
          if (del !== '-') deleted += parseInt(del, 10)
        }
        i++
      }
      commits.push({ hash, author, date, message, added, deleted })
    } else {
      i++
    }
  }
  return commits
}

function generateMarkdown(commits: Commit[]): string {
  if (commits.length === 0) return '# Git Weekly Report\n\nNo commits found in this period.\n'

  const byAuthor = commits.reduce<Record<string, Commit[]>>((acc, commit) => {
    if (!acc[commit.author]) acc[commit.author] = []
    acc[commit.author].push(commit)
    return acc
  }, {})

  const totalCommits = commits.length
  const totalAdded = commits.reduce((sum, c) => sum + c.added, 0)
  const totalDeleted = commits.reduce((sum, c) => sum + c.deleted, 0)
  const byType = commits.reduce<Record<string, number>>((acc, c) => {
    const match = c.message.match(/^(feat|fix|docs|style|refactor|test|chore)(\(|:)/)
    const type = match ? match[1] : 'other'
    acc[type] = (acc[type] || 0) + 1
    return acc
  }, {})

  let md = '# Git Weekly Report\n\n'
  md += `**Summary:** ${totalCommits} commits | +${totalAdded} -${totalDeleted} lines\n\n`
  md += '**Commit Types:**\n'
  for (const [type, count] of Object.entries(byType)) {
    md += `- ${type}: ${count}\n`
  }
  md += '\n'
  for (const [author, authorCommits] of Object.entries(byAuthor)) {
    md += `## ${author}\n\n`
    for (const commit of authorCommits) {
      md += `- **${commit.date}** (+${commit.added} -${commit.deleted}) - ${commit.message}\n`
    }
    md += '\n'
  }
  return md
}

function main(): void {
  const args = parseCommandLineArgs()

  if (!args.repo || !args.since || !args.until) {
    console.error('Usage: cli-git-weekly --repo <path> --since <date> --until <date> [--output <file>]')
    process.exit(1)
  }

  const commits = getCommits(args.repo, args.since, args.until)
  const markdown = generateMarkdown(commits)

  if (args.output) {
    writeFileSync(args.output, markdown, 'utf-8')
  } else {
    console.log(markdown)
  }
}

main()