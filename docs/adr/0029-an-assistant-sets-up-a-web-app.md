# An assistant sets up a web app with one account approval

Status: accepted. Amends 0028.

An app that wants a client ID on one relay can have a coding assistant set it up. The assistant picks a random setup ID, gives the person a relay link with the app name and callback, and polls for the result. The person signs in and confirms. `POST /api/clients/register` accepts the signed approval form as well as account-authenticated JSON.

A person registering an app by hand uses Register app on the dashboard and copies the SDK configuration as one object. The assistant receives the same shape in the setup result: relay URL, client ID, and redirect URI. Either way, a public registration with the same name and callback for the same account returns the client it already has.

The setup id finds a public configuration and carries no account credentials. Polling allocates no state. Only an authenticated decision leaves a result, in memory for ten minutes, with at most ten recent setups per account. The browser's approval is signed, account-bound, and expires in ten minutes. This works when the assistant runs on a different computer from the browser, without a loopback listener or a copied id. A relay restart loses outstanding results; repeating setup returns the same client. Registration and access to devices remain separate approvals.

An account can register an app on one relay for either local or deployed use. An app that needs one identity across relays can publish a metadata document on its own site.

The default relay is the hosted relay. Running a relay is an operator task. A published metadata identity remains the way to name an app across relays; a relay-issued id belongs to its issuer. Neither registration nor a metadata document verifies an app's claimed name.

## Considered Options

- **A CLI command that runs the flow.** Rejected. Every step is one HTTP request an assistant can make with `curl`, and an app developer may have no Exterior device software installed.
- **The person registers on the dashboard and copies the client id back to the assistant.** Kept for registering by hand, rejected for assistants: it asks the person to carry an id between windows.
- **A credential that lets the assistant register apps itself.** Rejected. It would hold standing power over the account to make one public record.
- **Accept only loopback callbacks.** Rejected. Account registration also supports apps with HTTPS callbacks.
- **A shared client that accepts any loopback callback.** Rejected. Every local app would sign in under one name and one grant.
