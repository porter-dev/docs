const CREATE_APP_PATTERN = /\bcreate_app\b/i
const DEPLOY_APP_PATTERN = /\bdeploy_app\b/i

export const DEPLOYMENT_GROUPS = ['generic', 'agent-aware']
const AGENT_SIGNAL_PATTERNS = [
  /\bMCP\b/i,
  /\b(?:AI|coding) agent\b/i,
  /\byour agent\b/i
]

const sentences = (text) => text.split(/[.!?\n]+/).filter(Boolean)

const mentionsGithubAppPrerequisite = (text) =>
  sentences(text).some(
    (sentence) =>
      /\bPorter GitHub App\b/i.test(sentence) &&
      /\b(?:install(?:ed|ing|ation)?|prerequisite|required|must|before)\b/i.test(
        sentence
      ) &&
      !/\b(?:not required|optional|does not need|doesn't need|need not)\b/i.test(
        sentence
      )
  )

const mentionsMergeStep = (text) =>
  sentences(text).some(
    (sentence) =>
      /\bmerg(?:e|es|ed|ing)\b/i.test(sentence) &&
      /\b(?:pull request|PR)\b/i.test(sentence) &&
      !/\b(?:do not|don't|should not|shouldn't|must not|cannot|can't)\b/i.test(
        sentence
      )
  )

const mentionsSourceAndBuild = (text) =>
  sentences(text).some(
    (sentence) => /\bsource\b/i.test(sentence) && /\bbuild\b/i.test(sentence)
  )

const mentionsGeneratedPullRequest = (text) =>
  sentences(text).some(
    (sentence) =>
      /\b(?:Porter|create_app|MCP server|agent|tool|it)\b[^.!?\n]{0,100}\b(?:open(?:s|ed|ing)?|creat(?:e|es|ed|ing)|generat(?:e|es|ed|ing)|return(?:s|ed|ing)?)\b[^.!?\n]{0,100}\b(?:pull request|PR)\b/i.test(
        sentence
      ) &&
      !/\b(?:ask|tell|instruct)(?:s|ed|ing)?\b[^.!?\n]{0,40}\b(?:you|user)\b|\b(?:open|create|generate)(?:s|d|ed|ing)?\b[^.!?\n]{0,40}\b(?:yourself|manually)\b/i.test(
        sentence
      )
  )

const REQUIRED_FACTS = {
  createApp: (text) => CREATE_APP_PATTERN.test(text),
  sourceAndBuild: (text) => /\bsource\b/i.test(text) && /\bbuild\b/i.test(text),
  githubApp: mentionsGithubAppPrerequisite,
  pullRequest: (text) => /\bpull request\b|\bPR\b/i.test(text),
  merge: mentionsMergeStep
}

const FALSE_GITHUB_INSTALL_CLAIMS = [
  /\b(?:MCP server|create_app|agent)\s+(?:itself\s+)?(?:(?:can|will|automatically)\s+)?install(?:s)?\b[^.!?\n]{0,80}\b(?:Porter\s+)?GitHub App\b/i,
  /\binstall(?:s|ed|ing)?\b[^.!?\n]{0,80}\b(?:Porter\s+)?GitHub App\b[^.!?\n]{0,120}\b(?:with|using|through)\s+(?:the\s+)?(?:MCP|create_app|agent)\b/i
]

const claimsMcpInstallsGithubApp = (text) =>
  FALSE_GITHUB_INSTALL_CLAIMS.some((pattern) => pattern.test(text))

const snippetText = (snippet) =>
  [snippet.breadcrumb, snippet.content].filter(Boolean).join('\n')

const snippetTokens = (snippet) => {
  if (!Number.isFinite(snippet.contentTokens) || snippet.contentTokens < 0) {
    throw new Error(
      `Snippet is missing a valid contentTokens value: ${snippet.pageId ?? 'unknown page'}`
    )
  }

  return snippet.contentTokens
}

export const totalSnippetTokens = (snippets) =>
  snippets.reduce((total, snippet) => total + snippetTokens(snippet), 0)

