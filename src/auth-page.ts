export interface AuthPageOptions {
  authenticated: boolean;
  instanceName: string;
  upstreamHost: string;
  actionUrl: string;
  logoutUrl: string;
  mcpUrl: string;
  error?: string;
  success?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderAuthPage(options: AuthPageOptions): string {
  const instanceName = escapeHtml(options.instanceName);
  const upstreamHost = escapeHtml(options.upstreamHost);
  const actionUrl = escapeHtml(options.actionUrl);
  const logoutUrl = escapeHtml(options.logoutUrl);
  const mcpUrl = escapeHtml(options.mcpUrl);
  const notice = options.error
    ? `<div class="notice error">${escapeHtml(options.error)}</div>`
    : options.success
      ? '<div class="notice success">Đăng nhập thành công. MCP đã sẵn sàng gọi CXM.</div>'
      : "";
  const content = options.authenticated
    ? `<div class="status"><span class="dot"></span><strong>Đã đăng nhập CXM</strong></div>
       <p>Access token được giữ trong bộ nhớ và sẽ tự gia hạn bằng refresh token.</p>
       <label>Địa chỉ kết nối MCP</label>
       <code>${mcpUrl}</code>
       <form method="post" action="${logoutUrl}">
         <button class="secondary" type="submit">Đăng xuất CXM</button>
       </form>`
    : `<form method="post" action="${actionUrl}" autocomplete="on">
         <label for="username">Tên đăng nhập</label>
         <input id="username" name="username" type="text" autocomplete="username" required maxlength="200" autofocus>
         <label for="password">Mật khẩu</label>
         <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="500">
         <label class="check"><input name="remember" type="checkbox" value="true" checked> Duy trì đăng nhập và tự gia hạn token</label>
         <button type="submit">Đăng nhập CXM</button>
       </form>
       <p class="hint">Mật khẩu chỉ được chuyển qua HTTPS tới máy chủ CXM để đổi token; MCP không lưu mật khẩu.</p>`;

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Đăng nhập ${instanceName}</title>
<style>
:root{font-family:Inter,system-ui,sans-serif;color:#15213b;background:#f3f6fb}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(460px,100%);background:#fff;border:1px solid #dbe3f0;border-radius:18px;padding:32px;box-shadow:0 18px 60px #18345f1a}h1{font-size:24px;margin:0 0 8px}p{color:#58657a;line-height:1.55}.brand{color:#315ec9;font-weight:750;margin-bottom:18px}label{display:block;font-weight:650;margin:18px 0 7px}input[type=text],input[type=password]{width:100%;padding:13px 14px;border:1px solid #c7d1e1;border-radius:10px;font-size:16px}.check{display:flex;gap:9px;align-items:center;font-weight:500;font-size:14px}button{width:100%;border:0;border-radius:10px;padding:13px 16px;background:#315ec9;color:#fff;font-size:16px;font-weight:700;cursor:pointer;margin-top:20px}.secondary{background:#e9eef8;color:#253a69}.notice{padding:12px 14px;border-radius:10px;margin:18px 0}.error{background:#fff0f0;color:#a32020}.success{background:#eaf8ef;color:#146c36}.status{display:flex;gap:10px;align-items:center;padding:14px;background:#eaf8ef;border-radius:10px;color:#146c36}.dot{width:10px;height:10px;border-radius:50%;background:#25a55b}code{display:block;overflow-wrap:anywhere;background:#f2f5fa;border-radius:9px;padding:12px;color:#263c6b}.hint{font-size:13px;margin-bottom:0}
</style></head><body><main class="card"><div class="brand">${instanceName}</div><h1>Đăng nhập để cấp quyền cho MCP</h1><p class="hint">Môi trường CXM: <strong>${upstreamHost}</strong></p>${notice}${content}</main></body></html>`;
}
