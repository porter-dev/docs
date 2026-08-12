import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  compareResults,
  evaluateClaudeOutcomes,
  median,
  scoreClaudeAnswer,
  scoreResponse
} from './score.mjs'

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')
  )

test('scores missing and first-ranked agent paths with cumulative retrieval tokens', async () => {
  const before = scoreResponse(await fixture('before'))
  const after = scoreResponse(await fixture('after'))

  assert.equal(before.firstAgentIndex, -1)
  assert.equal(before.tokensToFirstAgentPath, 101)
  assert.equal(before.completePath, false)
  assert.equal(after.firstAgentIndex, 0)
  assert.equal(after.tokensToFirstAgentPath, 40)
  assert.equal(after.completePath, true)
  assert.equal(after.tokensToCompletePath, 40)
})

test('rejects snippets without token counts', () => {
  assert.throws(
    () =>
      scoreResponse({
        infoSnippets: [{ content: 'MCP create_app', pageId: 'example' }]
      }),
    /contentTokens/
  )
})

test('scores a code-only response as missing agent prose instead of crashing', () => {
  const score = scoreResponse({
    codeSnippets: [
      {
        codeTitle: 'Create an app',
        codeDescription: 'Call create_app from an MCP client.',
        codeList: []
      }
    ],
    infoSnippets: []
  })

  assert.equal(score.totalTokens, 0)
  assert.equal(score.tokensToFirstAgentPath, 1)
  assert.equal(score.topOneAgentPath, false)
  assert.equal(score.completePath, false)
})

test('does not count unrelated MCP setup prose as the app-creation path', async () => {
  const response = await fixture('after')
  response.infoSnippets.unshift({
    pageId: 'https://docs.porter.run/mcp/overview',
    breadcrumb: 'MCP authentication',
    content: 'Connect to the MCP server with OAuth before using its tools.',
    contentTokens: 15
  })
  const score = scoreResponse(response)

  assert.equal(score.firstAgentIndex, 1)
  assert.equal(score.tokensToFirstAgentPath, 55)
})

test('detects invalid deploy_app guidance and false GitHub App installation claims', async () => {
  const response = await fixture('after')
  response.infoSnippets[0].content =
    'The MCP server will install the Porter GitHub App, then call deploy_app for you.'
  const score = scoreResponse(response)

  assert.equal(score.recommendsDeployApp, true)
  assert.equal(score.claimsMcpInstallsGithubApp, true)
})

test('calculates medians for even and odd lists', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
})

test('verifies Claude lead-path labels against the answer text', () => {
  const score = scoreClaudeAnswer({
    leadPath: 'agent',
    answer:
      'Open the Porter dashboard first. You could alternatively use the MCP server.'
  })

  assert.equal(score.inferredLeadPath, 'dashboard')
  assert.equal(score.leadsWithAgent, false)
  assert.equal(score.mentionsCreateApp, false)
})

test('ignores negated agent advice when inferring the leading path', () => {
  const score = scoreClaudeAnswer({
    leadPath: 'agent',
    answer: "Don't use the MCP server for this. Open the Porter dashboard."
  })

  assert.equal(score.inferredLeadPath, 'dashboard')
  assert.equal(score.leadsWithAgent, false)
})

test('infers an unclear lead when no interaction path is present', () => {
  const score = scoreClaudeAnswer({
    leadPath: 'unclear',
    answer: 'The retrieved documentation does not answer this question.'
  })

  assert.equal(score.inferredLeadPath, 'unclear')
  assert.equal(score.leadsWithAgent, false)
})

test('detects false GitHub App installation claims in Claude answers', () => {
  const score = scoreClaudeAnswer({
    leadPath: 'agent',
    answer: 'The agent installs the Porter GitHub App for you.'
  })

  assert.equal(score.claimsMcpInstallsGithubApp, true)
})

test('does not treat user-directed GitHub App installation as a false claim', () => {
  const score = scoreClaudeAnswer({
    leadPath: 'agent',
    answer:
      'The agent asks the user to install the Porter GitHub App before calling create_app.'
  })

  assert.equal(score.claimsMcpInstallsGithubApp, false)
  assert.equal(score.mentionsGithubAppPrerequisite, true)
})

test('does not count negated prerequisite or merge instructions as complete', async () => {
  const response = await fixture('after')
  response.infoSnippets[0].content =
    'Call create_app with source and build. The Porter GitHub App is optional. Porter opens a pull request, but do not merge the PR.'
  const score = scoreResponse(response)

  assert.equal(score.facts.githubApp, false)
  assert.equal(score.facts.merge, false)
  assert.equal(score.completePath, false)
})