const cumulativeTokensThrough = (snippets, index) =>
  totalSnippetTokens(snippets.slice(0, index + 1))

const containsAgentPath = (text) =>
  CREATE_APP_PATTERN.test(text) ||
  (AGENT_SIGNAL_PATTERNS.some((pattern) => pattern.test(text)) &&
    /\b(?:creat\w*|deploy\w*)\b/i.test(text) &&
    /\b(?:app|application)s?\b/i.test(text))

const factsIn = (text) =>
  Object.fromEntries(
    Object.entries(REQUIRED_FACTS).map(([name, matches]) => [
      name,
      matches(text)
    ])
  )

const allFactsPresent = (facts) => Object.values(facts).every(Boolean)

const expectedTermsPresent = (snippets, expectedTermGroups = []) => {
  const topTwoText = snippets
    .slice(0, 2)
    .map(snippetText)
    .join('\n')
    .toLowerCase()
  return expectedTermGroups.every((alternatives) =>
    alternatives.some((term) => topTwoText.includes(term.toLowerCase()))
  )
}

export const scoreResponse = (response, query = {}) => {
  const snippets = response.infoSnippets ?? []
  const totalTokens = totalSnippetTokens(snippets)
  const missingPenalty = totalTokens + 1
  const firstAgentIndex = snippets.findIndex((snippet) =>
    containsAgentPath(snippetText(snippet))
  )

  let completePathIndex = -1
  let cumulativeText = ''
  for (const [index, snippet] of snippets.entries()) {
    cumulativeText += `\n${snippetText(snippet)}`
    if (allFactsPresent(factsIn(cumulativeText))) {
      completePathIndex = index
      break
    }
  }

  const snippetsText = snippets.map(snippetText).join('\n')
  const facts = factsIn(snippetsText)

  return {
    totalTokens,
    firstAgentIndex,
    tokensToFirstAgentPath:
      firstAgentIndex === -1
        ? missingPenalty
        : cumulativeTokensThrough(snippets, firstAgentIndex),
    completePathIndex,
    tokensToCompletePath:
      completePathIndex === -1
        ? missingPenalty
        : cumulativeTokensThrough(snippets, completePathIndex),
    topOneAgentPath: firstAgentIndex === 0,
    topTwoAgentPath: firstAgentIndex >= 0 && firstAgentIndex < 2,
    facts,
    completePath: allFactsPresent(facts),
    controlTermsPresent: expectedTermsPresent(
      snippets,
      query.expectedTopTwoTerms
    ),
    recommendsDeployApp: DEPLOY_APP_PATTERN.test(snippetsText),
    claimsMcpInstallsGithubApp: claimsMcpInstallsGithubApp(snippetsText)
  }
}

export const median = (values) => {
  if (values.length === 0) {
    throw new Error('Cannot calculate a median for an empty list')
  }

  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint]
}

const countMatching = (results, predicate) => results.filter(predicate).length

