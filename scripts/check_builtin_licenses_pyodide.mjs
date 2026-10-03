/** Run API acceptance using an existing offline Pyodide 0.27.7 bundle. No downloads. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeArgument = process.argv[2]
if (!runtimeArgument) throw new Error('Usage: node scripts/check_builtin_licenses_pyodide.mjs /path/to/shipped/pyodide [backend_app.zip]')
const runtime = resolve(runtimeArgument)
const output = resolve(root, '.temp/license-acceptance')
mkdirSync(output, { recursive: true })
const backendArchive = process.argv[3] ? resolve(process.argv[3]) : resolve(output, 'backend_app.zip')
if (!process.argv[3]) {
  const pack = spawnSync(process.env.PYTHON ?? 'python3', ['-c',
    'from pathlib import Path; import scripts.build_static as b; b.CACHE_DIR=Path(".temp/license-acceptance"); b.package_backend_app()'],
    { cwd: root, encoding: 'utf-8' })
  if (pack.status !== 0) throw new Error(`Backend packaging failed: ${pack.stdout}\n${pack.stderr}`)
}
const { loadPyodide } = await import(pathToFileURL(resolve(runtime, 'pyodide.mjs')).href)
const py = await loadPyodide({ indexURL: runtime + '/' })
await py.loadPackage(['numpy', 'scipy', 'scikit-learn', 'polars', 'pyarrow', 'pydantic', 'anyio', 'sqlite3', 'idna'])
global.gc?.()
console.log('PACKAGES_READY_RSS', process.memoryUsage().rss)
for (const name of JSON.parse(readFileSync(resolve(runtime, 'wheels/manifest.json'), 'utf-8'))) {
  py.unpackArchive(new Uint8Array(readFileSync(resolve(runtime, 'wheels', name))), 'zip', { extractDir: '/lib/python3.12/site-packages' })
  global.gc?.()
}
py.unpackArchive(new Uint8Array(readFileSync(backendArchive)), 'zip', { extractDir: '/app' })
global.gc?.()
console.log('ARCHIVES_READY_RSS', process.memoryUsage().rss)
py.FS.mkdirTree('/acceptance')
py.FS.writeFile('/acceptance/check.py', readFileSync(resolve(root, 'scripts/check_builtin_licenses_runtime.py')))
py.runPython(`
import sys, os, runpy, pyodide, sklearn
assert pyodide.__version__ == '0.27.7', pyodide.__version__
assert sklearn.__version__ == '1.6.1', sklearn.__version__
sys.path.insert(0, '/app')
os.environ['DAVIS_PCP_WASM'] = '1'
os.environ['DAVIS_PCP_WORKSPACE'] = '/acceptance/workspace'
acceptance = runpy.run_path('/acceptance/check.py')
from app.main import app
`)
global.gc?.()
console.log('APP_READY_RSS', process.memoryUsage().rss)
const baseline = { wasmHeapBytes: py._module.HEAPU8.length, rssBytes: process.memoryUsage().rss }
try {
  await py.runPythonAsync("await acceptance['run_acceptance']('/acceptance/runtime-pyodide.json'); None")
} catch (error) {
  console.error(String(error)); process.exit(1)
}
writeFileSync(resolve(output, 'runtime-pyodide.json'), py.FS.readFile('/acceptance/runtime-pyodide.json'))
writeFileSync(resolve(output, 'runtime-pyodide-memory.json'), JSON.stringify({ baseline,
  final: { wasmHeapBytes: py._module.HEAPU8.length, rssBytes: process.memoryUsage().rss },
  peakNodeRssKiB: process.resourceUsage().maxRSS }, null, 2))
console.log('WASM_HEAP_BYTES', py._module.HEAPU8.length, 'PEAK_NODE_RSS_KIB', process.resourceUsage().maxRSS)
