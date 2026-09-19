# Public opportunity data

Study Mate calls the provider-supplied HTTPS OnTong Youth endpoint `/go/ythip/getPlcy` only from the server endpoint `/api/opportunities`.
`YOUTH_POLICY_API_KEY` stays in the server environment (or a local `.env`) and is never returned to the browser, stored in localStorage, or included in client code.

The current adapter uses the official youth-policy list endpoint and caches identical server requests for five minutes. It normalizes only fields provided by the response. Missing eligibility fields remain `null`, and matching is shown as `UNKNOWN`, never as a confirmed match.

Scholarship, volunteer, and contest adapters intentionally report `source-not-configured` until a suitable real-time official source is connected; they do not substitute sample opportunities.

If the upstream API cannot establish a secure connection, the browser receives `upstream-tls-failure`. Do not disable certificate validation to work around it.