export const compareResults = (queries, beforeResponses, afterResponses) => {
  const results = queries.map((query) => {
    const beforeResponse = beforeResponses[query.id]
    const afterResponse = afterResponses[query.id]
    if (!beforeResponse || !afterResponse) {
      throw new Error(`Missing a before or after response for ${query.id}`)
    }

    const before = scoreResponse(beforeResponse, query)
    const after = scoreResponse(afterResponse, query)
    const sharedMissingPenalty =
      Math.max(before.totalTokens, after.totalTokens) + 1
    for (const score of [before, after]) {
      if (score.firstAgentIndex === -1) {
        score.tokensToFirstAgentPath = sharedMissingPenalty
      }
      if (score.completePathIndex === -1) {
        score.tokensToCompletePath = sharedMissingPenalty
      }
    }

    return { query, before, after }
  })

  const generic = results.filter(({ query }) => query.group === 'generic')
  const agentAware = results.filter(
    ({ query }) => query.group === 'agent-aware'
  )
  const workflow = results.filter(({ query }) => query.group === 'workflow')
  const controls = results.filter(({ query }) => query.group === 'control')
  const genericBeforeTopTwo = countMatching(
    generic,
    ({ before }) => before.topTwoAgentPath
  )
  const genericAfterTopTwo = countMatching(
    generic,
    ({ after }) => after.topTwoAgentPath
  )
  const beforeMedian = median(
    generic.map(({ before }) => before.tokensToFirstAgentPath)
  )
  const afterMedian = median(
    generic.map(({ after }) => after.tokensToFirstAgentPath)
  )
  const medianImprovement =
    beforeMedian === 0 ? 0 : (beforeMedian - afterMedian) / beforeMedian

  const gates = [
    {
      id: 'generic-top-two-coverage',
      pass:
        genericAfterTopTwo >= Math.ceil((generic.length * 3) / 4) &&
        genericAfterTopTwo - genericBeforeTopTwo >=
          Math.ceil(generic.length / 2),
      detail: `after ${genericAfterTopTwo}/${generic.length}; before ${genericBeforeTopTwo}/${generic.length}`
    },
    {
      id: 'generic-token-prominence',
      pass: medianImprovement >= 0.3,
      detail: `${(medianImprovement * 100).toFixed(1)}% improvement; before ${beforeMedian}; after ${afterMedian}`
    },
    {
      id: 'agent-aware-first-result',
      pass:
        agentAware.length > 0 &&
        agentAware.every(({ after }) => after.topOneAgentPath),
      detail: `${countMatching(agentAware, ({ after }) => after.topOneAgentPath)}/${agentAware.length}`
    },
    {
      id: 'workflow-completeness',
      pass:
        workflow.length > 0 &&
        workflow.every(({ after }) => after.completePath),
      detail: `${countMatching(workflow, ({ after }) => after.completePath)}/${workflow.length}`
    },
    {
      id: 'control-relevance',
      pass:
        controls.length > 0 &&
        controls.every(({ after }) => after.controlTermsPresent),
      detail: `${countMatching(controls, ({ after }) => after.controlTermsPresent)}/${controls.length}`
    },
    {
      id: 'no-invalid-tool-or-install-claim',
      pass: results.every(
        ({ after }) =>
          !after.recommendsDeployApp && !after.claimsMcpInstallsGithubApp
      ),
      detail: `${countMatching(
        results,
        ({ after }) =>
          after.recommendsDeployApp || after.claimsMcpInstallsGithubApp
      )} invalid result(s)`
    }
  ]

  return {
    pass: gates.every((gate) => gate.pass),
    gates,
    summary: {
      genericBeforeTopTwo,
      genericAfterTopTwo,
      beforeMedianTokensToFirstAgentPath: beforeMedian,
      afterMedianTokensToFirstAgentPath: afterMedian,
      medianTokenImprovement: medianImprovement
    },
    results
  }
}

const NEGATED_PREFIX =
  /\b(?:do not|don't|avoid|never|should not|shouldn't|cannot|can't)\s+(?:(?:use|using|call|calling)\s+)?(?:the\s+)?$/i

const firstMatchIndex = (text, patterns, { skipNegated = false } = {}) => {
  const indexes = patterns
    .map((pattern) => {
      const index = text.search(pattern)
      const negated =
        index !== -1 &&
        skipNegated &&
        NEGATED_PREFIX.test(text.slice(Math.max(0, index - 40), index))
      return index === -1 || negated ? Number.POSITIVE_INFINITY : index
    })
    .filter(Number.isFinite)
  return indexes.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...indexes)
}

const inferredLeadPath = (text) => {
  const candidates = [
    [
      'agent',
      firstMatchIndex(
        text,
        [CREATE_APP_PATTERN, ...AGENT_SIGNAL_PATTERNS, /\bagent\b/i],
        { skipNegated: true }
      )
    ],
    [
      'dashboard',
      firstMatchIndex(text, [/\bdashboard\b/i, /\bCreate Application\b/i])
    ],
    ['cli', firstMatchIndex(text, [/\bPorter CLI\b/i, /\bporter apply\b/i])]
  ]
  const firstIndex = Math.min(...candidates.map(([, index]) => index))
  const firstPaths = candidates.filter(([, index]) => index === firstIndex)
  return Number.isFinite(firstIndex) && firstPaths.length === 1
    ? firstPaths[0][0]
    : 'unclear'
}

