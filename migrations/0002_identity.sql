-- 0002 Identity tables. Grant-protected: no direct grants to statesman_app.
\set ON_ERROR_STOP on
set role statesman_owner;

create table public.app_user (
  id              uuid primary key default gen_random_uuid(),
  email           text        not null,
  password_hash   text        not null,
  algo_ver        smallint    not null default 1,
  privilege_epoch integer     not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index app_user_email_lower_uq on public.app_user (lower(email));  -- V21, no citext

create table public.user_session (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references public.app_user(id) on delete restrict,
  token_hash               bytea not null unique,        -- the hash, never the token
  privilege_epoch_at_issue integer not null,
  created_at               timestamptz not null default now(),
  absolute_expires_at      timestamptz not null,
  idle_expires_at          timestamptz not null,
  last_seen_at             timestamptz not null default now(),
  revoked_at               timestamptz
);
create index user_session_user_idx on public.user_session (user_id);

create table public.auth_attempt (
  id         bigserial primary key,
  identifier text not null,
  outcome    text not null check (outcome in ('success','failure')),
  at         timestamptz not null default now()
);
create index auth_attempt_ident_at_idx on public.auth_attempt (identifier, at desc);

-- No grants to statesman_app on any of the three. Access is via definer functions only.
revoke execute on all functions in schema app    from public;
revoke execute on all functions in schema public from public;
