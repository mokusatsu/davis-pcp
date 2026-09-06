# SECURITY_REPORT — DAVIS-PCP Fullstack v2.0.0

## 実装と検証

| 項目 | 実装 | 検証 |
|---|---|---|
| bind既定 127.0.0.1 | uvicorn起動引数・README/run scripts | 起動確認 |
| CORS localhost限定 | main.py CORSMiddleware (5173/8420 origins) | コード審査 |
| upload size上限 | config.max_upload_bytes(既定256MB)、ストリーミング累計チェック | tests/api TestSecurity |
| row/column上限 | max_rows/max_columns、import時enforce | enforce_limits |
| content-based format検証 | magic byte + content sniff(拡張子非依存) | tests/unit TestFormatDetection |
| CSV formula injection中和 | export時に `=+-@\t\r` 先頭へ `'` 付与 | tests/api test_csv_neutralizes_formula_injection |
| SQLite危険機能無効化 | enable_load_extension=OFF、メモリdeserializeのみ | import_service.load_sqlite_table |
| stack trace非表示 | 統一error contractハンドラ(BizError/Exception) | tests/api test_no_stack_trace_in_errors |
| secret埋め込みなし | frontendにcredentialなし | コード審査 |
| 外部通信なし | 外部CDN/telemetry無し、Vite proxyはlocalhostのみ | ネットワーク監視(E2E) |
| path traversal | workspace配下固定パス + filename sanitization(exports Content-Disposition) | コード審査 |

## 未実施

- zip bomb対策(release ZIPは自前生成のみで、ユーザーuploadのZIPは扱わないため対象外)
- 多要素認証(ローカル単一ユーザー前提のため対象外)
