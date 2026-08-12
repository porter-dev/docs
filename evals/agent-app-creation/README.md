# Agent app-creation documentation evaluation

This evaluation measures whether Porter documentation makes the agent path prominent for application creation. The primary harness is local and reproducible: it fetches the live and proposed `llms-full.txt` files, selects each query's explicit canonical entry page, chunks both versions identically, ranks sections within that page with a small fielded BM25 implementation, and compares the context required to discover the agent workflow.

The primary metric is **tokens to first agent path**: the cumulative estimated documentation tokens before a ranked chunk names `create_app`, or connects the Porter MCP server or an agent to creating or deploying an application. Missing guidance receives one shared before-and-after penalty. The estimate is stable UTF-8 bytes divided by four, so it is suitable for relative comparisons without depending on a vendor tokenizer. This primary test measures prominence after an agent fetches an app-creation page; the optional Context7 run covers site-wide discovery.

The complete path requires all of the following facts:

- Call `create_app`.
- Pass `source` and `build`.
- Install the Porter GitHub App before calling the tool.
- Porter opens a pull request.
- Merge the pull request to trigger the first real deployment.

## Run the local retrieval evaluation

The preview must be public and expose `llms-full.txt` and `.md` page exports.

```bash
node evals/agent-app-creation/run.mjs \
  --after-url https://porter-preview.mintlify.site \
  --json /tmp/porter-agent-app-creation.json \
  --markdown /tmp/porter-agent-app-creation.md
```

The report records SHA-256 hashes for both input corpora. It also verifies that the agent-only direction appears in each proposed `.md` export but not in the visible HTML page.

By default, each answer receives only the top four chunks, creating a small and explicit documentation-context budget while preserving the stricter top-two ranking gates. Use `--max-chunks` to sweep smaller or larger windows when diagnosing a failure.

## Run the Claude outcome evaluation

Use the generated retrieval JSON as the only documentation context supplied to local Claude:

```bash
node evals/agent-app-creation/claude-outcomes.mjs \
  --evaluation /tmp/porter-agent-app-creation.json \
  --json /tmp/porter-agent-app-creation-claude.json \
  --markdown /tmp/porter-agent-app-creation-claude.md
```

This performs three trials for each generic and agent-aware query against both corpora, plus three trials for each proposed workflow query. Claude runs in safe mode with tools and project customizations disabled. The report records the estimated retrieved-document tokens and the model envelope's exact total input tokens (including fixed harness overhead), model, context-window size, and cost.

The outcome gate requires at least 15 of 18 proposed answers to lead with the agent path, an improvement of at least six answers over production, and at least five of six workflow answers to include all five required workflow facts. This remains a manual pull-request gate because model sampling can vary.

## Optional Context7 spot-check

`context7.mjs` preserves the external Context7 comparison, but it is not the primary gate because new website indexes depend on Context7's processing queue.

After both libraries are finalized and refreshed in the same evaluation window, run:

```bash
node evals/agent-app-creation/context7.mjs \
  --before /websites/porter_run \
  --after /websites/porter_preview \
  --before-source-url https://docs.porter.run \
  --after-source-url https://porter-preview.mintlify.site \
  --preview-url https://porter-preview.mintlify.site \
  --json /tmp/porter-agent-app-creation-context7.json \
  --markdown /tmp/porter-agent-app-creation-context7.md
```

## Test the scorers and retriever

```bash
node --test \
  evals/agent-app-creation/score.test.mjs \
  evals/agent-app-creation/retrieval.test.mjs
```
