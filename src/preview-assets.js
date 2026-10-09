// build.mjs replaces this pinned KaTeX CSS import with an inline CSS string
// whose font-face URLs are data URIs. Keeping this as a module boundary lets
// preview hosts import { katexCss } from './preview-assets.js' without network access.
export { katexCss } from 'katex/dist/katex.min.css?inline';
