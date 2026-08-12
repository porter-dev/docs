const DEFAULT_CHUNK_TOKENS = 600

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'can',
  'do',
  'for',
  'from',
  'how',
  'i',
  'is',
  'it',
  'my',
  'of',
  'on',
  'the',
  'to',
  'using',
  'what',
  'with'
])

const canonicalToken = (token) => {
  const aliases = {
    applications: 'application',
    apps: 'application',
    customization: 'customize',
    customized: 'customize',
    customizing: 'customize',
    created: 'create',
    creates: 'create',
    creating: 'create',
    creation: 'create',
    deployed: 'deploy',
    deploying: 'deploy',
    deployment: 'deploy',
    deployments: 'deploy',
    repositories: 'repository',
    repos: 'repository'
  }
  return aliases[token] ?? token
}

const searchTokens = (text) =>
  (text.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .map(canonicalToken)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))

export const estimateTokens = (text) =>
  Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4))

const splitOversizedParagraph = (paragraph, maxTokens) => {
  const maximumBytes = maxTokens * 4
  const pieces = []
  let remaining = paragraph
  while (Buffer.byteLength(remaining, 'utf8') > maximumBytes) {
    let end = 0
    let bytes = 0
    for (const character of remaining) {
      const characterBytes = Buffer.byteLength(character, 'utf8')
      if (bytes + characterBytes > maximumBytes) break
      bytes += characterBytes
      end += character.length
    }
    const boundary = Math.max(
      remaining.lastIndexOf('\n', end),
      remaining.lastIndexOf(' ', end)
    )
    if (boundary > end / 2) end = boundary
    const piece = remaining.slice(0, end).trim()
    if (piece) pieces.push(piece)
    remaining = remaining.slice(end).trim()
  }
  if (remaining) pieces.push(remaining)
  return pieces
}

const sectionUnits = (content) => {
  const units = []
  const visibilityPattern = /<Visibility\b[^>]*>[\s\S]*?<\/Visibility>/g
  let cursor = 0
  const addParagraphs = (text) => {
    units.push(
      ...text
        .trim()
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((content) => ({ content, atomic: false }))
    )
  }

  for (const match of content.matchAll(visibilityPattern)) {
    addParagraphs(content.slice(cursor, match.index))
    units.push({ content: match[0].trim(), atomic: true })
    cursor = match.index + match[0].length
  }
  addParagraphs(content.slice(cursor))
  return units
}

const chunkSection = (section, maxTokens) => {
  const paragraphs = sectionUnits(section.content).flatMap(
    ({ content, atomic }) =>
      estimateTokens(content) > maxTokens && !atomic
        ? splitOversizedParagraph(content, maxTokens)
        : content
  )
  const chunks = []
  let current = []

  for (const paragraph of paragraphs) {
    const candidate = [...current, paragraph].join('\n\n')
    if (current.length > 0 && estimateTokens(candidate) > maxTokens) {
      chunks.push(current.join('\n\n'))
      current = [paragraph]
    } else {
      current.push(paragraph)
    }
  }
  if (current.length > 0) chunks.push(current.join('\n\n'))
  return chunks
}

