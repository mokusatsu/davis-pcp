# Feature 031 FAMD 実装レビュー 006

判定: **配信証拠を追加受領。ただし現在の共有登録欠落とrank1確認が残るため保留。**

- 日付: 2026-09-13
- 対象: `REPLY-003d.md`、SHA256 `9BF1FBBBCD1316B6432F541CA4F0F6979A7D19A32ACF7058EDAEB3041DA6921F`
- HEAD: `9cfcea003b132df3ac4b0876af44aed6b5caae20`。現在の作業ツリーを対象。

ビルドログの8.83秒成功と、dist/index.htmlがindex-B-lrO7Mo.jsを参照することを確認した。uvicornによるSPA配信・openapi掲載は報告として受領する。static zipの手動更新と通常配信経路は区別し、Pyodide実ブラウザ検証は要求しない。

一方、現在の `backend/app/main.py` にはfamd routerのimport/includeがなく、frontendのmain.tsx・KeepAliveOutlet.tsx・AppShell.tsxにもFAMD登録が見当たらない。報告時の稼働プロセスと現在のソースが一致しているとはいえず、再起動・再生成後の利用を保証できない。原因や変更者は未特定。

**F008 [P1] 共有登録の欠落**として追加する。Feature 032 REVIEW-001のL001と同じ共有統合の問題であり、重複した別修正を求めるものではない。MCA等を保持した上でFAMD/LRの登録を復元・統合し、現在の版で起動・API/画面到達を確認する必要がある。

確認したmain.py SHA256: `A2C4F69B12B91A975C049E23B2362FEFE25CE678E855F398681F752EAF0E888D`、frontend/src/main.tsx: `E2F9834E015C9E516E14790167378617622611DE506BD7099D38C3D46F68A1B9`。

F001〜F007の解消は維持。rank1画面の操作証拠も引き続き未提出。新たなビルドや実装修正はレビューでは行っていない。現時点で「問題なし」は宣言できない。
