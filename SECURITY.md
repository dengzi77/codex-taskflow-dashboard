# Security policy

## Supported version

Security fixes are applied to the latest release and the `main` branch.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not include Codex
tokens, account identifiers, task contents, `.data` files, or launcher logs in a public issue.

## Local security model

- Services bind to `127.0.0.1` by default.
- The dashboard reads the currently signed-in Codex account through the local Codex app process.
- Local acceptance and queue state stay in `.data/`, which is excluded from Git.
- The project does not patch files inside the signed official Codex application bundle.
- The macOS launcher enables a loopback debugging port. Other local processes running as the same
  user may be able to access that port, so only install this project on a trusted machine.
