#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseCorpus, retrieve } from './retrieval.mjs'
import { compareResults } from './score.mjs'

const DEFAULT_BEFORE_URL = 'https://docs.porter.run'

const usage = `Usage:
  node evals/agent-app-creation/run.mjs \\
    --after-url https://porter-preview.mintlify.site \\
    --json /tmp/porter-agent-app-creation.json \\
    --markdown /tmp/porter-agent-app-creation.md

Options:
  --before-url URL    Live documentation origin (default: https://docs.porter.run).
  --after-url URL     Proposed documentation origin (required).
  --max-chunks N      Ranked chunks returned per query (default: 4).
  --skip-visibility   Skip agent-only Markdown/HTML visibility checks.
  --json PATH         Write the machine-readable result.
  --markdown PATH     Write the Markdown report.
  --help              Show this help text.`

const parseArgs = (argv) => {
  const options = {
    beforeUrl: DEFAULT_BEFORE_URL,
    maxChunks: 4,
    verifyVisibility: true
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') {
      options.help = true
      continue
    }
    if (argument === '--skip-visibility') {
      options.verifyVisibility = false
      continue
    }
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`)
    }
    index += 1
    const name = argument
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    options[name] = value
  }
  options.maxChunks = Number(options.maxChunks)
  if (!Number.isInteger(options.maxChunks) || options.maxChunks < 1) {
    throw new Error('--max-chunks must be a positive integer')
  }
  return options
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const request = async (url, { attempts = 3 } = {}) => {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} from ${url}`)
      }
      return await response.text()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(attempt * 1_000)
    }
  }
  throw lastError
}

const origin = (url) => url.replace(/\/$/, '')

const corpusMetadata = (sourceUrl, corpus, chunks) => ({
  id: `${origin(sourceUrl)}/llms-full.txt`,
  state: 'fetched',
  fetchedAt: new Date().toISOString(),
  sha256: createHash('sha256').update(corpus).digest('hex'),
  pages: new Set(chunks.map(({ pageId }) => pageId)).size,
  chunks: chunks.length,
  totalTokens: chunks.reduce(
    (total, { contentTokens }) => total + contentTokens,
    0
  )
})

const chunksForEntryPath = (chunks, entryPath) => {
  const matching = chunks.filter(
    ({ pageId }) => new URL(pageId).pathname === entryPath
  )
  if (matching.length === 0) {
    throw new Error(`No llms-full.txt chunks found for ${entryPath}`)
  }
  return matching
}

const responsesFor = (chunks, queries, maximumChunks) =>
  Object.fromEntries(
    queries.map((query) => [
      query.id,
      {
        infoSnippets: retrieve(
          chunksForEntryPath(chunks, query.entryPath),
          query.prompt,
          maximumChunks
        ).map(
          ({ pageId, breadcrumb, content, contentTokens, retrievalScore }) => ({
            pageId,
            breadcrumb,
            content,
            contentTokens,
            retrievalScore
          })
        ),
        codeSnippets: []
      }
    ])
  )

