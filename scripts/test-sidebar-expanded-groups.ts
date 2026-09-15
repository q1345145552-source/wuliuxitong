/**
 * 侧边栏分组「默认展开 + 记忆」自测（2026-09-16 第 2 轮复核）。
 *
 * 复核员复现的问题：新浏览器里代理登录落地 /agent，左边唯一的「我的客户」组默认收起，
 * 7 个功能入口全看不见；老板在自己浏览器点过管理端分组再登代理号也一样（记忆共用一个键）。
 *
 * 这里直接跑 modules/layout/sidebar-expanded-groups.ts 的真函数（假 localStorage），盯住：
 *   ① 代理没记忆 → 「我的客户」展开；而且代理菜单里的每一组都在默认展开名单里
 *   ② 管理员/员工/客户的键名、默认值一个字不变（他们现有的记忆不许丢、落地样子不许变）
 *   ③ 别的角色记过的展开状态不串到代理身上
 *   ④ 手动收起写进记忆后，再读仍是收起（默认值不许把它重新打开）
 *   ⑤ localStorage 抛错时不崩，退回默认值
 *   ⑥ RoleShell 真用了这套函数（没有另外留一份老写法）
 * 不连库、不起服务。浏览器里的真表现另用 playwright 在生产构建上验过（见修复报告）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const failures: string[] = [];
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const m = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${m.split("\n").join("\n     ")}`);
  }
}

/** 假 localStorage；throwing=true 时模拟 Safari 无痕模式一碰就抛 */
function installFakeWindow(throwing = false): Map<string, string> {
  const store = new Map<string, string>();
  const localStorage = {
    getItem(k: string) {
      if (throwing) throw new Error("SecurityError");
      return store.has(k) ? store.get(k)! : null;
    },
    setItem(k: string, v: string) {
      if (throwing) throw new Error("SecurityError");
      store.set(k, String(v));
    },
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage };
  return store;
}

async function main() {
  const mod = await import("../apps/web/src/modules/layout/sidebar-expanded-groups");
  const { roleFunctionGroups } = await import("../apps/web/src/modules/layout/menu-config");
  console.log("侧边栏分组默认展开与记忆");

  await check("1) 代理新浏览器（没记忆）：「我的客户」默认展开；代理菜单每一组都在默认名单里", () => {
    installFakeWindow();
    const set = mod.initialExpandedGroups("agent");
    assert.ok(set.has("我的客户"), "代理没记忆时「我的客户」没展开 —— 7 个入口又全藏起来了");
    for (const g of roleFunctionGroups.agent) {
      assert.ok(set.has(g.groupLabel), `代理菜单组「${g.groupLabel}」不在默认展开名单里（代理不熟系统，功能不许藏在收起的组里）`);
    }
  });

  await check("2) 管理员/员工/客户：键名、默认值跟改之前一字不差", () => {
    installFakeWindow();
    for (const role of ["admin", "staff", "client"] as const) {
      assert.equal(mod.expandedGroupsKey(role), "xt_sidebar_expanded_groups", `${role} 的记忆键被改了，老用户的展开记忆会全丢`);
      assert.deepEqual([...mod.initialExpandedGroups(role)], ["运单管理", "我的运单"], `${role} 没记忆时的默认展开变了`);
    }
    assert.equal(mod.expandedGroupsKey(null), "xt_sidebar_expanded_groups", "还没读到登录信息时（首屏）要用老键");
    assert.notEqual(mod.expandedGroupsKey("agent"), mod.expandedGroupsKey("admin"), "代理跟管理员共用记忆键 —— 老板本机测代理号会读到管理端的记忆");
  });

  await check("3) 同一浏览器管理员记过「只展开财务」，代理登录照样展开「我的客户」；管理员自己照读原记忆", () => {
    const store = installFakeWindow();
    store.set("xt_sidebar_expanded_groups", JSON.stringify(["财务"]));
    assert.ok(mod.initialExpandedGroups("agent").has("我的客户"), "管理端的记忆串到代理身上了");
    assert.deepEqual([...mod.initialExpandedGroups("admin")], ["财务"], "管理员原来的记忆被默认值覆盖了");
  });

  await check("4) 手动收起记下来以后，再读仍是收起（默认值不许把它重新打开）；代理的记忆不写到老键", () => {
    const store = installFakeWindow();
    const set = mod.initialExpandedGroups("agent");
    set.delete("我的客户");
    mod.saveExpandedGroups("agent", set);
    assert.equal(mod.initialExpandedGroups("agent").has("我的客户"), false, "代理收起后刷新又被展开了");
    assert.equal(store.has("xt_sidebar_expanded_groups"), false, "代理的记忆写进了管理员/员工/客户共用的老键");
    // 老角色同理
    const adminSet = mod.initialExpandedGroups("admin");
    adminSet.delete("运单管理");
    mod.saveExpandedGroups("admin", adminSet);
    assert.equal(mod.initialExpandedGroups("admin").has("运单管理"), false, "管理员收起后刷新又被展开了");
    assert.ok(mod.initialExpandedGroups("agent").size === 0, "管理员的记忆串到代理的键上了");
  });

  await check("5) localStorage 一碰就抛（Safari 无痕）：不崩，退回默认值；写也不抛", () => {
    installFakeWindow(true);
    assert.ok(mod.initialExpandedGroups("agent").has("我的客户"));
    assert.deepEqual([...mod.initialExpandedGroups("staff")], ["运单管理", "我的运单"]);
    assert.doesNotThrow(() => mod.saveExpandedGroups("agent", new Set(["我的客户"])));
  });

  await check("6) 记忆里是坏数据（不是数组 / 混了非字符串）不崩", () => {
    const store = installFakeWindow();
    store.set("xt_sidebar_expanded_groups_agent", "{oops");
    assert.ok(mod.initialExpandedGroups("agent").has("我的客户"), "坏 JSON 应当退回默认值");
    store.set("xt_sidebar_expanded_groups_agent", JSON.stringify(["我的客户", 3, null]));
    assert.deepEqual([...mod.initialExpandedGroups("agent")], ["我的客户"]);
  });

  await check("7) RoleShell 真用这套函数，没有另外留一份读写记忆的老写法", () => {
    const file = path.join(__dirname, "..", "apps", "web", "src", "modules", "layout", "RoleShell.tsx");
    const code = fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    assert.match(code, /from "\.\/sidebar-expanded-groups"/, "RoleShell 没 import sidebar-expanded-groups");
    assert.doesNotMatch(code, /xt_sidebar_expanded_groups/, "RoleShell 里又直接写了记忆键名");
    assert.doesNotMatch(code, /DEFAULT_EXPANDED_GROUPS/, "RoleShell 里又直接用了老默认值（不分角色）");
    // 两处读记忆（首帧 + 挂载后）和一处写记忆都得带角色
    assert.equal((code.match(/initialExpandedGroups\(/g) ?? []).length, 2, "读展开记忆的地方应当正好两处（首帧、挂载后）且都走 initialExpandedGroups");
    assert.match(code, /saveExpandedGroups\(session\.role,/, "写展开记忆没带当前登录角色");
  });

  if (failures.length) {
    console.log(`\n❌ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log("\n✅ 全部通过");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
