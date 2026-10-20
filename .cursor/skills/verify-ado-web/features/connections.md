# Connections

The connections page holds the ADO organization with its personal access token, and the SonarCloud personal token. Each form tests the connection first and saves the token to the OS credential store only if the test passes. The user can also forget a saved token.

## Sub-features

- `conn-status` shows whether each credential is configured, and the ADO organization.
- `conn-ado-save` tests and saves the organization and the PAT.
- `conn-sonar-save` tests and saves the Sonar token.
- `conn-reject` shows `Could not connect` for a bad token, and saves nothing.
- `conn-forget` deletes a saved credential.

## How to get to it (user POV)

- Choose the `connections` link in the inbox header, or open `/onboarding`.
- Choose `connections` in the `Not connected yet` alert on the inbox.

## Driving it with drive.mjs

Preconditions:

- Launch with `--fresh-credentials`. `doctor.mjs` shows `ado-web-verify-<stamp>/azure-devops (absent)`.
- Never drive this page on a run with the keyring service `ado-web`. A save or a forget there changes the user's real credential.

- **Status.** Open `/onboarding`. The heading reads `Connections`. Both forms are empty.
- **Reject.** Fill `Organization` with `Contoso` and `Personal access token` with `not-a-token`. Choose `Test and save`. The button reads `Testing…`, then an alert titled `Could not connect` appears. `doctor.mjs` still shows the credential as absent.
- **Sonar reject.** Fill `Personal token` with `not-a-token` and choose the second `Test and save`. The same alert appears for Sonar.
- **Save.** A save that passes needs a real token. Only the user can supply one. Report this sub-feature as not reachable, unless the user gives a token for this run.
- **Forget.** After a save that passed, choose `Forget`. The form returns to empty, and `doctor.mjs` shows the credential as absent.

## Gotchas

- `Test and save` sends a real request to `dev.azure.com` or `sonarcloud.io` with the token, even a fake one. A fake token gets a 401 and nothing is saved.
- The token fields are `type="password"`. Assert on the alert and on `doctor.mjs`, not on the field value.
- `stop.mjs` deletes the fresh keyring service. Evidence of the save is the doctor output that you capture before the stop.
