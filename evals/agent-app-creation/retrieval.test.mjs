import assert from 'node:assert/strict'
import test from 'node:test'

import { estimateTokens, parseCorpus, rankChunks } from './retrieval.mjs'

const corpus = `# Dashboard deployment
Source: https://docs.example.com/dashboard

## Create an application

Open the dashboard and select a GitHub repository.

# Agent deployment
Source: https://docs.example.com/agent

## Create an application

Use the Porter MCP server and call \`create_app\` with source and build.
`

test('parses llms-full pages into bounded chunks with source metadata', () => {
  const chunks = parseCorpus(corpus, { maxChunkTokens: 20 })
  assert.ok(chunks.length >= 2)
  assert.equal(chunks[0].pageId, 'https://docs.example.com/dashboard')
  assert.ok(chunks.every(({ contentTokens }) => contentTokens > 0))
})

test('ranks the agent chunk first for an MCP application query', () => {
  const chunks = parseCorpus(corpus)
  const ranked = rankChunks(
    chunks,
    'Can my coding agent create an application with the Porter MCP server?'
  )
  assert.equal(ranked[0].pageId, 'https://docs.example.com/agent')
  assert.match(ranked[0].content, /create_app/)
})

test('uses a deterministic UTF-8 token estimate', () => {
  assert.equal(estimateTokens('12345678'), 2)
})

test('keeps multibyte chunks within the configured token estimate', () => {
  const content = '🚀'.repeat(100)
  const unicodeCorpus = `# Unicode
Source: https://docs.example.com/unicode

${content}
`
  const chunks = parseCorpus(unicodeCorpus, { maxChunkTokens: 10 })
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every(({ contentTokens }) => contentTokens <= 10))
  assert.equal(chunks.map((chunk) => chunk.content).join(''), content)
})

test('keeps multi-paragraph agent-only visibility guidance atomic', () => {
  const visibilityCorpus = `# Agent
Source: https://docs.example.com/agent

<Visibility for="agents">
Call create_app with source and build.

${'The user merges the generated pull request. '.repeat(20)}
</Visibility>
`
  const chunks = parseCorpus(visibilityCorpus, { maxChunkTokens: 10 })
  const guidance = chunks.filter(({ content }) => /create_app/.test(content))
  assert.equal(guidance.length, 1)
  assert.match(guidance[0].content, /<Visibility for="agents">/)
  assert.match(guidance[0].content, /generated pull request/)
  assert.match(guidance[0].content, /<\/Visibility>/)
})