const pageSections = (body) => {
  const headings = [...body.matchAll(/^## (.+)$/gm)]
  const sections = []
  const introductionEnd = headings[0]?.index ?? body.length
  const introduction = body.slice(0, introductionEnd).trim()
  if (introduction) {
    sections.push({ title: 'Introduction', content: introduction })
  }
  for (const [index, heading] of headings.entries()) {
    const end = headings[index + 1]?.index ?? body.length
    sections.push({
      title: heading[1].trim(),
      content: body.slice(heading.index, end).trim()
    })
  }
  return sections
}

export const parseCorpus = (
  corpus,
  { maxChunkTokens = DEFAULT_CHUNK_TOKENS } = {}
) => {
  const headers = [...corpus.matchAll(/^# (.+)\nSource: (https?:\/\/\S+)\n/gm)]
  if (headers.length === 0) {
    throw new Error('The llms-full.txt corpus contains no page headers')
  }

  const chunks = []
  for (const [pageIndex, header] of headers.entries()) {
    const bodyStart = header.index + header[0].length
    const bodyEnd = headers[pageIndex + 1]?.index ?? corpus.length
    const pageTitle = header[1].trim()
    const pageId = header[2].trim()
    const sections = pageSections(corpus.slice(bodyStart, bodyEnd))

    for (const [sectionIndex, section] of sections.entries()) {
      for (const [chunkIndex, content] of chunkSection(
        section,
        maxChunkTokens
      ).entries()) {
        chunks.push({
          pageId,
          pageTitle,
          sectionTitle: section.title,
          breadcrumb: `${pageTitle} > ${section.title}`,
          content,
          contentTokens: estimateTokens(content),
          sourceOrder: [pageIndex, sectionIndex, chunkIndex]
        })
      }
    }
  }
  return chunks
}

const termFrequencies = (tokens) => {
  const frequencies = new Map()
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  }
  return frequencies
}

export const rankChunks = (chunks, query) => {
  const terms = [...new Set(searchTokens(query))]
  const querySequence = searchTokens(query)
  const queryBigrams = querySequence
    .slice(0, -1)
    .map((token, index) => `${token} ${querySequence[index + 1]}`)
  const documents = chunks.map((chunk) => {
    const contentTokens = searchTokens(chunk.content)
    const titleTokens = searchTokens(chunk.pageTitle)
    const sectionTokens = searchTokens(chunk.sectionTitle)
    return {
      chunk,
      contentTokens,
      contentFrequencies: termFrequencies(contentTokens),
      titleFrequencies: termFrequencies(titleTokens),
      sectionFrequencies: termFrequencies(sectionTokens),
      headingText: [...titleTokens, ...sectionTokens].join(' '),
      allTerms: new Set([...contentTokens, ...titleTokens, ...sectionTokens])
    }
  })
  const averageLength =
    documents.reduce(
      (total, document) => total + document.contentTokens.length,
      0
    ) / documents.length
  const documentFrequency = new Map(
    terms.map((token) => [
      token,
      documents.filter(({ allTerms }) => allTerms.has(token)).length
    ])
  )
  const k1 = 1.2
  const b = 0.75

  return documents
    .map((document) => {
      const score = terms.reduce((total, token) => {
        const contentFrequency = document.contentFrequencies.get(token) ?? 0
        const titleFrequency = document.titleFrequencies.get(token) ?? 0
        const sectionFrequency = document.sectionFrequencies.get(token) ?? 0
        if (contentFrequency + titleFrequency + sectionFrequency === 0) {
          return total
        }
        const containingDocuments = documentFrequency.get(token)
        const inverseDocumentFrequency = Math.log(
          1 +
            (documents.length - containingDocuments + 0.5) /
              (containingDocuments + 0.5)
        )
        const normalizedFrequency =
          (contentFrequency * (k1 + 1)) /
          (contentFrequency +
            k1 * (1 - b + b * (document.contentTokens.length / averageLength)))
        const fieldFrequency = titleFrequency * 3 + sectionFrequency * 3
        return (
          total +
          inverseDocumentFrequency * (normalizedFrequency + fieldFrequency)
        )
      }, 0)
      const phraseScore = queryBigrams.filter((bigram) =>
        document.headingText.includes(bigram)
      ).length
      return {
        ...document.chunk,
        retrievalScore: score + phraseScore * 2
      }
    })
    .sort((left, right) => {
      if (right.retrievalScore !== left.retrievalScore) {
        return right.retrievalScore - left.retrievalScore
      }
      for (let index = 0; index < left.sourceOrder.length; index += 1) {
        const difference = left.sourceOrder[index] - right.sourceOrder[index]
        if (difference !== 0) return difference
      }
      return 0
    })
}

export const retrieve = (chunks, query, maximumChunks) =>
  rankChunks(chunks, query).slice(0, maximumChunks)
