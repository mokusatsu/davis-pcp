function B(){let t=Promise.resolve();return function(e){const l=t.then(e);return t=l.catch(()=>{}),l}}let c=null,S=null;function p(t,s,e){self.postMessage({type:"STATUS",stage:t,progress:s,message:e})}async function E(t){var s;try{p("loading_runtime",.1,"Python WASM ランタイムを読み込み中...");const e=new URL("pyodide.mjs",t).href,{loadPyodide:l}=await import(e);c=await l({indexURL:t}),p("mounting_fs",.2,"仮想ストレージ (IndexedDB) を初期化中...");const o=c.FS;try{o.mkdir("/workspace")}catch{}if((s=o.filesystems)!=null&&s.IDBFS)try{o.mount(o.filesystems.IDBFS,{},"/workspace"),await new Promise(a=>{o.syncfs(!0,()=>a())})}catch(a){console.warn("IDBFS mount warning, falling back to MEMFS:",a)}p("loading_packages",.3,"分析ライブラリ (NumPy, SciPy, Polars, scikit-learn, PyArrow) を読み込み中..."),await c.loadPackage(["numpy","scipy","scikit-learn","polars","pyarrow","pydantic","anyio","sqlite3","idna"]),p("loading_pure_wheels",.65,"APIフレームワーク (FastAPI, HTTPX, multipart) を展開中...");const n=await fetch(new URL("wheels/manifest.json",t).href);if(n.ok){const a=await n.json();for(const r of a){console.log(`Unpacking wheel: ${r}`);const y=await fetch(new URL(`wheels/${r}`,t).href);if(y.ok){const g=await y.arrayBuffer();c.unpackArchive(g,"zip",{extractDir:"/lib/python3.12/site-packages"})}else console.error(`Failed to fetch wheel ${r}: ${y.status}`)}}p("loading_backend",.85,"DAVIS-PCP バックエンドコードを展開中...");const i=await fetch(new URL("backend_app.zip",t).href);if(!i.ok)throw new Error(`Failed to fetch backend_app.zip: ${i.status}`);const h=await i.arrayBuffer();c.unpackArchive(h,"zip",{extractDir:"/app"}),p("starting_app",.95,"FastAPI アプリケーションを起動中..."),c.runPython(`
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
`),S=c.globals.get("_dispatch_asgi"),p("ready",1,"DAVIS-PCP WASM 環境の準備が完了しました")}catch(e){console.error("Pyodide initialization error:",e),self.postMessage({type:"STATUS",stage:"error",progress:0,message:`初期化エラー: ${(e==null?void 0:e.message)||String(e)}`})}}async function j(t){var h;const{id:s,method:e,path:l,headers:o,body:n,filePayload:i}=t;if(!S){self.postMessage({type:"RESPONSE",id:s,status:503,headers:{},error:{code:"WASM_NOT_READY",message:"Pyodide ランタイムが初期化されていません。"}});return}try{const a=o?JSON.stringify(o):"{}";let r=null;n&&(typeof n=="string"?r=new TextEncoder().encode(n):n instanceof ArrayBuffer?r=new Uint8Array(n):n instanceof Uint8Array&&(r=n));let y=null,g=null;i&&(y=JSON.stringify({filename:i.filename,extra:i.extra||{}}),g=new Uint8Array(i.data));const d=await S(e,l,a,r,y,g),A=d.get("status_code"),f=d.get("headers"),b=f.toJs({dict_converter:Object.fromEntries}),I=!!(d.get("is_binary")??d.get("is_arrow")),u=d.get("content"),x=u.toJs(),w=d.get("text");if(d.destroy(),f!=null&&f.destroy&&f.destroy(),u!=null&&u.destroy&&u.destroy(),["POST","PUT","PATCH","DELETE"].includes(e)){const _=c.FS;(h=_.filesystems)!=null&&h.IDBFS&&await new Promise((R,T)=>{_.syncfs(!1,k=>k?T(k):R())})}let m=null,P=[];if(I){const _=x.slice().buffer;m=_,P=[_]}else if(w!==null)try{m=JSON.parse(w)}catch{m=w}self.postMessage({type:"RESPONSE",id:s,status:A,headers:b,data:m},P)}catch(a){console.error(`API request error [${e} ${l}]:`,a),self.postMessage({type:"RESPONSE",id:s,status:500,headers:{},error:{code:"WASM_DISPATCH_ERROR",message:(a==null?void 0:a.message)||String(a)}})}}const v=B();self.onmessage=t=>{const s=t.data;v(async()=>{s.type==="INIT"?await E(s.pyodideBaseUrl):s.type==="REQUEST"&&await j(s)}).catch(e=>p("error",0,(e==null?void 0:e.message)||String(e)))};
