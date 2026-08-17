# HICAS CXM MCP

MCP server chuẩn Streamable HTTP, chuyển tiếp 187 endpoint `GET`, 348 endpoint
`POST` và 1 endpoint `PUT` qua duy nhất `/mcp`. Mục tiêu chính là để
agent tra cứu, đối chiếu và thực hiện thao tác CXM có kiểm soát.
liệu phục vụ QC: dự án, hợp đồng, PO, kho, giao dịch kho, giá bình quân, kỳ tài
chính và trạng thái workflow.

OpenAPI nguồn:

- UAT: `https://cxm.erp-uat.hicas.vn/swagger/v1/swagger.json`.
- SIT: `https://api.hawee.hicas.vn/swagger/v1/swagger.json`.

## Phạm vi 536 tool

| Method | Swagger | Quản trị bị loại | MCP |
|---|---:|---:|---:|
| GET | 227 | 40 | 187 |
| POST | 394 | 46 | 348 |
| PUT | 78 | 77 | 1 |
| **Tổng** | **699** | **163** | **536** |

Trong đó 5 tool là endpoint quản trị được mở có chủ đích để phục vụ test phân
quyền (xem [Endpoint quản trị được mở](#endpoint-quản-trị-được-mở)); 531 tool
còn lại là nghiệp vụ.

GET MCP giữ 50 tag; POST/PUT MCP giữ 54 tag. Các tag quản trị bị loại: `AbpApiDefinition`,
`AbpApplicationConfiguration`, `AbpApplicationLocalization`, `Permissions`,
`Features`, `Login`, `Profile`, `Tenant`, `AbpTenant`, `User`, `CxmUser`,
`UserLookup`, `Role`, `OrganizationUnit`, `TimeZoneSettings`, `EmailSettings`,
`EmailTemplate`, `ExternalApiLog`, `Banner`, `Account` và `DynamicClaims`.
Endpoint có path quản trị
`/api/app/purchase-order/admin/sync-progress/{eventId}` cũng bị loại.

Danh sách GET nằm tại [`config/tools.json`](config/tools.json); danh sách POST
nằm tại [`config/write-tools.json`](config/write-tools.json). Service không đọc Swagger khi khởi
động, vì vậy thay đổi ngoài ý muốn trên OpenAPI sẽ không tự động mở rộng phạm vi
MCP.

SIT có snapshot độc lập tại `config/sit/tools.json` và
`config/sit/write-tools.json`. Hai snapshot có thể khác nhau khi SIT và UAT đang
chạy các phiên bản API khác nhau.

### Endpoint quản trị được mở

Tag quản trị vẫn bị loại theo mặc định. Riêng 5 endpoint dưới đây được mở lẻ qua
`includedEndpoints` trong `config/selected-groups.json`, để agent có thể đọc và
ghi lại tập quyền của một role khi test phân quyền:

| Method | Endpoint | Safety | Dùng để |
|---|---|---|---|
| GET | `/api/permission-management/permissions` | read-only | Đọc cây quyền của role hoặc user |
| PUT | `/api/permission-management/permissions` | destructive | Ghi đè toàn bộ tập quyền của role |
| GET | `/api/identity/roles/all` | read-only | Liệt kê role |
| GET | `/api/identity/users/by-username/{userName}` | read-only | Tra user theo username |
| GET | `/api/identity/users/{id}/roles` | read-only | Đọc role của một user |

`includedEndpoints` khớp theo đúng cặp `METHOD + path`, nên mở
`GET /api/identity/users/{id}/roles` không kéo theo `PUT` cùng path — API đổi
role của user vẫn nằm ngoài MCP.

`PUT` là opt-in tuyệt đối: endpoint `PUT` chỉ được sinh khi có tên trong
`includedEndpoints`, không bao giờ theo tag. Swagger UAT có 78 `PUT`, MCP mở
đúng 1.

`PUT /api/permission-management/permissions` **ghi đè** tập quyền chứ không
merge: quyền không có trong payload sẽ bị tắt. Tool này gắn safety
`destructive`, cần cả `confirmWrite=true` lẫn `confirmDestructive=true`. Hãy sao
lưu cây quyền bằng `GET` trước khi ghi.

## Chạy local

Yêu cầu Node.js 20 trở lên.

```powershell
Copy-Item .env.example .env
npm install
npm run check
npm run dev
```

Điền vào `.env`:

- `CXM_ACCESS_TOKEN`: cách nhanh, nhưng access token sẽ hết hạn.
- `CXM_REFRESH_TOKEN`: cách nên dùng; MCP tự lấy access token mới. Khi đăng nhập
  trên trang MCP, refresh token cũng được lưu vào `CXM_REFRESH_TOKEN_FILE` để
  service restart không làm mất phiên.
- `MCP_KEY`: khóa cố định bảo vệ endpoint MCP. Đây không phải CXM token.

Các endpoint local:

```text
MCP:    http://127.0.0.1:9000/mcp
Health: http://127.0.0.1:9000/healthz
Info:   http://127.0.0.1:9000/
```

Nếu cần truy cập từ máy khác trong LAN hoặc qua reverse proxy, đặt `HOST=0.0.0.0`
và thêm IP/domain thực tế vào `MCP_ALLOWED_HOSTS`. Ví dụ cho máy chủ hiện tại:

```env
HOST=0.0.0.0
MCP_ALLOWED_HOSTS=localhost,127.0.0.1,10.0.10.62,mcp-erp.lm.io.vn
```

Sau đó có thể kiểm tra từ máy khác bằng
`http://10.0.10.62:9000/healthz`. Nếu kết nối bị timeout dù health check local
thành công, cần cho phép inbound TCP 9000 trong Windows Firewall.

Agent có thể kết nối trực tiếp bằng query key:

```text
http://127.0.0.1:9000/mcp?MCP_KEY=<YOUR_KEY>
```

`/mcp` là endpoint giao thức, không phải giao diện liệt kê tool. Mở URL này
bằng trình duyệt sẽ chuyển tới trang đăng nhập CXM; MCP client mới thực hiện
`initialize`, `tools/list` và `tools/call` trên chính URL đó.

Agent chỉ cần cài URL này thành một MCP server. Với Agent_bot/Gemini Live,
không nên bật đồng thời toàn bộ 348 POST; hãy block các nhóm không dùng và
chỉ bật nhóm POST cần cho phiên hiện tại để tránh vượt giới hạn function của model.

Input POST JSON dùng trường `body`. Multipart dùng `form` và `files`, trong đó
file được truyền bằng `dataBase64`. Ví dụ xác nhận một POST thường:

```json
{
  "body": { "name": "Tên dữ liệu" },
  "confirmWrite": true
}
```

POST được đánh dấu destructive cần thêm:

```json
{
  "confirmWrite": true,
  "confirmDestructive": true
}
```

Hoặc gửi Bearer header nếu agent hỗ trợ:

```http
Authorization: Bearer <MCP_KEY>
```

MCP server dùng token CXM phía server để gọi API nguồn. Token này không được
trả về cho agent và không được ghi log.

## Docker

### Docker Compose (khuyên dùng)

Tạo `.env` và điền ít nhất `MCP_KEY` cùng public hostname của Cloudflare:

```env
HOST=0.0.0.0
PORT=9000
MCP_KEY=<YOUR_STRONG_KEY>
MCP_ALLOWED_HOSTS=mcp-erp.lm.io.vn,mcp-erp-sit.lm.io.vn,localhost,127.0.0.1
```

Khởi chạy hoặc cập nhật service:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f mcp
```

Compose chạy hai MCP độc lập từ cùng một image:

| Service | Host port | API nguồn | Tool allowlist | Token volume |
|---|---:|---|---|---|
| `mcp` (UAT) | `9000` | `https://cxm.erp-uat.hicas.vn` | `config/tools.json`, `config/write-tools.json` | `cxm-auth-data` |
| `mcp-sit` | `9001` | `https://api.hawee.hicas.vn` | `config/sit/tools.json`, `config/sit/write-tools.json` | `cxm-auth-data-sit` |

Hai instance cũng công bố danh tính MCP khác nhau (`hicas-cxm-uat` và
`hicas-cxm-sit`). Điều này tránh việc MCP client gộp hoặc thay thế hai kết nối
do cùng server name và cùng tên tool. Trang đăng nhập, `/`, `/healthz` và
`/auth/status` đều hiển thị instance cùng upstream tương ứng để phát hiện route
nhầm port mà không lộ token.

Service UAT vẫn giữ tên `mcp`, container `hicas-cxm-mcp`, volume và host port
hiện tại. Vì vậy route public hiện có tới port `9000` vẫn là UAT. SIT map
`9001:9000`: ứng dụng trong container vẫn nghe port `9000`, còn máy chủ mở thêm
port `9001`.

Hai service cùng đọc `.env`, vì vậy dùng chung `MCP_KEY` và các giới hạn vận
hành. `MCP_ALLOWED_HOSTS` phải chứa cả hai hostname public:

```env
MCP_ALLOWED_HOSTS=localhost,127.0.0.1,10.0.10.62,mcp-erp.lm.io.vn,mcp-erp-sit.lm.io.vn
```

Route `mcp-erp.lm.io.vn` tới `http://127.0.0.1:9000` và route
`mcp-erp-sit.lm.io.vn` tới `http://127.0.0.1:9001`. Dù dùng chung `.env`, Compose
ghi đè `CXM_BASE_URL`, tool allowlist và `CXM_REFRESH_TOKEN_FILE` cho từng
container. Hai named volume khác nhau nên đăng nhập tại UAT và SIT tạo hai phiên
CXM độc lập, không ghi đè refresh token của nhau. Container SIT cũng chủ động
bỏ qua `CXM_ACCESS_TOKEN`/`CXM_REFRESH_TOKEN` có thể đang dùng cho UAT trong
`.env`; SIT chỉ khôi phục phiên từ volume `cxm-auth-data-sit`.

Sau khi khởi động, kiểm tra riêng từng service bằng:

```text
UAT MCP:    http://127.0.0.1:9000/mcp?MCP_KEY=<MCP_KEY>
UAT Health: http://127.0.0.1:9000/healthz
SIT MCP:    http://127.0.0.1:9001/mcp?MCP_KEY=<MCP_KEY>
SIT Health: http://127.0.0.1:9001/healthz
```

Compose publish UAT tại cổng `9000` và SIT tại cổng `9001` trên mọi interface
của host để máy trong LAN và reverse proxy/tunnel trên host đều truy cập được.
`MCP_ALLOWED_HOSTS` vẫn giới hạn các IP/domain được ứng dụng chấp nhận. Named
volume `cxm-auth-data` và `cxm-auth-data-sit` giữ riêng refresh token qua các lần
rebuild/recreate container.

Nếu `cloudflared` chạy trong một container khác, hãy nối hai service vào cùng
Docker network và dùng `http://hicas-cxm-mcp:9000` thay cho `127.0.0.1`.

### Docker CLI

```powershell
docker build -t hicas-cxm-mcp .
docker run --rm -p 9000:9000 --env-file .env `
  -e HOST=0.0.0.0 `
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1,10.0.10.62,mcp-erp.lm.io.vn `
  hicas-cxm-mcp
```

Khi publish qua domain, thêm hostname thật vào `MCP_ALLOWED_HOSTS`, đặt
`MCP_KEY` mạnh và terminate HTTPS ở reverse proxy. Không publish service
ra Internet khi chưa bật cả HTTPS lẫn xác thực.

```env
HOST=0.0.0.0
PORT=9000
MCP_ALLOWED_HOSTS=<YOUR_MCP_DOMAIN>
MCP_KEY=<YOUR_KEY>
```

Ví dụ, nếu domain Zero Trust của deployment là `mcp-project-a.hicas.vn`:

```text
MCP_ALLOWED_HOSTS=mcp-project-a.hicas.vn
https://mcp-project-a.hicas.vn/mcp?MCP_KEY=<YOUR_KEY>
```

Nếu cùng một instance được truy cập bằng nhiều domain, liệt kê các hostname
phân tách bằng dấu phẩy, không kèm `https://`, path hoặc port:

```env
MCP_ALLOWED_HOSTS=mcp-project-a.hicas.vn,mcp-project-b.hicas.vn
```

Allowlist được so với header HTTP `Host` thực sự tới service. Nên cấu hình
Zero Trust/tunnel giữ nguyên public hostname. Nếu proxy chủ động rewrite
`Host`, hãy thêm đúng hostname sau rewrite vào allowlist.

Query string có thể xuất hiện trong access log, browser history và dashboard
của reverse proxy/Zero Trust. Cần cấu hình hệ thống phía trước để redact tham số
`MCP_KEY`. Khi agent hỗ trợ custom header, Bearer header vẫn là phương thức nên
ưu tiên. Nếu Zero Trust yêu cầu service token riêng, client còn phải gửi các
header do nền tảng Zero Trust quy định; `MCP_KEY` chỉ là lớp xác thực của MCP
service này.

## Cơ chế an toàn

- Chỉ path và method trong `config/tools.json` hoặc `config/write-tools.json`
  mới được gọi; agent không thể
  cung cấp URL tùy ý.
- `/mcp` chứa GET/POST nghiệp vụ cộng đúng 5 endpoint quản trị được liệt kê ở
  [Endpoint quản trị được mở](#endpoint-quản-trị-được-mở); không có API quản trị
  nào khác.
- Mọi POST và PUT bắt buộc `confirmWrite: true`; 74 tool bulk/import/sync/cancel/
  reject/reset/delete/ghi-đè-quyền còn bắt buộc `confirmDestructive: true`.
- JSON body tối đa 1 MiB; tổng file upload mặc định tối đa 10 MiB; tối đa 10 file.
- `MaxResultCount` mặc định là 25 và bị giới hạn tối đa 100.
- Timeout mặc định 30 giây; phản hồi tối đa 512 KiB.
- Host/Origin validation giúp chống DNS rebinding.
- Có thể khóa `/mcp` bằng `MCP_KEY`; service chấp nhận query parameter hoặc
  Bearer header và dùng phép so sánh constant-time.
- `workflow-definition-sync` có tên cho thấy khả năng gây đồng bộ phía server.
  Tool này không được đánh dấu read-only và bắt buộc truyền
  `confirmRiskyCall: true`.
- Nhóm `Party` chứa dữ liệu liên hệ và tài khoản ngân hàng. Quyền của CXM token
  phải tuân theo nguyên tắc tối thiểu cần thiết.

## Token CXM

### Đăng nhập trực tiếp trên trang MCP (khuyên dùng)

Mở URL MCP bằng trình duyệt:

```text
https://<MCP_DOMAIN>/mcp?MCP_KEY=<YOUR_KEY>
```

Request trình duyệt sẽ được chuyển tới `/auth/login`. Nhập tài khoản và mật khẩu
CXM tại đây, chọn duy trì đăng nhập rồi bấm **Đăng nhập CXM**. MCP gửi thông tin
đăng nhập qua HTTPS tới `/connect/token`, chỉ giữ access token trong bộ nhớ và
không lưu mật khẩu. Nếu chọn duy trì đăng nhập, chỉ refresh token được lưu trong
`CXM_REFRESH_TOKEN_FILE`; đây là credential nhạy cảm của tài khoản. Sau khi thành công, agent dùng duy nhất
`/mcp?MCP_KEY=...` cho toàn bộ 187 GET, 348 POST và 1 PUT.

MCP client không phải trình duyệt nên không thể tự hiển thị form HTML. Vì vậy,
mỗi lần service restart mà chưa có refresh token đã lưu, hãy mở URL trên bằng
trình duyệt để đăng nhập một lần; các agent dùng chung instance sẽ dùng phiên CXM đó.

Để luôn bắt đăng nhập lại sau mỗi lần restart và bỏ qua token có sẵn trong biến
môi trường, cấu hình:

```env
CXM_INTERACTIVE_LOGIN=true
```

Để dùng phiên đã lưu sau khi restart, giữ `CXM_INTERACTIVE_LOGIN=false` và trỏ
`CXM_REFRESH_TOKEN_FILE` tới một file/volume bền vững (mẫu local dùng
`./data/cxm-refresh-token`).

Các endpoint quản lý:

```text
GET  /auth/login?MCP_KEY=<YOUR_KEY>
GET  /auth/status?MCP_KEY=<YOUR_KEY>
POST /auth/logout?MCP_KEY=<YOUR_KEY>
```

### Lấy token thủ công (phương án dự phòng)

Trang `https://uat-erp.hawee.hicas.vn` lưu trạng thái đăng nhập trong
`localStorage`, khóa `persist:root`; token nằm tại `app.auth`. Sau khi đăng nhập
ERP, mở DevTools (`F12`) tại đúng trang ERP, vào tab **Console** và chạy:

```js
copy(JSON.parse(JSON.parse(localStorage.getItem("persist:root")).app).auth.refresh_token)
```

Lệnh này chép refresh token vào clipboard mà không in token ra màn hình. Điền
giá trị vừa chép vào `.env` và không gửi token qua chat:

```env
CXM_REFRESH_TOKEN=<PASTE_REFRESH_TOKEN_HERE>
CXM_OAUTH_CLIENT_ID=CxmApi_App
CXM_OAUTH_SCOPE=offline_access CxmApi
```

Sau đó restart MCP. Server sẽ gọi `POST /connect/token`, giữ access token trong
bộ nhớ, tự refresh trước khi hết hạn và thử refresh lại một lần nếu CXM trả
`401`. MCP không lưu tên đăng nhập hoặc mật khẩu.

Nếu muốn thiết lập nhanh chỉ bằng access token, dùng lệnh sau và điền kết quả
vào `CXM_ACCESS_TOKEN`; cách này phải làm lại khi token hết hạn:

```js
copy(JSON.parse(JSON.parse(localStorage.getItem("persist:root")).app).auth.access_token)
```

Với deployment lâu dài, `CXM_REFRESH_TOKEN_FILE` phải nằm trên file/volume có
quyền ghi để server cập nhật refresh token mới khi CXM xoay token. Refresh token
nhạy cảm hơn access token; chỉ lưu trong secret store hoặc file giới hạn quyền.

## Cập nhật allowlist khi Swagger thay đổi

Chỉ chạy thao tác này khi chủ động review API mới:

```powershell
npm run generate:tools:uat
npm run generate:tools:sit
npm run check
```

Generator UAT đọc quy tắc loại trừ trong `config/selected-groups.json`; generator
SIT đọc `config/sit/selected-groups.json`. Mỗi profile ghi ra snapshot GET/POST
riêng và sẽ thất bại nếu số endpoint nguồn hoặc số tool không khớp giá trị kỳ
vọng của profile. Khi một môi trường thay đổi API hợp lệ, hãy review Swagger và
cập nhật các giá trị `expected*` của đúng profile trước khi generate lại. Đây là
chốt an toàn buộc người vận hành xem xét thay đổi upstream và danh sách API quản
trị trước khi cập nhật file allowlist.

## Kiểm thử

```powershell
npm run check
```

Bộ test kiểm tra:

- đúng 187 GET, 348 POST và 1 PUT;
- chỉ đúng 5 endpoint quản trị được mở, và `PUT /api/identity/users/{id}/roles`
  không bao giờ lọt vào allowlist;
- không trùng tool/path/method;
- chuyển đổi path/query parameter đúng OpenAPI;
- giới hạn phân trang;
- kết nối end-to-end duy nhất `/mcp`, `tools/list` và `tools/call` cho cả GET/POST;
- bearer token CXM được chuyển tiếp đúng tới API nguồn.
