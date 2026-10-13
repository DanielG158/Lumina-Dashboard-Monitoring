# Security

Lumina can start and stop servers, so please report security problems privately.

**Report a vulnerability:** use GitHub's *Security → Report a vulnerability* on this repository (private advisory), not a public issue. Include what you found, how to reproduce it and the version. I aim to answer within a week.

Notes for running Lumina safely:

- Keep it on your local network or behind a VPN. It has no protection against a determined attacker on the open internet beyond login lockout and rate limits.
- Create the admin account straight after installing, and keep the one-time setup code private.
- The data folder (`/var/lib/lumina`) holds the encryption key and the database. Back it up and protect it like a password file.
- Read [docs/security-assessment.md](docs/security-assessment.md) for what has been reviewed and what is known.