const decodeHtml = (value) =>
  value
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&(?:nbsp|#160|#xA0);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')

const visibleText = (html) =>
  decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const normalizedDocumentation = (content) =>
  visibleText(content).replace(/[“”]/g, '"').replace(/[‘’]/g, "'")

const verifyVisibility = async (afterUrl, checks) => {
  const baseUrl = origin(afterUrl)
  return Promise.all(
    checks.map(async (check) => {
      const [markdown, html] = await Promise.all([
        request(`${baseUrl}${check.path}.md`),
        request(`${baseUrl}${check.path}`)
      ])
      const marker = normalizedDocumentation(check.marker)
      const markdownIncludesMarker =
        normalizedDocumentation(markdown).includes(marker)
      const htmlExcludesMarker = !visibleText(html).includes(marker)
      return {
        ...check,
        markdownIncludesMarker,
        htmlExcludesMarker,
        pass: markdownIncludesMarker && htmlExcludesMarker
      }
    })
  )
}

const metric = (score, valueName, indexName) =>
  score[indexName] === -1
    ? `not found (${score[valueName]} penalty)`
    : String(score[valueName])

const renderReport = (evaluation) => {
  const lines = [
    '# Porter agent app-creation local retrieval evaluation',
    '',
    `Result: **${evaluation.pass ? 'PASS' : 'FAIL'}**`,
    '',
    'The primary run uses deterministic local chunking and fielded BM25 ranking within each query’s canonical entry page from the public `llms-full.txt`. Token counts are a stable UTF-8 estimate; the companion Claude run records the model envelope’s exact input-token usage.',
    '',
    `- Before: ${evaluation.before.library.id}`,
    `- Before corpus: ${evaluation.before.library.pages} pages, ${evaluation.before.library.chunks} chunks, ${evaluation.before.library.totalTokens} estimated tokens, SHA-256 \`${evaluation.before.library.sha256}\``,
    `- After: ${evaluation.after.library.id}`,
    `- After corpus: ${evaluation.after.library.pages} pages, ${evaluation.after.library.chunks} chunks, ${evaluation.after.library.totalTokens} estimated tokens, SHA-256 \`${evaluation.after.library.sha256}\``,
    `- Returned context: top ${evaluation.maximumChunks} chunks per query`,
    `- Visibility checks: ${evaluation.visibilityStatus}`,
    '',
    '## Gates',
    '',
    '| Gate | Result | Detail |',
    '| --- | --- | --- |',
    ...evaluation.comparison.gates.map(
      (gate) =>
        `| ${gate.id} | ${gate.pass ? 'PASS' : 'FAIL'} | ${gate.detail} |`
    ),
    '',
    '## Query results',
    '',
    '| Group | Query | Entry page | Before first agent rank | After first agent rank | Before tokens to agent | After tokens to agent | After complete path |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...evaluation.comparison.results.map(
      ({ query, before, after }) =>
        `| ${query.group} | ${query.prompt} | ${query.entryPath} | ${before.firstAgentIndex === -1 ? 'not found' : before.firstAgentIndex + 1} | ${after.firstAgentIndex === -1 ? 'not found' : after.firstAgentIndex + 1} | ${metric(before, 'tokensToFirstAgentPath', 'firstAgentIndex')} | ${metric(after, 'tokensToFirstAgentPath', 'firstAgentIndex')} | ${after.completePath ? 'yes' : 'no'} |`
    )
  ]

  if (evaluation.visibility) {
    lines.push(
      '',
      '## Agent visibility',
      '',
      '| Page | `.md` includes guidance | HTML excludes guidance | Result |',
      '| --- | ---: | ---: | ---: |',
      ...evaluation.visibility.map(
        (check) =>
          `| ${check.path} | ${check.markdownIncludesMarker ? 'yes' : 'no'} | ${check.htmlExcludesMarker ? 'yes' : 'no'} | ${check.pass ? 'PASS' : 'FAIL'} |`
      )
    )
  }

  return `${lines.join('\n')}\n`
}

const writeOutput = async (path, content) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage}\n`)
    return
  }
  if (!options.afterUrl) {
    throw new Error(`Missing required option --after-url\n\n${usage}`)
  }

  const directory = dirname(fileURLToPath(import.meta.url))
  const { queries } = JSON.parse(
    await readFile(join(directory, 'queries.json'), 'utf8')
  )
  const visibilityChecks = JSON.parse(
    await readFile(join(directory, 'visibility.json'), 'utf8')
  )
  const [beforeCorpus, afterCorpus] = await Promise.all([
    request(`${origin(options.beforeUrl)}/llms-full.txt`),
    request(`${origin(options.afterUrl)}/llms-full.txt`)
  ])
  const beforeChunks = parseCorpus(beforeCorpus)
  const afterChunks = parseCorpus(afterCorpus)
  const beforeResponses = responsesFor(beforeChunks, queries, options.maxChunks)
  const afterResponses = responsesFor(afterChunks, queries, options.maxChunks)
  const comparison = compareResults(queries, beforeResponses, afterResponses)
  const visibility = options.verifyVisibility
    ? await verifyVisibility(options.afterUrl, visibilityChecks)
    : undefined
  const visibilityPass = visibility?.every(({ pass }) => pass) ?? false
  const visibilityStatus = options.verifyVisibility
    ? visibilityPass
      ? 'passed'
      : 'failed'
    : 'skipped (overall result cannot pass)'
  const evaluation = {
    generatedAt: new Date().toISOString(),
    method: 'local-bm25',
    pass: comparison.pass && visibilityPass,
    maximumChunks: options.maxChunks,
    visibilityStatus,
    before: {
      sourceUrl: options.beforeUrl,
      library: corpusMetadata(options.beforeUrl, beforeCorpus, beforeChunks),
      responses: beforeResponses
    },
    after: {
      sourceUrl: options.afterUrl,
      library: corpusMetadata(options.afterUrl, afterCorpus, afterChunks),
      responses: afterResponses
    },
    comparison,
    visibility
  }
  const report = renderReport(evaluation)
  if (options.json) {
    await writeOutput(options.json, `${JSON.stringify(evaluation, null, 2)}\n`)
  }
  if (options.markdown) await writeOutput(options.markdown, report)
  process.stdout.write(report)
  if (!evaluation.pass) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
