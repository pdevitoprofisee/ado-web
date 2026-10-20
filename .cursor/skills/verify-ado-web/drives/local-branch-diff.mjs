// Proves the local repositories feature against the fixture that launch.mjs builds:
// /repos lists `sample`, its branch diff shows both changed files, its history
// lists the branch commits, and none of it writes to the repository.

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'

export default async ({ page, url, run, shot, note, expect }) => {
  const repo = join(run.reposRoot, 'sample')
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  const before = { head: git('rev-parse', 'HEAD'), index: statSync(join(repo, '.git', 'index')).mtimeMs }
  note(`fixture HEAD ${before.head}`)

  await page.goto(`${url}/repos`)
  const row = page.locator('[data-repo-slug="sample"]')
  await row.waitFor({ timeout: 30_000 })
  await shot('repos-list')
  expect((await row.innerText()).includes('feature/verify'), 'the sample row names its current branch')

  await row.locator('a').first().click()
  await page.waitForURL(`${url}/repos/sample**`)
  const files = page.getByRole('list', { name: 'Changed files' })
  await files.waitFor({ timeout: 30_000 })
  const fileText = await files.innerText()
  expect(fileText.includes('app.js') && fileText.includes('notes.md'), 'both changed files are listed')
  await page.getByText('verify-marker', { exact: false }).first().waitFor({ timeout: 30_000 })
  expect(true, 'the diff body shows the changed line')
  expect(await page.getByText('feature/verify').first().isVisible(), 'the header names the branch')
  await shot('branch-diff')

  await page.locator('a[href$="/repos/sample/commits"]').first().click()
  await page.waitForURL(`${url}/repos/sample/commits**`)
  await page.getByText('docs: add notes').first().waitFor({ timeout: 30_000 })
  expect(await page.getByText('feat: change the greeting').first().isVisible(), 'history lists both branch commits')
  await shot('commit-history')

  const after = { head: git('rev-parse', 'HEAD'), index: statSync(join(repo, '.git', 'index')).mtimeMs }
  expect(after.head === before.head, 'HEAD did not move')
  expect(after.index === before.index, '.git/index was not written')
  expect(git('status', '--porcelain') === '', 'the working tree is still clean')
}
