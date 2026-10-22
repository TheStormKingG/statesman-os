/**
 * The ONE browser Supabase client, and the narrow `Database` type it is typed
 * against.
 *
 * ADR-0015: the application is a Next.js static export on GitHub Pages. There
 * is no server at runtime, so this module runs in the user's browser and the
 * key it carries is the PUBLISHABLE anon key, which ships in the bundle and is
 * readable by anyone who opens the page. That is Supabase working as intended —
 * and it is why RLS is the only wall left. Every table these queries touch is
 * `enable`d and `force`d under RLS with a policy keyed on `auth.uid()`.
 *
 * ── THE SERVICE ROLE KEY IS NOT REFERENCED HERE, AND MUST NEVER BE ──────────
 *
 * `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS entirely (`rolbypassrls`). A static
 * export has no server-side execution context, so ANY key this module could
 * read would be inlined into a public JavaScript bundle. There is no
 * conditional, no "only in production", no environment in which reading it
 * here is safe. It is absent by construction and the absence is the control:
 * the string does not appear in this directory, so a grep over `src/` is a
 * sufficient check. The name is written once, right here, in a sentence saying
 * never to use it.
 *
 * ── WHY THIS FAILS AT MODULE LOAD ──────────────────────────────────────────
 *
 * `createClient('undefined', 'undefined')` succeeds. It returns a perfectly
 * well-formed client that cannot reach anything, and every call through it
 * fails later as a network error at some call site that has nothing to do with
 * the real fault. Worse, under `output: 'export'` a missing `NEXT_PUBLIC_*` is
 * substituted as the literal `undefined` AT BUILD TIME, so the broken bundle is
 * the artefact that gets published — there is no runtime at which someone could
 * notice and fix the environment. Throwing here makes `next build` fail instead,
 * which is the last moment anything can.
 *
 * ── WHY DOT ACCESS, NOT `process.env['...']` ───────────────────────────────
 *
 * Next inlines `process.env.NEXT_PUBLIC_FOO` by textual substitution at build
 * time. Bracket access is not substituted, so `process.env['NEXT_PUBLIC_FOO']`
 * reads a `process.env` that does not exist in a browser and is `undefined`
 * even when the variable was set. The dot form is load-bearing, not a style
 * choice, and it is the reason this module reads the two names as literals
 * rather than through a helper taking the name as an argument.
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { ConfigurationError } from './errors'

/* ------------------------------------------------------------------ *
 * The JSON type, matching `jsonb`
 * ------------------------------------------------------------------ */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

/* ------------------------------------------------------------------ *
 * The `Database` type
 * ------------------------------------------------------------------ */

/**
 * HAND-WRITTEN, from `supabase/migrations/**` — not generated.
 *
 * `supabase gen types` would have to reach project `onpkspfxfmjkqpomcsse`, and
 * this work is forbidden from contacting it. So this is a transcription, and a
 * transcription can drift from the schema. Two things keep that honest:
 *
 *   1. it is NARROW. Only the relations and functions this data layer actually
 *      reads are declared. A table nobody queries is not transcribed, so there
 *      is nothing to be wrong about;
 *   2. nothing trusts it at runtime. Every row that leaves `decisions.ts` or
 *      `scenarios.ts` is parsed by a zod schema first, so a column that is not
 *      the shape declared here fails loudly at the boundary rather than flowing
 *      into the UI as a lie. The TypeScript type buys column-name checking at
 *      the call site; zod buys the actual guarantee.
 *
 * OWED: regenerate this with `supabase gen types typescript` once the
 * migrations are applied to the live project, and diff it against this file.
 * That diff is the only thing that can prove the transcription correct.
 *
 * `state` is a GENERATED STORED column, so it is readable and never writable:
 * it is in `Row` and absent from both `Insert` and `Update`. Likewise
 * `decision.draft_payload` is the only column `authenticated` holds
 * `UPDATE` on, so `Update` names it alone — the grant is narrower than the row
 * and the type says so.
 */
