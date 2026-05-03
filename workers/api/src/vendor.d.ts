// Wrangler `[[rules]] type = "Text"` ambient module declarations.
// The vendored p5/three files in workers/api/vendor/ are loaded as
// raw text strings so the freeze bundler can inline them into the
// frozen HTML output.
declare module "*p5.min.js" {
  const content: string;
  export default content;
}
declare module "*three.min.js" {
  const content: string;
  export default content;
}
