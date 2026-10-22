/**
 * The scoped-pg harness's view of the domain error taxonomy.
 *
 * The taxonomy itself is DOMAIN logic, not harness infrastructure, so it lives in
 * `src/lib/supabase/errors.ts`. An earlier step of the Supabase port moved the whole
 * module under `tests/`, which inverted the dependency: the application would have had to
 * import from the test tree, or carry a second copy of the hierarchy. Two hierarchies
 * drift, and the drift shows up as an error that maps to one HTTP status in the app and a
 * different one in the tests.
 *
 * This file therefore re-exports, and adds nothing.
 */
export * from '../../../src/lib/supabase/errors'
