// POSITIVE CONTROL for assertUnprivilegedOnce: the SAME call, with
// APP_DATABASE_URL pointing at statesman_migrator (a member of the schema
// owner), must be REJECTED. A gate that cannot be made to fail has not been
// shown to work.
const { assertUnprivilegedOnce, closePools } = await import(
  '/Users/stefangravesande/Documents/Projects/Stathos/src/server/db/pool')
let outcome = 'ACCEPTED (gate did not fire)'
try {
  await assertUnprivilegedOnce()
} catch (e) {
  outcome = `${(e as Error).constructor.name}: ${(e as Error).message}`
}
await closePools()
console.log(outcome)
process.exit(outcome.startsWith('PrivilegeAssertionError') ? 0 : 1)
