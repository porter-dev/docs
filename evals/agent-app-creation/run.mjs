#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import {
  gatesTable,
  parseOptions,
  positiveInteger,
  runMain,
  writeOutput
} from './cli.mjs'
import { parseCorpus, retrieve } from './retrieval.mjs'
import { compareResults, totalSnippetTokens } from './score.mjs'

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
  const options = parseOptions(argv, {
    strings: ['before-url', 'after-url', 'max-chunks', 'json', 'markdown'],
    booleans: ['help', 'skip-visibility']
  })
  return {
    ...options,
    beforeUrl: options.beforeUrl ?? DEFAULT_BEFORE_URL,
    maxChunks: positiveInteger(options.maxChunks ?? 4, '--max-chunks'),
    verifyVisibility: !options.skipVisibility
  }
}

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

const llmsUrl = (url) => `${origin(url)}/llms-full.txt`

const corpusMetadata = (id, corpus, chunks) => ({
  id,
  state: 'fetched',
  fetchedAt: new Date().toISOString(),
  sha256: createHash('sha256').update(corpus).digest('hex'),
  pages: new Set(chunks.map(({ pageId }) => pageId)).size,
  chunks: chunks.length,
  totalTokens: totalSnippetTokens(chunks)
})

const responsesFor = (chunks, queries, maximumChunks) => {
  const chunksByPath = new Map()
  for (const chunk of chunks) {
    const path = new URL(chunk.pageId).pathname
    chunksByPath.set(path, [...(chunksByPath.get(path) ?? []), chunk])
  }
  return Object.fromEntries(
    queries.map((query) => {
      const matching = chunksByPath.get(query.entryPath)
      if (!matching) {
        throw new Error(`No llms-full.txt chunks found for ${query.entryPath}`)
      }
      return [
        query.id,
        {
          infoSnippets: retrieve(matching, query.prompt, maximumChunks).map(
            ({
              pageId,
              breadcrumb,
              content,
              contentTokens,
              retrievalScore
            }) => ({
              pageId,
              breadcrumb,
              content,
              contentTokens,
              retrievalScore
            })
          )
        }
      ]
    })
  )
}

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

const metric = (value, index) =>
  index === -1 ? `not found (${value} penalty)` : String(value)

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
    ...gatesTable(evaluation.comparison.gates),
    '',
    '## Query results',
    '',
    '| Group | Query | Entry page | Before first agent rank | After first agent rank | Before tokens to agent | After tokens to agent | After complete path |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...evaluation.comparison.results.map(
      ({ query, before, after }) =>
        `| ${query.group} | ${query.prompt} | ${query.entryPath} | ${before.firstAgentIndex === -1 ? 'not found' : before.firstAgentIndex + 1} | ${after.firstAgentIndex === -1 ? 'not found' : after.firstAgentIndex + 1} | ${metric(before.tokensToFirstAgentPath, before.firstAgentIndex)} | ${metric(after.tokensToFirstAgentPath, after.firstAgentIndex)} | ${after.completePath ? 'yes' : 'no'} |`
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
  const [beforeCorpus, afterCorpus, visibility] = await Promise.all([
    request(llmsUrl(options.beforeUrl)),
    request(llmsUrl(options.afterUrl)),
    options.verifyVisibility
      ? verifyVisibility(options.afterUrl, visibilityChecks)
      : undefined
  ])
  const beforeChunks = parseCorpus(beforeCorpus)
  const afterChunks = parseCorpus(afterCorpus)
  const beforeResponses = responsesFor(beforeChunks, queries, options.maxChunks)
  const afterResponses = responsesFor(afterChunks, queries, options.maxChunks)
  const comparison = compareResults(queries, beforeResponses, afterResponses)
  const visibilityPass = visibility?.every(({ pass }) => pass) ?? false
  const visibilityStatus = !options.verifyVisibility
    ? 'skipped (overall result cannot pass)'
    : visibilityPass
      ? 'passed'
      : 'failed'
  const evaluation = {
    generatedAt: new Date().toISOString(),
    method: 'local-bm25',
    pass: comparison.pass && visibilityPass,
    maximumChunks: options.maxChunks,
    visibilityStatus,
    before: {
      sourceUrl: options.beforeUrl,
      library: corpusMetadata(
        llmsUrl(options.beforeUrl),
        beforeCorpus,
        beforeChunks
      ),
      responses: beforeResponses
    },
    after: {
      sourceUrl: options.afterUrl,
      library: corpusMetadata(
        llmsUrl(options.afterUrl),
        afterCorpus,
        afterChunks
      ),
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

runMain(main)