export const scoreClaudeAnswer = (answer) => {
  const text = answer.answer ?? ''
  const inferredPath = inferredLeadPath(text)
  return {
    inferredLeadPath: inferredPath,
    leadsWithAgent: answer.leadPath === 'agent' && inferredPath === 'agent',
    mentionsCreateApp: CREATE_APP_PATTERN.test(text),
    mentionsSourceAndBuild: mentionsSourceAndBuild(text),
    mentionsGeneratedPullRequest: mentionsGeneratedPullRequest(text),
    mentionsGithubAppPrerequisite: mentionsGithubAppPrerequisite(text),
    mentionsMergeStep: mentionsMergeStep(text),
    recommendsDeployApp: DEPLOY_APP_PATTERN.test(text),
    claimsMcpInstallsGithubApp: claimsMcpInstallsGithubApp(text)
  }
}

export const evaluateClaudeOutcomes = (runs) => {
  const deployment = runs.filter(({ queryGroup }) =>
    DEPLOYMENT_GROUPS.includes(queryGroup)
  )
  const beforeDeployment = deployment.filter(
    ({ corpus }) => corpus === 'before'
  )
  const afterDeployment = deployment.filter(({ corpus }) => corpus === 'after')
  const afterWorkflow = runs.filter(
    ({ corpus, queryGroup }) => corpus === 'after' && queryGroup === 'workflow'
  )
  const scores = new Map(runs.map((run) => [run, scoreClaudeAnswer(run.answer)]))
  const score = (run) => scores.get(run)
  const beforeLeadCount = countMatching(
    beforeDeployment,
    (run) => score(run).leadsWithAgent && score(run).mentionsCreateApp
  )
  const afterLeadCount = countMatching(
    afterDeployment,
    (run) => score(run).leadsWithAgent && score(run).mentionsCreateApp
  )
  const workflowCompleteCount = countMatching(afterWorkflow, (run) => {
    const result = score(run)
    return (
      result.mentionsCreateApp &&
      result.mentionsSourceAndBuild &&
      result.mentionsGeneratedPullRequest &&
      result.mentionsGithubAppPrerequisite &&
      result.mentionsMergeStep
    )
  })
  const invalidCount = countMatching(
    runs,
    (run) =>
      score(run).recommendsDeployApp || score(run).claimsMcpInstallsGithubApp
  )
  const leadThreshold = Math.ceil((afterDeployment.length * 5) / 6)
  const improvementThreshold = Math.ceil(afterDeployment.length / 3)
  const workflowThreshold = Math.ceil((afterWorkflow.length * 5) / 6)
  const gates = [
    {
      id: 'claude-after-agent-lead-rate',
      pass:
        afterDeployment.length > 0 &&
        beforeDeployment.length === afterDeployment.length &&
        afterLeadCount >= leadThreshold,
      detail: `${afterLeadCount}/${afterDeployment.length}`
    },
    {
      id: 'claude-agent-lead-improvement',
      pass: afterLeadCount - beforeLeadCount >= improvementThreshold,
      detail: `+${afterLeadCount - beforeLeadCount}; before ${beforeLeadCount}; after ${afterLeadCount}`
    },
    {
      id: 'claude-workflow-completeness',
      pass:
        afterWorkflow.length > 0 && workflowCompleteCount >= workflowThreshold,
      detail: `${workflowCompleteCount}/${afterWorkflow.length}`
    },
    {
      id: 'claude-no-invalid-tool',
      pass: invalidCount === 0,
      detail: `${invalidCount} invalid answer(s)`
    }
  ]

  return { pass: gates.every((gate) => gate.pass), gates, runs }
}
