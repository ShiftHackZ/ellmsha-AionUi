# Optional embedded Copilot IDE runtime

Stage a source-built Code OSS runtime with the repository-level
`scripts/copilot-ide/stage-runtime.mjs --source PATH` before packaging this
provider. Generated runtime files are ignored by Git. No Marketplace extension
binaries, GitHub credentials, user profiles or authentication state belong here.
The desktop provider remains unavailable when the runtime is absent.
