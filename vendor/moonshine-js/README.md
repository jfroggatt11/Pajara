# Vendored MoonshineJS browser bundle

This directory contains the unmodified `dist/moonshine.min.js` and MIT licence from
the official `@moonshine-ai/moonshine-js` 0.1.29 npm release:

- Source: <https://github.com/moonshine-ai/moonshine-js>
- Release tarball:
  <https://registry.npmjs.org/@moonshine-ai/moonshine-js/-/moonshine-js-0.1.29.tgz>
- Bundle SHA-256:
  `5531de142441cec986ee8e171461fbe4a06c071aefe1be8e4356b708ccf32eb9`

It is vendored because the upstream npm manifest references a repository-local VAD
package that is absent from the npm release. Pajara only imports the already-built
browser bundle and uses its exported `MoonshineModel`; it does not use that VAD
dependency. Vendoring also avoids installing unrelated Node-only build dependencies
that are already contained in, or unnecessary for, the browser bundle.

Replace this directory only after reviewing a newer official release, updating the
version and checksum, running the full test/build suite, and testing transcription on
the intended phones.
