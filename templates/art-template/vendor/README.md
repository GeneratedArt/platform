# vendor/

Drop the vendored copies of the libraries you use here. Filenames must start
with the library name from the allowlist:

- `p5.min.js`, `p5.sound.min.js`
- `three.min.js`, `three.r150.min.js`
- `regl.min.js`
- `tone.min.js`
- `d3.min.js`

The validator (`.github/scripts/validate-static.mjs`) refuses any file whose
name doesn't start with one of those prefixes.