export type DecisionState =
  | 'draft'
  | 'submitted'
  | 'challenged'
  | 'reflected'
  | 'action_recorded'
  | 'reviewed_closed'

type NoRelationships = []

export interface Database {
  public: {
    Tables: {
      profile: {
        Row: {
          user_id: string
          display_name: string | null
          created_at: string
          updated_at: string
        }
        // `user_id` is required on insert: the policy's `with check` refuses a
        // row whose owner is not `auth.uid()`, so there is no server default to
        // fall back on and omitting it is always a rejected write.
        Insert: { user_id: string; display_name?: string | null }
        // GRANT UPDATE (display_name) ONLY. Nothing else is writable, even by
        // the row's owner.
        Update: { display_name?: string | null }
        Relationships: NoRelationships
      }
      decision: {
        Row: {
          id: string
          user_id: string
          draft_payload: Json
          draft_updated_at: string | null
          submitted_at: string | null
          challenged_at: string | null
          reflected_at: string | null
          action_recorded_at: string | null
          closed_at: string | null
          created_at: string
          state: DecisionState
        }
        Insert: { user_id: string; id?: string; draft_payload?: Json }
        Update: { draft_payload?: Json }
        Relationships: NoRelationships
      }
      decision_revision: {
        Row: {
          id: string
          decision_id: string
          user_id: string
          revision_no: number
          content: Json
          confidence: number
          forecast: string
          horizon: string
          rationale: string
          idempotency_token: string
          created_at: string
        }
        // `authenticated` holds INSERT, but every legitimate revision is
        // written by `app.submit_decision` / `app.append_revision`, which own
        // the `revision_no` arithmetic and the idempotency probe. Declared
        // because the grant exists; not used by this data layer.
        Insert: {
          decision_id: string
          user_id: string
          revision_no: number
          content: Json
          confidence: number
          forecast: string
          horizon: string
          rationale: string
          idempotency_token: string
          id?: string
        }
        // No UPDATE grant, and `dr_no_update` / `dr_no_delete` raise ST001 for
        // the table owner too (V32). Append-only in the type as well.
        Update: Record<string, never>
        Relationships: NoRelationships
      }
      scenario: {
        Row: {
          id: string
          slug: string
          status: string
          sector: string
          jurisdiction: string
          created_at: string
        }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: NoRelationships
      }
      scenario_version: {
        Row: {
          id: string
          scenario_id: string
          version_no: number
          content: Json
          is_fiction: boolean
          as_of_date: string
          rubric_version_id: string | null
          published_at: string | null
          created_at: string
          content_hash: string
        }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: NoRelationships
      }
      source: {
        Row: {
          id: string
          scenario_version_id: string
          title: string
          publisher: string
          uri: string | null
          published_date: string | null
          retrieved_date: string | null
          kind: string
        }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: NoRelationships
      }
      scenario_claim: {
        Row: {
          scenario_version_id: string
          claim_id: string
          source_id: string
          claim_text: string
          confidence: string
        }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: NoRelationships
      }
      rubric_version: {
        Row: {
          id: string
          version_no: number
          content: Json
          published_at: string | null
        }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: NoRelationships
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
  }
  app: {
    Tables: Record<string, never>
    Views: Record<string, never>
    Functions: {
      // Argument names are the SQL parameter names: PostgREST matches the JSON
      // body keys against them, so `p_decision_id` is part of the wire contract
      // and renaming a SQL parameter is a breaking API change.
      //
      // Both return `table (...)`, i.e. SETOF, so PostgREST answers with an
      // ARRAY. That array's length is the row count the client has to assert
      // for itself, because there is no server-side `get diagnostics` left.
      submit_decision: {
        Args: {
          p_decision_id: string
          p_token: string
          p_content: Json
          p_confidence: number
          p_forecast: string
          p_horizon: string
          p_rationale: string
        }
        Returns: { revision_id: string; revision_no: number; replayed: boolean }[]
      }
      append_revision: {
        Args: {
          p_decision_id: string
          p_token: string
          p_content: Json
          p_confidence: number
          p_forecast: string
          p_horizon: string
          p_rationale: string
        }
        Returns: { revision_id: string; revision_no: number; replayed: boolean }[]
      }
      stamp_milestone: {
        Args: { p_decision_id: string; p_milestone: string }
        Returns: undefined
      }
    }
  }
}

/** The client type every function in this directory takes as its first argument. */
export type StatesmanClient = SupabaseClient<Database, 'public', 'public'>

/* ------------------------------------------------------------------ *
 * Environment
 * ------------------------------------------------------------------ */

/**
 * A URL, because `createClient` string-concatenates this into every request
 * path. A value that is not a URL produces a request to a nonsense address and
 * a CORS error, which reads as "Supabase is down".
 */
const urlSchema = z.string().url()

/**
 * Non-empty, and nothing more.
 *
 * DELIBERATELY NOT a JWT-shape check. Supabase issues both the legacy
 * three-segment anon JWT and the newer `sb_publishable_…` key format, and a
 * validator that knew only one of them would reject a correct key and send
 * whoever hit it looking for a fault in their project rather than in this line.
 * A validator stricter than the thing it validates is the same mistake
 * `z.uuid()` was.
 */
const anonKeySchema = z.string().min(1)

function requirePublicEnv(name: string, raw: string | undefined, schema: z.ZodType<string>): string {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new ConfigurationError(
      `${name} is missing or malformed. It is read at BUILD time and inlined into the ` +
        `static bundle, so this is a build-environment fault, not a runtime one: set it ` +
        `in .env.local (or the Pages workflow's environment) and rebuild. ` +
        `Never set the service role key in its place — it bypasses RLS.`,
    )
  }
  return parsed.data
}

/**
 * Read once, at module load, so the failure lands on the first import rather
 * than on the first query. The two names are written as literals for the
 * build-time substitution described in the header.
 */
const SUPABASE_URL = requirePublicEnv(
  'NEXT_PUBLIC_SUPABASE_URL',
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  urlSchema,
)

const SUPABASE_ANON_KEY = requirePublicEnv(
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  anonKeySchema,
)

/* ------------------------------------------------------------------ *
 * The client
 * ------------------------------------------------------------------ */

/**
 * ONE client for the whole application.
 *
 * One, not one per module: the GoTrue client holds the session and its refresh
 * timer, and two instances on the same page race each other over the same
 * storage key — one refreshes, the other writes back the token it still
 * remembers, and the user is signed out mid-session. The browser console says
 * as much ("Multiple GoTrueClient instances detected"). So this is a module
 * singleton on purpose.
 */
export const supabase: StatesmanClient = createClient<Database, 'public', 'public'>(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      // The session has to outlive a page load: GitHub Pages serves static
      // files and every navigation is a fresh document.
      persistSession: true,
      autoRefreshToken: true,
      // Magic-link and OAuth callbacks come back with the tokens in the URL
      // fragment. There is no server to handle a code exchange, so the browser
      // has to read them.
      detectSessionInUrl: true,
    },
  },
)

/**
 * The `app` schema handle, for the lifecycle RPCs.
 *
 * The functions live in schema `app`, not `public`, and PostgREST only serves
 * schemas listed in its exposed-schema setting. `supabase.schema('app')` picks
 * the schema PER CALL and is typed from `Database['app']`.
 *
 * UNVERIFIED, and it is the first thing to check when an RPC 404s against the
 * live project: `app` must be added to the project's exposed schemas (API
 * settings → "Exposed schemas", or `db-schemas` in the PostgREST config).
 * Nothing in `supabase/migrations/**` can set that — it is a project setting,
 * not SQL — and this work is forbidden from contacting the project to confirm
 * it. The symptom is `PGRST106` (schema not exposed) or `PGRST202` (function
 * not found in the schema cache), both of which `errors.ts` maps to a named
 * configuration error rather than to "not found", precisely so this shows up as
 * a deployment fault instead of an empty screen.
 */
export const appSchema = supabase.schema('app')

/** The type of the `app`-schema handle, so callers can be typed without re-deriving it. */
export type AppSchemaClient = typeof appSchema
