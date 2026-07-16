# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub Security Advisories
("Report a vulnerability" under the repository's Security tab). If that is not
available to you, open a regular GitHub issue but leave out exploit details and
ask a maintainer for a private channel.

We will acknowledge reports and work with you on a fix. There is no bug bounty.

## Threat model (Phase 1)

Be aware of these design choices before deploying:

- **The beliefs API is unauthenticated.** `GET /api/beliefs/:sessionId` has no
  auth check. Anyone who knows a session id can read that session's captured
  beliefs.
- **The session id is a capability URL.** The session id (`x-axion-session`, a
  UUID by default) is the only thing protecting a session's data. Treat it like
  a secret: don't paste it into public places, logs, or shared dashboards you
  don't control.
- **Upstream credentials pass through.** The proxy forwards the caller's
  `Authorization` / `x-api-key` upstream, or uses the `UPSTREAM_API_KEY` secret
  if configured. It never logs keys and never sends `Bearer undefined`.

## Known future work (not implemented yet)

- Rate limiting on proxy and beliefs endpoints.
- Authentication / access control for the beliefs API.

If your deployment handles sensitive data, keep session ids secret and put the
Worker behind your own access controls until these land.
