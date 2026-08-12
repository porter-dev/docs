#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareResults } from './score.mjs'

const CONTEXT7_ORIGIN = 'https://context7.com'
const DEFAULT_CACHE_DIR = join(tmpdir(), 'porter-context7-agent-app-creation')
const REQUIRED_OPTIONS = [
  'before',
  'after',
  'before-source-url',
  'after-source-url'
]

const usage = `Usage:
  node evals/agent-app-creation/context7.mjs \\
    --before /websites/porter_run \\
    --after /websites/porter_preview \\
    --before-source-url https://docs.porter.run \\
    --after-source-url https://porter-preview.mintlify.site \\
    --preview-url https://porter-preview.mintlify.site \\
    --json /tmp/porter-agent-app-creation.json \\
    --markdown /tmp/porter-agent-app-creation.md

Options:
  --allow-stale              Permit indexes older than --max-index-age-hours.
  --max-index-age-hours N    Maximum age for each index (default: 48).
  --max-index-skew-hours N   Maximum difference between index timestamps (default: 24).
  --cache-dir PATH           Context response cache (default: OS temp directory).
  --no-cache                 Fetch every query instead of using the cache.
  --help                     Show this help text.

Set CONTEXT7_API_KEY for higher Context7 rate limits. The value is never written to output.`

const parseArgs = (argv) => {
  const options = {
    cacheDir: DEFAULT_CACHE_DIR,
    maxIndexAgeHours: 48,
    maxIndexSkewHours: 24,
    useCache: true,
    allowStale: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') {
      options.help = true
      continue
    }
    if (argument === '--allow-stale') {
      options.allowStale = true
      continue
    }
    if (argument === '--no-cache') {
      options.useCache = false
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

  options.maxIndexAgeHours = Number(options.maxIndexAgeHours)
  options.maxIndexSkewHours = Number(options.maxIndexSkewHours)
  for (const name of ['maxIndexAgeHours', 'maxIndexSkewHours']) {
    if (!Number.isFinite(options[name]) || options[name] < 0) {
      throw new Error(
        `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a non-negative number`
      )
    }
  }

  return options
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const request = async (url, { responseType = 'json', attempts = 3 } = {}) => {
  const headers = {}
  if (process.env.CONTEXT7_API_KEY && url.startsWith(CONTEXT7_ORIGIN)) {
    headers.Authorization = `Bearer ${process.env.CONTEXT7_API_KEY}`
  }

  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(20_000)
      })
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await sleep(attempt * 1_000)
      }
      continue
    }

    if (!response.ok) {
      const body = await response.text()
      const error = new Error(
        `${response.status} ${response.statusText} from ${url}: ${body.slice(0, 300)}`
      )
      if (response.status !== 429 && response.status < 500) {
        throw error
      }
      lastError = error
      if (attempt < attempts) {
        const retryAfterHeader = response.headers.get('retry-after')
        const retryAfter =
          retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader)
        await sleep(
          Number.isFinite(retryAfter)
            ? Math.min(Math.max(retryAfter, 0) * 1_000, 30_000)
            : attempt * 1_000
        )
      }
      continue
    }

    try {
      return responseType === 'text'
        ? await response.text()
        : await response.json()
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await sleep(attempt * 1_000)
      }
    }
  }

  throw lastError
}

const context7Url = (path, parameters) => {
  const url = new URL(path, CONTEXT7_ORIGIN)
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value)
  }
  return url
}

const getLibraryMetadata = async (libraryId) => {
  const payload = await request(
    context7Url('/api/v2/libs/search', {
      libraryName: libraryId,
      query: 'Porter application creation and deployment documentation',
      fast: 'true'
    })
  )
  const library = payload.results?.find(({ id }) => id === libraryId)
  if (!library) {
    throw new Error(
      `Context7 search did not return the exact library ${libraryId}`
    )
  }
  if (library.state !== 'finalized') {
    throw new Error(
      `${libraryId} is not ready; Context7 state is ${library.state}`
    )
  }
  const lastUpdateTime = Date.parse(library.lastUpdateDate)
  if (!Number.isFinite(lastUpdateTime)) {
    throw new Error(`${libraryId} has an invalid lastUpdateDate`)
  }
  if (lastUpdateTime > Date.now() + 5 * 60 * 1_000) {
    throw new Error(`${libraryId} has a lastUpdateDate in the future`)
  }
  return library
}

const decodeHtml = (value) =>
  value
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')

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

const verifyLibrarySource = async (libraryId, expectedSourceUrl) => {
  const libraryPage = await request(`${CONTEXT7_ORIGIN}${libraryId}`, {
    responseType: 'text'
  })
  const normalizedPage = decodeHtml(libraryPage)
  const source = expectedSourceUrl.replace(/\/$/, '')
  if (!normalizedPage.includes(source)) {
    throw new Error(
      `${libraryId} does not expose the expected source URL ${source}`
    )
  }
}

const validateIndexFreshness = (before, after, options) => {
  const beforeTime = Date.parse(before.lastUpdateDate)
  const afterTime = Date.parse(after.lastUpdateDate)
  const hour = 60 * 60 * 1_000
  const ageHours = {
    before: (Date.now() - beforeTime) / hour,
    after: (Date.now() - afterTime) / hour
  }
  const skewHours = Math.abs(beforeTime - afterTime) / hour

  if (!options.allowStale) {
    for (const [name, age] of Object.entries(ageHours)) {
      if (age > options.maxIndexAgeHours) {
        throw new Error(
          `${name} Context7 index is ${age.toFixed(1)} hours old; refresh it before comparing`
        )
      }
    }
  }
  if (skewHours > options.maxIndexSkewHours) {
    throw new Error(
      `Context7 indexes differ in age by ${skewHours.toFixed(1)} hours; refresh them in the same evaluation window`
    )
  }

  return { ageHours, skewHours }
}

