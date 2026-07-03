// 升级 core-api.ts 的 apiRequest() 后，在 services 目录下逐个替换裸 fetch。
// 替换规则：const response = await fetch(url, { method: "GET", headers: { ...authHeaders() } });
//        → await apiRequest<Type>(url);
// 注意：apiRequest 内部已自动添加 authHeaders 和超时/重试

const fs = require("fs");
const path = require("path");

const files = [
  "apps/web/src/services/admin-ai.ts",
  "apps/web/src/services/ai-client.ts",  
  "apps/web/src/services/auth-api.ts",
];

for (const file of files) {
  let content = fs.readFileSync(file, "utf8");
  
  // Pattern: const response = await fetch(`${apiBaseUrl()}/path`, { method: "GET", headers: { ...authHeaders() } });
  // → await apiRequest<X>(`${apiBaseUrl()}/path`)
  content = content.replace(
    /const response = await fetch\((\$\{apiBaseUrl\(\)\}\/[^,]+),\s*\{\s*method:\s*"GET",\s*headers:\s*\{\s*\.\.\.authHeaders\(\)\s*\}\s*\}\);\s*\n\s*const data = await parseApiResponse<([^>]+)>\(response\);/g,
    'const data = await apiRequest<$1>($2);'
  );
  
  fs.writeFileSync(file, content);
  console.log(`Fixed: ${file}`);
}
