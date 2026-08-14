
台灣數位帳戶比較網站
架構：瀏覽器端動態載入 data.json

啟動方式
1. 解壓縮 ZIP。
2. 在資料夾內啟動本機 HTTP 伺服器，例如：
   python -m http.server 8000
3. 開啟：
   http://localhost:8000/index.html

單一資料來源
- data.json 是所有頁面的唯一銀行資料來源。
- index.html 由 assets/index.js 載入 data.json，建立排行及完整比較表。
- bank.html 是所有銀行共用的模板。
- 銀行頁網址格式：
  bank.html?bank=hncb-sny
  bank.html?bank=obank
- assets/bank.js 會依 bank 查詢參數，從 data.json 選出銀行並建立完整頁面、條列內容及 SVG 利率圖。
- missing-data-audit.html 由 assets/audit.js 載入 data.json 內的 missing_data 陣列。
- HTML 檔案不再嵌入銀行或缺漏資料。

主要檔案
- index.html：首頁外殼
- bank.html：共用銀行頁外殼
- missing-data-audit.html：獨立缺漏頁外殼
- data.json：唯一資料來源
- assets/common.js：載入資料與共用格式函式
- assets/index.js：首頁渲染、排序及篩選
- assets/bank.js：個別銀行頁及利率圖渲染
- assets/audit.js：缺漏頁渲染
- assets/style.css：全站樣式

注意
- 本版需要透過 HTTP 伺服器使用，不能依賴直接開啟 file://。
- missing-data-audit.html 沒有從其他 HTML 頁面連入。


2026-08-14 v25 月度資料更新
- 以本 ZIP 既有網站與 allocator 程式碼為基礎，僅合併 v25 資料／內容更新。
- 王道 O-Bank：8/10起階梯活儲2.1%第一級距由20萬元擴至50萬元。
- NEXT Bank：8/12～10/5存款專案B與薪轉戶A的2%級距限時擴至100萬元；專案A修正為5萬～120萬元1.435%。
- 樂天銀行：移除7/31到期的2.8%活存，改列8/1～10/31可確認的1.5%無上限任務方案；15%十天期優存不列入活存排行。
- 高雄銀行：依8/12牌告更新雄Hoyaa為0.70000%。
- 缺漏稽核移除已過期的「樂天新戶2.8%完整活動辦法」項目，保留仍需追蹤的現行欄位。
