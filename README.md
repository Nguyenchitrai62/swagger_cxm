# HICAS CXM MCP

MCP server chuẩn Streamable HTTP, chuyển tiếp 183 endpoint `GET` và 347 endpoint
`POST` nghiệp vụ qua duy nhất `/mcp`. Mục tiêu chính là để
agent tra cứu, đối chiếu và thực hiện thao tác CXM có kiểm soát.
liệu phục vụ QC: dự án, hợp đồng, PO, kho, giao dịch kho, giá bình quân, kỳ tài
chính và trạng thái workflow.

OpenAPI nguồn:
`https://cxm.erp-uat.hicas.vn/swagger/v1/swagger.json`.

## Phạm vi 530 tool

| Method | Swagger | Quản trị bị loại | MCP nghiệp vụ |
|---|---:|---:|---:|
| GET | 227 | 44 | 183 |
| POST | 393 | 46 | 347 |
| **Tổng** | **620** | **90** | **530** |

GET MCP giữ 47 tag nghiệp vụ; POST MCP giữ 53 tag nghiệp vụ. Các tag quản trị bị loại: `AbpApiDefinition`,
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
MCP:    http://127.0.0.1:8000/mcp
Health: http://127.0.0.1:8000/healthz
Info:   http://127.0.0.1:8000/
```

Agent có thể kết nối trực tiếp bằng query key:

```text
http://127.0.0.1:8000/mcp?MCP_KEY=<YOUR_KEY>
```

Agent chỉ cần cài URL này thành một MCP server. Với Agent_bot/Gemini Live,
không nên bật đồng thời toàn bộ 347 POST; hãy block các nhóm không dùng và
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

```powershell
docker build -t hicas-cxm-mcp .
docker run --rm -p 8000:8000 --env-file .env `
  -e HOST=0.0.0.0 `
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 `
  hicas-cxm-mcp
```

Khi publish qua domain, thêm hostname thật vào `MCP_ALLOWED_HOSTS`, đặt
`MCP_KEY` mạnh và terminate HTTPS ở reverse proxy. Không publish service
ra Internet khi chưa bật cả HTTPS lẫn xác thực.

```env
HOST=0.0.0.0
PORT=8000
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
- `/mcp` chứa cả GET và POST nghiệp vụ; không chứa API quản trị.
- Mọi POST bắt buộc `confirmWrite: true`; 73 POST bulk/import/sync/cancel/reject/
  reset/delete còn bắt buộc `confirmDestructive: true`.
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
`/mcp?MCP_KEY=...` cho toàn bộ 183 GET và 347 POST.

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
npm run generate:tools
npm run check
```

Generator đọc quy tắc loại trừ trong `config/selected-groups.json` và sẽ thất bại
nếu Swagger không còn đúng 227 GET/393 POST hoặc kết quả không còn đúng 183 GET/
347 POST. Đây là
chốt an toàn buộc người vận hành xem xét thay đổi upstream và danh sách API quản
trị trước khi cập nhật file allowlist.

## Kiểm thử

```powershell
npm run check
```

Bộ test kiểm tra:

- đúng 183 GET và 347 POST, không chứa tag/path quản trị;
- không trùng tool/path/method;
- chuyển đổi path/query parameter đúng OpenAPI;
- giới hạn phân trang;
- kết nối end-to-end duy nhất `/mcp`, `tools/list` và `tools/call` cho cả GET/POST;
- bearer token CXM được chuyển tiếp đúng tới API nguồn.
