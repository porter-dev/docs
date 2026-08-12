import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs as parseNodeArgs } from 'node:util'

const camelCase = (name) =>
  name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())

export const parseOptions = (argv, { strings = [], booleans = [] }) => {
  const { values } = parseNodeArgs({
    args: argv,
    options: Object.fromEntries([
      ...strings.map((name) => [name, { type: 'string' }]),
      ...booleans.map((name) => [name, { type: 'boolean' }])
    ]),
    strict: true,
    allowPositionals: false
  })
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [camelCase(name), value])
  )
}

export const positiveInteger = (value, flag) => {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return number
}

export const writeOutput = async (path, content) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

export const gatesTable = (gates) => [
  '| Gate | Result | Detail |',
  '| --- | --- | --- |',
  ...gates.map(
    (gate) => `| ${gate.id} | ${gate.pass ? 'PASS' : 'FAIL'} | ${gate.detail} |`
  )
]

export const runMain = (main) => {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
