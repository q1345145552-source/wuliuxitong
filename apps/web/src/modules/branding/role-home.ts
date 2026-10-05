/** 每种账号登录后进哪个工作台（登录页、湘泰 app 打开时已登录直接进，两处共用这一份） */
export const ROLE_HOME_PATH: Record<string, string> = {
  admin: "/admin",
  staff: "/staff",
  client: "/client",
  agent: "/agent",
};
