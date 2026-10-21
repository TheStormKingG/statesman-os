/**
 * Vitest globalSetup for the integration suite. Runs once per run, in the main process.
 *
 *   setup:    sweep stray worker databases, build the template, publish a run id.
 *   teardown: drop every worker database belonging to this run.
 *
 * The run id travels to workers through `process.env`, which forked workers inherit at
 * spawn time — workers are spawned lazily by the pool, after globalSetup has returned.
 * `db.ts` refuses to derive a database name without it, so a test file run outside this
 * config fails loudly instead of quietly skipping the template build.
 */
import { randomBytes } from 'node:crypto'
import {
  RUN_ID_ENV,
  buildTemplateDatabase,
  dropTestDatabases,
  harnessEnv,
  listTestDatabases,
} from './db'

export async function setup(): Promise<void> {
  const env = harnessEnv()

  // Strays from a crashed run would otherwise accumulate, and a stale clone of an older
  // template is worse than no clone: it fails the suite for the wrong reason.
  const strays = await listTestDatabases()
  if (strays.length > 0) {
    console.log(`[integration] dropping ${strays.length} stray worker database(s): ${strays.join(', ')}`)
    await dropTestDatabases()
  }

  console.log(`[integration] building template ${env.TEST_TEMPLATE_DB}`)
  const output = await buildTemplateDatabase()
  for (const line of output.split('\n')) if (line.length > 0) console.log(`  ${line}`)

  const id = randomBytes(4).toString('hex')
  process.env[RUN_ID_ENV] = id
  console.log(`[integration] run id ${id}`)
}

export async function teardown(): Promise<void> {
  const id = process.env[RUN_ID_ENV]
  if (id === undefined) return
  const dropped = await dropTestDatabases(id)
  if (dropped.length > 0) {
    console.log(`[integration] dropped ${dropped.length} worker database(s): ${dropped.join(', ')}`)
  }
}
