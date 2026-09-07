/**
 * Pyodide Web Worker for standalone DAVIS-PCP static build.
 * Runs FastAPI ASGI application in-memory via Pyodide WASM runtime.
 * All dependencies and wheels are loaded from local static assets.
 */

declare const self: DedicatedWorkerGlobalScope & {
  loadPyodide: (options: { indexURL: string }) => Promise<any>
}

interface WorkerInitMessage {
  type: 'INIT'
  pyodideBaseUrl: string
}

interface WorkerApiRequest {
  type: 'REQUEST'
  id: number
  method: string
  path: string
  headers?: Record<string, string>
  body?: string | ArrayBuffer | Uint8Array
  filePayload?: {
    filename: string
    data: ArrayBuffer
    extra?: Record<string, string>
  }
}

type WorkerIncomingMessage = WorkerInitMessage | WorkerApiRequest

let pyodideInstance: any = null
let pyDispatchFn: any = null

function postStatus(stage: string, progress: number, message: string) {
  self.postMessage({ type: 'STATUS', stage, progress, message })
}

async function initPyodide(baseUrl: string) {
  try {
    postStatus('loading_runtime', 0.1, 'Python WASM ランタイムを読み込み中...')
    const mjsUrl = new URL('pyodide.mjs', baseUrl).href
    const { loadPyodide } = await import(/* @vite-ignore */ mjsUrl)

    pyodideInstance = await loadPyodide({
      indexURL: baseUrl,
    })

    postStatus('mounting_fs', 0.2, '仮想ストレージ (IndexedDB) を初期化中...')
    const FS = pyodideInstance.FS
    try {
      FS.mkdir('/workspace')
    } catch {
      /* ignore if exists */
    }

    if (FS.filesystems?.IDBFS) {
      try {
        FS.mount(FS.filesystems.IDBFS, {}, '/workspace')
        await new Promise<void>((resolve) => {
          FS.syncfs(true, () => resolve())
        })
      } catch (err) {
        console.warn('IDBFS mount warning, falling back to MEMFS:', err)
      }
    }

    postStatus('loading_packages', 0.3, '分析ライブラリ (NumPy, SciPy, Polars, scikit-learn, PyArrow) を読み込み中...')
    // Load native packages from local pyodide-lock.json
    await pyodideInstance.loadPackage([
      'numpy',
      'scipy',
      'scikit-learn',
      'polars',
      'pyarrow',
      'pydantic',
      'anyio',
      'sqlite3',
      'idna',
    ])

    postStatus('loading_pure_wheels', 0.65, 'APIフレームワーク (FastAPI, HTTPX, multipart) を展開中...')
    // Unpack pure-python wheels into site-packages from local wheels/ directory
    const wheelsListRes = await fetch(new URL('wheels/manifest.json', baseUrl).href)
    if (wheelsListRes.ok) {
      const wheelNames: string[] = await wheelsListRes.json()
      for (const whl of wheelNames) {
        console.log(`Unpacking wheel: ${whl}`)
        const whlRes = await fetch(new URL(`wheels/${whl}`, baseUrl).href)
        if (whlRes.ok) {
          const buf = await whlRes.arrayBuffer()
          pyodideInstance.unpackArchive(buf, 'zip', { extractDir: '/lib/python3.12/site-packages' })
        } else {
          console.error(`Failed to fetch wheel ${whl}: ${whlRes.status}`)
        }
      }
    }

    postStatus('loading_backend', 0.85, 'DAVIS-PCP バックエンドコードを展開中...')
    const appZipRes = await fetch(new URL('backend_app.zip', baseUrl).href)
    if (!appZipRes.ok) {
      throw new Error(`Failed to fetch backend_app.zip: ${appZipRes.status}`)
    }
    const appZipBuf = await appZipRes.arrayBuffer()
    pyodideInstance.unpackArchive(appZipBuf, 'zip', { extractDir: '/app' })

    postStatus('starting_app', 0.95, 'FastAPI アプリケーションを起動中...')
    // Execute Python initialization script
    pyodideInstance.runPython(`
import sys
import os
import io
import json
import asyncio

if '/lib/python3.12/site-packages' not in sys.path:
    sys.path.insert(0, '/lib/python3.12/site-packages')

if '/app' not in sys.path:
    sys.path.insert(0, '/app')

os.environ["DAVIS_PCP_WORKSPACE"] = "/workspace"
os.environ["DAVIS_PCP_WASM"] = "1"

# In single-threaded WASM, bypass thread creation for sync endpoints
import starlette.concurrency
import anyio.to_thread

async def _fake_run_in_threadpool(func, *args, **kwargs):
    return func(*args, **kwargs)

starlette.concurrency.run_in_threadpool = _fake_run_in_threadpool

async def _fake_run_sync(func, *args, **kwargs):
    return func(*args, **kwargs)

anyio.to_thread.run_sync = _fake_run_sync

from app.main import app
from app.config import settings

settings.workspace_dir.mkdir(parents=True, exist_ok=True)
settings.ensure_dirs()

import httpx

# In-memory ASGI client
asgi_client = httpx.AsyncClient(
    transport=httpx.ASGITransport(app=app),
    base_url="http://testserver",
    timeout=httpx.Timeout(120.0, connect=10.0)
)

async def _dispatch_asgi(method, path, headers_json, body_bytes, upload_meta_json, upload_bytes):
    url = f"/api/v1{path}"
    headers = json.loads(headers_json) if headers_json else {}
    
    if upload_meta_json and upload_bytes is not None:
        upload_meta = json.loads(upload_meta_json)
        filename = upload_meta.get("filename", "upload.csv")
        extra = upload_meta.get("extra") or {}
        # Convert memoryview/bytes to io.BytesIO
        raw_io = io.BytesIO(bytes(upload_bytes))
        files = {"file": (filename, raw_io)}
        data = extra
        response = await asgi_client.request(method, url, headers=headers, files=files, data=data)
    else:
        content = bytes(body_bytes) if body_bytes is not None else None
        response = await asgi_client.request(method, url, headers=headers, content=content)
        
    content_type = response.headers.get("content-type", "")
    is_binary = (
        "application/vnd.apache.arrow" in content_type
        or "application/vnd.apache.parquet" in content_type
        or "parquet" in content_type
        or "octet-stream" in content_type
        or not (
            "text/" in content_type
            or "application/json" in content_type
            or "application/xml" in content_type
        )
    )
    
    return {
        "status_code": response.status_code,
        "headers": dict(response.headers),
        "content": response.content,  # bytes
        "is_binary": is_binary,
        "is_arrow": is_binary,
        "text": response.text if not is_binary else None,
    }
`)

    pyDispatchFn = pyodideInstance.globals.get('_dispatch_asgi')
    postStatus('ready', 1.0, 'DAVIS-PCP WASM 環境の準備が完了しました')
  } catch (err: any) {
    console.error('Pyodide initialization error:', err)
    self.postMessage({
      type: 'STATUS',
      stage: 'error',
      progress: 0,
      message: `初期化エラー: ${err?.message || String(err)}`,
    })
  }
}

