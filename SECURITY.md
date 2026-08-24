# Security policy

## Supported versions

Security fixes are provided for the latest published release.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use the
repository's **Security** tab and select **Report a vulnerability** to send a
private report.

Include the affected version, impact, reproduction steps, and any suggested
mitigation. Maintainers will acknowledge the report, investigate it, and
coordinate disclosure and a fix when appropriate.

## Deployment note

The plugin's ingest routes are same-origin and session-aware, but do not carry
a separate bearer credential. Bind the DSH host to `127.0.0.1` unless an
authenticated reverse proxy protects it.
