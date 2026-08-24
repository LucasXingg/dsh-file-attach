# Contributing

Thanks for helping improve `dsh-file-attach`.

## Development

You need Node.js 22.13 or newer.

```sh
git clone https://github.com/lucadxingg/unified-file-reader.git
cd unified-file-reader
npm ci
npm test
```

The web client is assembled from `src/client-core.js` and
`src/client-app.js`. After changing either source file, regenerate and verify
the committed bundle:

```sh
npm run build:client
git diff --exit-code -- lib/client.js
```

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Add or update tests for behavior changes.
- Run `npm test` and `npm pack --dry-run` before submitting.
- Do not commit credentials, uploaded files, or local DSH state.

By contributing, you agree that your contribution is licensed under the
project's MIT License.