const cachePath = (options, library, query) => {
  const key = createHash('sha256')
    .update(JSON.stringify([library.id, library.lastUpdateDate, query]))
    .digest('hex')
  return join(options.cacheDir, `${key}.json`)
}

const getContext = async (options, library, query) => {
  const path = cachePath(options, library, query.prompt)
  if (options.useCache) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
  }

  const payload = await request(
    context7Url('/api/v2/context', {
      libraryId: library.id,
      query: query.prompt,
      type: 'json'
    })
  )
  if (options.useCache) {
    await mkdir(options.cacheDir, { recursive: true })
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`)
  }
  return payload
}

const mapWithConcurrency = async (items, concurrency, task) => {
  const results = new Array(items.length)
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await task(items[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  )
  return results
}

const getResponses = async (options, library, queries) => {
  const responses = await mapWithConcurrency(queries, 3, (query) =>
    getContext(options, library, query)
  )
  return Object.fromEntries(
    queries.map((query, index) => [query.id, responses[index]])
  )
}

const verifyVisibility = async (previewUrl, checks) => {
  const origin = previewUrl.replace(/\/$/, '')
  return mapWithConcurrency(checks, 3, async (check) => {
    const [markdown, html] = await Promise.all([
      request(`${origin}${check.path}.md`, { responseType: 'text' }),
      request(`${origin}${check.path}`, { responseType: 'text' })
    ])
    const marker = normalizedDocumentation(check.marker)
    const markdownIncludesMarker =
      normalizedDocumentation(markdown).includes(marker)
    const htmlIncludesMarker = visibleText(html).includes(marker)
    return {
      ...check,
      markdownIncludesMarker,
      htmlExcludesMarker: !htmlIncludesMarker,
      pass: markdownIncludesMarker && !htmlIncludesMarker
    }
  })
}

const metric = (score, valueName, indexName) =>
  score[indexName] === -1
    ? `not found (${score[valueName]} penalty)`
    : String(score[valueName])

const renderReport = (evaluation) => {
  const lines = [
    '# Porter agent app-creation documentation evaluation',
    '',
    `Result: **${evaluation.pass ? 'PASS' : 'FAIL'}**`,
    '',
    `- Before: \`${evaluation.before.library.id}\` (${evaluation.before.library.lastUpdateDate})`,
    `- After: \`${evaluation.after.library.id}\` (${evaluation.after.library.lastUpdateDate})`,
    `- Index timestamp skew: ${evaluation.indexFreshness.skewHours.toFixed(1)} hours`,
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
    '| Group | Query | Before top-two agent | After top-two agent | Before tokens to agent | After tokens to agent | After complete path |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...evaluation.comparison.results.map(
      ({ query, before, after }) =>
        `| ${query.group} | ${query.prompt} | ${before.topTwoAgentPath ? 'yes' : 'no'} | ${after.topTwoAgentPath ? 'yes' : 'no'} | ${metric(before, 'tokensToFirstAgentPath', 'firstAgentIndex')} | ${metric(after, 'tokensToFirstAgentPath', 'firstAgentIndex')} | ${after.completePath ? 'yes' : 'no'} |`
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
  for (const name of REQUIRED_OPTIONS) {
    const optionName = name.replace(/-([a-z])/g, (_, letter) =>
      letter.toUpperCase()
    )
    if (!options[optionName]) {
      throw new Error(`Missing required option --${name}\n\n${usage}`)
    }
  }

  const directory = dirname(fileURLToPath(import.meta.url))
  const { queries } = JSON.parse(
    await readFile(join(directory, 'queries.json'), 'utf8')
  )
  const visibilityChecks = JSON.parse(
    await readFile(join(directory, 'visibility.json'), 'utf8')
  )
  const [beforeLibrary, afterLibrary] = await Promise.all([
    getLibraryMetadata(options.before),
    getLibraryMetadata(options.after)
  ])
  await Promise.all([
    verifyLibrarySource(options.before, options.beforeSourceUrl),
    verifyLibrarySource(options.after, options.afterSourceUrl)
  ])
  const indexFreshness = validateIndexFreshness(
    beforeLibrary,
    afterLibrary,
    options
  )
  const [beforeResponses, afterResponses, visibility] = await Promise.all([
    getResponses(options, beforeLibrary, queries),
    getResponses(options, afterLibrary, queries),
    options.previewUrl
      ? verifyVisibility(options.previewUrl, visibilityChecks)
      : undefined
  ])
  const comparison = compareResults(queries, beforeResponses, afterResponses)
  const visibilityPass = !visibility || visibility.every((check) => check.pass)
  const evaluation = {
    generatedAt: new Date().toISOString(),
    pass: comparison.pass && visibilityPass,
    before: {
      sourceUrl: options.beforeSourceUrl,
      library: beforeLibrary,
      responses: beforeResponses
    },
    after: {
      sourceUrl: options.afterSourceUrl,
      library: afterLibrary,
      responses: afterResponses
    },
    indexFreshness,
    comparison,
    visibility
  }
  const report = renderReport(evaluation)

  if (options.json) {
    await writeOutput(options.json, `${JSON.stringify(evaluation, null, 2)}\n`)
  }
  if (options.markdown) {
    await writeOutput(options.markdown, report)
  }
  process.stdout.write(report)
  if (!evaluation.pass) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
