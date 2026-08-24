# Security policy

## Supported versions

crust is pre-1.0. Security fixes land on the latest released version only.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's private reporting — the **Security** tab → *Report a vulnerability*
— which opens a private advisory visible only to the maintainer.

Expect an acknowledgement within a few days. If a fix is warranted it ships in
the next release, and the advisory is published once users have had a chance to
upgrade.

## Scope worth knowing before you report

Two behaviours are deliberate design, not vulnerabilities:

- **crust evaluates the TypeScript lambdas you type.** `ls | (s => s.trim())`
  compiles user input with `new Function`. The trust boundary is the user's own
  terminal — the same one bash has when it sources a script you wrote.
- **Shell stages run under `sh -c`.** A crust line that isn't recognised as a
  crust stage is handed to the system shell verbatim, by design.

What *is* in scope: anything that lets a **remote or third-party input** — a
fetched HTTP body, an OpenAPI spec, a `.pipes` or fixture file from elsewhere —
cause execution or disclosure the user did not ask for. The installer's
integrity path is also in scope: both `install.sh` and the npm launcher verify
a published sha256 before the downloaded file is ever made executable, and a
way around that is a vulnerability.
