# The protocol ships as one SDK

Status: accepted. [ADR 0036](0036-app-capabilities-ship-with-the-sdk.md) extends the client entry with app capability helpers.

EAP's code leaves the product as one package, `@exterioragentprotocol/sdk`, with an entry for each role: `client` and `client/react` for web apps, `device` for daemons, `relay` for relays, and the package root for the wire types and codes every role shares. The earlier plan split it into four packages, `protocol`, `client`, `device` and `relay`, which then had to share one version, depend on each other at that exact version, and keep `protocol` unbundled so that one copy was installed and `instanceof` on its error classes held. One package gives all of that without the rules. An app imports only its role's entry, so a web app's bundle carries no device or relay code, and a browser never loads a Node module.

The protocol entries implement the spec. Product choices such as GitHub sign-in, consent, the dashboard, and the agent catalog stay in the product, which depends on the SDK.

## Considered Options

- **Four packages under `@exterioragentprotocol/`.** Rejected. Their only gain is that installing the client does not download the relay's source, and the version rules they need are the kind that break silently on a mistaken publish.
- **The SDK inside `@exterior/client`.** Rejected. A third-party relay or device would install a package named for one product and carrying its constants.

## Consequences

- Node-only code is reachable only from `device` and `relay`. The root and `client` entries run in a browser.
- `ws` is a dependency of the package and is installed for a web app too, unused. `react` is an optional peer.
