# scrcpy-server

`scrcpy-server-v3.3.3.jar` is the unmodified server of scrcpy 3.3.3 by Genymobile
and Romain Vimont, licensed under the Apache License 2.0 (see `LICENSE`).

- Source: <https://github.com/Genymobile/scrcpy> (release `v3.3.3`, asset `scrcpy-server-v3.3.3`)
- SHA-256: `7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`

The file is pushed to a phone only when its owner presses "Handy verbinden" in
the tab "Handy spiegeln" (`src/lib/phoneMirror.ts`), which checks the hash first.
The server and the client library (`@yume-chan/*`) must name the same version;
`npm run verify:scrcpy` checks that. Replace the file only together with the
client packages, and update the hash in `phoneMirror.ts` and in this file.
