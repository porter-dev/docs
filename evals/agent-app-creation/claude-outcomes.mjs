#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { evaluateClaudeOutcomes, median, scoreClaudeAnswer } from './score.mjs'

const SYSTEM_PROMPT =
  'Follow the user instruction exactly. Use only the supplied documentation context.'

const usage = `Usage:
  node evals/agent-app-creation/claude-outcomes.mjs \\
    --evaluation /tmp/porter-agent-app-creation.json \\
    --json /tmp/porter-agent-app-creation-claude.json \\
    --markdown /tmp/porter-agent-app-creation-claude.md

Options:
  --trials N     Trials per query and corpus (default: 3).
  --model NAME   Optional Claude model override.
  --help         Show this help text.`

const parseArgs = (argv) => {
  const options = { trials: 3 }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') {
      options.help = true
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
  options.trials = Number(options.trials)
  if (!Number.isInteger(options.trials) || options.trials < 1) {
    throw new Error('--trials must be a positive integer')
  }
  return options
}

const documentationContext = (response) =>
  (response.infoSnippets ?? [])
    .map(
      (snippet, index) =>
        `Snippet ${index + 1}\nSource: ${snippet.pageId}\nSection: ${snippet.breadcrumb ?? 'Untitled'}\n${snippet.content}`
    )
    .join('\n\n')

const evaluationPrompt = (
  query,
  response
) => `You are evaluating whether retrieved Porter documentation helps an agent answer a deployment question.

Answer the user using only the documentation snippets below. Do not use outside knowledge. Recommend the best available interaction path first. Do not discuss this evaluation.

Return one JSON object and nothing else:
{"leadPath":"agent|dashboard|cli|unclear","answer":"your concise answer"}

Use leadPath "agent" only when the answer recommends an AI or coding agent using Porter's MCP server as the first path.

User question:
${query.prompt}

Documentation snippets:
${documentationContext(response)}`

const parseClaudeResult = (stdout) => {
  const envelope = JSON.parse(stdout)
  const result =
    typeof envelope.result === 'string'
      ? envelope.result.trim()
      : envelope.result
  const parsed =
    typeof result === 'object' && result
      ? result
      : JSON.parse(
          String(result)
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/, '')
        )
  if (!['agent', 'dashboard', 'cli', 'unclear'].includes(parsed.leadPath)) {
    throw new Error(`Claude returned an invalid leadPath: ${parsed.leadPath}`)
  }
  if (typeof parsed.answer !== 'string' || parsed.answer.length === 0) {
    throw new Error('Claude returned an empty answer')
  }
  const modelUsage = Object.entries(envelope.modelUsage ?? {})
  const primaryModel =
    modelUsage.find(
      ([, usage]) => usage.outputTokens === envelope.usage?.output_tokens
    ) ??
    modelUsage.sort(([, left], [, right]) => right.costUSD - left.costUSD)[0]
  const directUsage = envelope.usage ?? {}
  const effectiveInputTokens =
    (directUsage.input_tokens ?? 0) +
    (directUsage.cache_creation_input_tokens ?? 0) +
    (directUsage.cache_read_input_tokens ?? 0)
  return {
    answer: parsed,
    model: primaryModel?.[0] ?? envelope.model ?? 'unknown',
    usage: {
      envelopeInputTokens:
        effectiveInputTokens || primaryModel?.[1].inputTokens,
      uncachedInputTokens: directUsage.input_tokens,
      cacheCreationInputTokens: directUsage.cache_creation_input_tokens,
      cacheReadInputTokens: directUsage.cache_read_input_tokens,
      outputTokens:
        envelope.usage?.output_tokens ?? primaryModel?.[1].outputTokens,
      contextWindow: primaryModel?.[1].contextWindow,
      costUSD: envelope.total_cost_usd
    }
  }
}

const runClaude = (prompt, model) =>
  new Promise((resolve, reject) => {
    const arguments_ = [
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--tools',
      '',
      '--safe-mode',
      '--system-prompt',
      SYSTEM_PROMPT,
      '--disable-slash-commands'
    ]
    if (model) {
      arguments_.push('--model', model)
    }
    const child = spawn('claude', arguments_, {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Claude evaluation timed out after 120 seconds'))
    }, 120_000)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`Claude exited with ${code}: ${stderr.trim()}`))
        return
      }
      try {
        resolve(parseClaudeResult(stdout))
      } catch (error) {
        reject(
          new Error(
            `Could not parse Claude output: ${error.message}\n${stdout.slice(0, 500)}`
          )
        )
      }
    })
    child.stdin.end(prompt)
  })

