import { expect, test } from "bun:test"
import { Schema } from "effect"
import { PublicationBody, PublicationMessage, PublicationTitle } from "../../src/sandbox/config"
import { publicationCorpus } from "./publication-corpus"

const inputs = publicationCorpus.flatMap((item) =>
  ["body", "title", "commitMessage"].map((field) => ({
    ...item,
    field,
    accepted: item.accepted && (field !== "title" || !item.value.includes("\n")),
  })),
)
async function run(args: string[]) {
  const child = Bun.spawn(args, {
    stdin: new Blob([JSON.stringify(inputs)]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0) throw new Error(err)
  return Schema.decodeUnknownSync(Schema.Array(Schema.Boolean))(JSON.parse(out))
}
// Load the publisher's real validators in Node without running its CLI or contacting GitHub.
const publisherResults = await run([
  "node",
  "--input-type=module",
  "-e",
  `
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { safePublication } from './deploy/sandbox/publication.mjs'
const source = readFileSync('deploy/sandbox/publish.mjs', 'utf8')
const validate = runInNewContext(source.slice(source.indexOf('function publicationText('), source.indexOf('function verifyCommit(')) +
  '(value, field) => { try { if (field === "body") validateBody(value); else publicationText(value, field === "commitMessage"); return true } catch { return false } }',
  { Buffer, assert, safePublication })
console.log(JSON.stringify(JSON.parse(readFileSync(0, 'utf8')).map(item => validate(item.value, item.field))))
`,
])
const results = await run([
  "python3",
  "-B",
  "-c",
  `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('result', 'deploy/sandbox/result.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
results = []
for item in json.load(sys.stdin):
    try:
        if item['field'] == 'body': m.publication_body(item['value'])
        else: m.publication_text(item['value'], item['field'] == 'commitMessage')
        results.append(True)
    except (AssertionError, ValueError): results.append(False)
print(json.dumps(results))
`,
])
for (const [index, item] of inputs.entries()) {
  test(`publication parity ${item.field}: ${JSON.stringify(item.value)}`, () => {
    const schema = {
      body: PublicationBody,
      title: PublicationTitle,
      commitMessage: PublicationMessage,
    }[item.field]!
    expect({
      schema: Schema.is(schema)(item.value),
      python: results[index],
      publisher: publisherResults[index],
    }).toEqual({ schema: item.accepted, python: item.accepted, publisher: item.accepted })
  })
}
