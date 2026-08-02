import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const extensionCfg = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: false,
};

const webviewCfg = {
  entryPoints: ['webview/main.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  outfile: 'media/webview.js',
  minify: true,
  sourcemap: false,
};

if (watch) {
  const ctxs = await Promise.all([esbuild.context(extensionCfg), esbuild.context(webviewCfg)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching...');
} else {
  await Promise.all([esbuild.build(extensionCfg), esbuild.build(webviewCfg)]);
  console.log('build done');
}