const buildJobs = (evaluation, trials) => {
  const jobs = []
  for (const { query } of evaluation.comparison.results) {
    const corpora = ['generic', 'agent-aware'].includes(query.group)
      ? ['before', 'after']
      : query.group === 'workflow'
        ? ['after']
        : []
    for (const corpus of corpora) {
      for (let trial = 1; trial <= trials; trial += 1) {
        jobs.push({
          corpus,
          query,
          response: evaluation[corpus].responses[query.id],
          trial
        })
      }
    }
  }
  return jobs
}

const renderReport = (outcome) => {
  const lines = [
    '# Claude outcome evaluation',
    '',
    `Result: **${outcome.pass ? 'PASS' : 'FAIL'}**`,
    `Models: ${[...new Set(outcome.runs.map((run) => run.model))].join(', ')}`,
    `Median retrieved context: before ${outcome.usageSummary.before.medianRetrievedContextTokens} estimated tokens; after ${outcome.usageSummary.after.medianRetrievedContextTokens} estimated tokens`,
    `Median total model-envelope input (including harness overhead): before ${outcome.usageSummary.before.medianEnvelopeInputTokens} tokens; after ${outcome.usageSummary.after.medianEnvelopeInputTokens} tokens`,
    '',
    '| Gate | Result | Detail |',
    '| --- | --- | --- |',
    ...outcome.gates.map(
      (gate) =>
        `| ${gate.id} | ${gate.pass ? 'PASS' : 'FAIL'} | ${gate.detail} |`
    ),
    '',
    '| Corpus | Query | Trial | Retrieved context | Envelope input | Reported lead | Inferred lead | Source + build | Generated PR | GitHub App prerequisite | Merge step |',
    '| --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: |',
    ...outcome.runs.map((run) => {
      const score = scoreClaudeAnswer(run.answer)
      return `| ${run.corpus} | ${run.queryId} | ${run.trial} | ${run.retrievedContextTokens} | ${run.usage.envelopeInputTokens} | ${run.answer.leadPath} | ${score.inferredLeadPath} | ${score.mentionsSourceAndBuild ? 'yes' : 'no'} | ${score.mentionsGeneratedPullRequest ? 'yes' : 'no'} | ${score.mentionsGithubAppPrerequisite ? 'yes' : 'no'} | ${score.mentionsMergeStep ? 'yes' : 'no'} |`
    })
  ]
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
  if (!options.evaluation) {
    throw new Error(`Missing required option --evaluation\n\n${usage}`)
  }

  const evaluation = JSON.parse(await readFile(options.evaluation, 'utf8'))
  const runs = []
  for (const job of buildJobs(evaluation, options.trials)) {
    process.stderr.write(`${job.corpus} ${job.query.id} trial ${job.trial}\n`)
    const { answer, model, usage } = await runClaude(
      evaluationPrompt(job.query, job.response),
      options.model
    )
    runs.push({
      corpus: job.corpus,
      queryId: job.query.id,
      queryGroup: job.query.group,
      trial: job.trial,
      model,
      usage,
      retrievedContextTokens: (job.response.infoSnippets ?? []).reduce(
        (total, snippet) => total + snippet.contentTokens,
        0
      ),
      answer
    })
  }
  const deploymentRuns = runs.filter(({ queryGroup }) =>
    ['generic', 'agent-aware'].includes(queryGroup)
  )
  const usageSummary = Object.fromEntries(
    ['before', 'after'].map((corpus) => {
      const corpusRuns = deploymentRuns.filter((run) => run.corpus === corpus)
      return [
        corpus,
        {
          medianRetrievedContextTokens: median(
            corpusRuns.map(
              ({ retrievedContextTokens }) => retrievedContextTokens
            )
          ),
          medianEnvelopeInputTokens: median(
            corpusRuns.map(({ usage }) => usage.envelopeInputTokens)
          )
        }
      ]
    })
  )
  const outcome = {
    generatedAt: new Date().toISOString(),
    usageSummary,
    ...evaluateClaudeOutcomes(runs)
  }
  const report = renderReport(outcome)
  if (options.json) {
    await writeOutput(options.json, `${JSON.stringify(outcome, null, 2)}\n`)
  }
  if (options.markdown) {
    await writeOutput(options.markdown, report)
  }
  process.stdout.write(report)
  if (!outcome.pass) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
