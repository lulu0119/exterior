# An app keeps its Code Mode scripts

Status: accepted.

The optional Client SDK Code Mode extension can persist an app's saved JavaScript. The app supplies its own unstorage instance and selects which source to save. That source is reusable across harnesses and ACP sessions. Pi's per-session JSON store has a separate lifetime.

Following [Cloudflare Code Mode snippets](https://github.com/cloudflare/agents/blob/06a271526fd7d4a6dd1ee0ea238fe30402494880/docs/codemode/snippets.md), the harness sees one MCP tool, `execute`. Given a catalog, the script can search and describe both current app tools and saved scripts. `codemode.run` resolves saved source through the catalog and runs it inside the current Pi VM. Its result is a JavaScript value, so the caller can compose it with other scripts and app tools. Pi supplies the enclosing run's timeout, cancellation, output and JSON store.

Apps use the `client-sdk/codemode` entry for the sandbox, MCP connection and optional catalog. Code Mode assembles the Pi program while the run request retains the original source for app recording or curation. Saved input schemas are descriptive metadata. Zod checks record shape, Fuse.js searches metadata, and the app chooses an unstorage driver.
