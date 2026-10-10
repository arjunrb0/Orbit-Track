// The two satellite.js functions we use as the SGP4 reference.
//
// Why not `import ... from 'satellite.js'`? Since v7 the package root also
// re-exports an optional multi-threaded WebAssembly build, which Vite can't
// bundle for the browser ("top-level await is not supported"). These two
// files are plain JavaScript with no WebAssembly. The package's "exports"
// field doesn't list them, so they're imported by relative path, which works
// the same in Node (tests) and Vite (the site).
export { json2satrec, twoline2satrec } from '../../node_modules/satellite.js/dist/io.js';
export { sgp4 } from '../../node_modules/satellite.js/dist/propagation/sgp4.js';