test('passes the deterministic comparison gates for a complete improvement', async () => {
  const [before, after] = await Promise.all([
    fixture('before'),
    fixture('after')
  ])
  const queries = [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `generic-${index}`,
      group: 'generic',
      prompt: `Generic ${index}`
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      id: `agent-${index}`,
      group: 'agent-aware',
      prompt: `Agent ${index}`
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      id: `workflow-${index}`,
      group: 'workflow',
      prompt: `Workflow ${index}`
    })),
    {
      id: 'control-dashboard',
      group: 'control',
      prompt: 'Dashboard control',
      expectedTopTwoTerms: [['placeholder image'], ['service']]
    },
    {
      id: 'control-customization',
      group: 'control',
      prompt: 'Customization control',
      expectedTopTwoTerms: [['build configuration'], ['service']]
    }
  ]
  const beforeResponses = Object.fromEntries(
    queries.map(({ id }) => [id, structuredClone(before)])
  )
  const afterResponses = Object.fromEntries(
    queries.map(({ id }) => [id, structuredClone(after)])
  )
  const comparison = compareResults(queries, beforeResponses, afterResponses)

  assert.equal(comparison.pass, true)
  assert.ok(comparison.gates.every(({ pass }) => pass))
})

test('uses one shared missing-result penalty for each before-and-after pair', async () => {
  const before = await fixture('before')
  const after = {
    codeSnippets: [],
    infoSnippets: [
      {
        pageId: 'https://preview.example.com/dashboard',
        content: 'Open the dashboard.',
        contentTokens: 10
      }
    ]
  }
  const comparison = compareResults(
    [{ id: 'generic', group: 'generic', prompt: 'Create an app' }],
    { generic: before },
    { generic: after }
  )
  const [result] = comparison.results

  assert.equal(result.before.tokensToFirstAgentPath, 101)
  assert.equal(result.after.tokensToFirstAgentPath, 101)
})

test('enforces Claude lead-rate, improvement, workflow, and invalid-tool gates', () => {
  const runs = []
  for (let index = 0; index < 18; index += 1) {
    runs.push({
      corpus: 'before',
      queryGroup: 'generic',
      answer: {
        leadPath: index < 5 ? 'agent' : 'dashboard',
        answer: 'Use the dashboard.'
      }
    })
    runs.push({
      corpus: 'after',
      queryGroup: 'generic',
      answer: {
        leadPath: index < 15 ? 'agent' : 'dashboard',
        answer: 'Use the Porter MCP server with create_app.'
      }
    })
  }
  for (let index = 0; index < 6; index += 1) {
    runs.push({
      corpus: 'after',
      queryGroup: 'workflow',
      answer: {
        leadPath: 'agent',
        answer:
          index < 5
            ? 'Install the Porter GitHub App first. Call create_app with source and build; it opens a pull request. Then merge the pull request.'
            : 'Call create_app.'
      }
    })
  }

  const outcome = evaluateClaudeOutcomes(runs)
  assert.equal(outcome.pass, true)
  assert.ok(outcome.gates.every(({ pass }) => pass))
})

test('requires every create_app workflow fact in Claude answers', () => {
  const outcome = evaluateClaudeOutcomes([
    {
      corpus: 'after',
      queryGroup: 'workflow',
      answer: {
        leadPath: 'agent',
        answer:
          'Install the Porter GitHub App first. Call create_app; it opens a pull request that you merge.'
      }
    }
  ])
  const workflowGate = outcome.gates.find(
    ({ id }) => id === 'claude-workflow-completeness'
  )
  assert.equal(workflowGate.pass, false)
})

test('recognizes a tool-generated pull request in past tense', () => {
  const score = scoreClaudeAnswer({
    leadPath: 'agent',
    answer:
      'The Porter GitHub App must be installed first. Porter called create_app with source and build, then opened a pull request for you to merge.'
  })

  assert.equal(score.mentionsGeneratedPullRequest, true)
})

test('does not mistake a user-created pull request for a generated one', () => {
  const score = scoreClaudeAnswer({
    leadPath: 'agent',
    answer: 'The agent asks you to create a pull request yourself.'
  })

  assert.equal(score.mentionsGeneratedPullRequest, false)
})