async function handleApiRequest(msg: WorkerApiRequest) {
  const { id, method, path, headers, body, filePayload } = msg
  if (!pyDispatchFn) {
    self.postMessage({
      type: 'RESPONSE',
      id,
      status: 503,
      headers: {},
      error: { code: 'WASM_NOT_READY', message: 'Pyodide ランタイムが初期化されていません。' },
    })
    return
  }

  try {
    const headersJson = headers ? JSON.stringify(headers) : '{}'
    let bodyBytes: Uint8Array | null = null
    if (body) {
      if (typeof body === 'string') {
        bodyBytes = new TextEncoder().encode(body)
      } else if (body instanceof ArrayBuffer) {
        bodyBytes = new Uint8Array(body)
      } else if (body instanceof Uint8Array) {
        bodyBytes = body
      }
    }

    let uploadMetaJson: string | null = null
    let uploadBytes: Uint8Array | null = null
    if (filePayload) {
      uploadMetaJson = JSON.stringify({
        filename: filePayload.filename,
        extra: filePayload.extra || {},
      })
      uploadBytes = new Uint8Array(filePayload.data)
    }

    const pyResult = await pyDispatchFn(
      method,
      path,
      headersJson,
      bodyBytes,
      uploadMetaJson,
      uploadBytes,
    )

    const statusCode: number = pyResult.get('status_code')
    const resHeadersPy: any = pyResult.get('headers')
    const resHeaders: Record<string, string> = resHeadersPy.toJs({ dict_converter: Object.fromEntries })
    const isBinary: boolean = Boolean(pyResult.get('is_binary') ?? pyResult.get('is_arrow'))
    const rawContentPy: any = pyResult.get('content')
    const rawBytes: Uint8Array = rawContentPy.toJs()
    const text: string | null = pyResult.get('text')

    pyResult.destroy()
    if (resHeadersPy?.destroy) resHeadersPy.destroy()
    if (rawContentPy?.destroy) rawContentPy.destroy()

    // Sync filesystem if mutative operation
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      try {
        const FS = pyodideInstance.FS
        if (FS.filesystems?.IDBFS) {
          FS.syncfs(false, () => {})
        }
      } catch {
        /* ignore */
      }
    }

    let data: any = null
    let transfer: Transferable[] = []
    if (isBinary) {
      const independentBuf = rawBytes.slice().buffer
      data = independentBuf
      transfer = [independentBuf]
    } else if (text !== null) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }

    self.postMessage(
      {
        type: 'RESPONSE',
        id,
        status: statusCode,
        headers: resHeaders,
        data,
      },
      transfer as any,
    )
  } catch (err: any) {
    console.error(`API request error [${method} ${path}]:`, err)
    self.postMessage({
      type: 'RESPONSE',
      id,
      status: 500,
      headers: {},
      error: { code: 'WASM_DISPATCH_ERROR', message: err?.message || String(err) },
    })
  }
}

self.onmessage = async (e: MessageEvent<WorkerIncomingMessage>) => {
  const msg = e.data
  if (msg.type === 'INIT') {
    await initPyodide(msg.pyodideBaseUrl)
  } else if (msg.type === 'REQUEST') {
    await handleApiRequest(msg)
  }
}
