# Continue Core Binary

The purpose of this folder is to package Typescript code in a way that can be run from any IDE or platform. We first bundle with `esbuild` and then package into binaries with `pkg`.

The `pkgJson/package.json` contains instructions for building with pkg, and needs to be in a separte folder because there is no CLI flag for the assets option (it must be in a package.json), and pkg doesn't recognize any name other than package.json, but if we use the same package.json with dependencies in it, pkg will automatically include these, significantly increasing the binary size.

The build process is otherwise defined entirely in `build.js`.

### List of native modules

- sqlite3/build/Release/node_sqlite3.node (\*)
- @lancedb/\*\*
- esbuild?
- @esbuild?
- onnxruntime-node (not packaged: transformers.js embeddings are VS Code only)

### List of dynamically imported modules

- @octokit/rest
- esbuild

### List of .wasm files

- tree-sitter.wasm
- tree-sitter-wasms/

(\*) = need to download for each platform manually

## Debugging

To debug the binary with IntelliJ, set `USE_TCP` to `true` for the IDE process and set the same `CONTINUE_TCP_TOKEN` (at least 16 characters) on that process and on the core process. Then in VS Code run the "Core Binary" debug script. The core listens on `127.0.0.1:3000` and accepts only a connection that presents that token. If the core is started without `CONTINUE_TCP_TOKEN`, it generates one and prints it; copy that value into the IDE process. You can place breakpoints anywhere in the `core` or `binary` folders.

## Building

```bash
npm run build
```

## Testing

```bash
npm run test
```
