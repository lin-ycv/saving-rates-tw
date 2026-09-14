
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
