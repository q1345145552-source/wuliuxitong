/** 尾端候选/改派：真路由与真前端服务，内存事务和锁轨迹；不连接数据库。 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
type Row = Record<string, any>;
let ships: Row[] = [], deliveries: Row[] = [], logs: Row[] = [];
const reads: Array<{ model: string; args: any }> = [];
const locks: string[] = [];
const writes: string[] = [];
let afterLock: (key: string) => void = () => {};
const copy = <T>(v: T): T => structuredClone(v);
const relations = new Set(["order", "client", "products", "shipments", "containerItems", "container", "statusLogs", "addresses"]);
function match(row: Row, where: any = {}): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return v.some((w: any) => match(row, w));
    if (k === "AND") return (Array.isArray(v) ? v : [v]).every((w: any) => match(row, w));
    if (k === "NOT") return !match(row, v);
    if (v === undefined) return true;
    if (v === null) return row[k] == null;
    if (typeof v !== "object" || v instanceof Date) return row[k] === v;
    if ("in" in v) return v.in.includes(row[k]);
    if ("notIn" in v) return !v.notIn.includes(row[k]);
    if ("not" in v) return row[k] !== v.not;
    if ("startsWith" in v) return String(row[k]).startsWith(v.startsWith);
    if ("equals" in v) return v.mode === "insensitive" ? String(row[k]).toLowerCase() === String(v.equals).toLowerCase() : row[k] === v.equals;
    /* 关系上的 some / none / every（2026-09-23 加）。
       起因：整柜的单不进普通运单列表，/staff/shipments 的 where 里多了
       `containerItems: { none: { container: { isFcl: true } } }`，
       这个假 Prisma 原来不认识关系条件，直接抛 Unimplemented。
       这里按「这一行上挂着的那个数组」来判，数组不存在就当空。 */
    /* ⚠️ 只对**认识的关系键**生效（2026-09-23 第 2 轮复核提的）：
       不加这道的话，where 里把 `containerItems` 写错一个字母，
       旧代码会抛 Unimplemented（吵，但会红），这里却会静默当成空数组返回 true。 */
    if (("some" in v || "none" in v || "every" in v) && relations.has(k)) {
      const list: Row[] = Array.isArray(row[k]) ? row[k] : [];
      if ("some" in v) return list.some((child) => match(child, v.some));
      if ("none" in v) return !list.some((child) => match(child, v.none));
      return list.every((child) => match(child, v.every));
    }
    // 关系上直接写条件（`container: { isFcl: true }`）：往下钻一层
    if (relations.has(k)) return row[k] == null ? false : match(row[k], v);
    throw new Error(`Unimplemented where ${k}: ${JSON.stringify(v)}`);
  });
}
function shape(row: any, args: any = {}): any {
  if (row == null) return row;
  if (Array.isArray(row)) {
    let arr = row.filter(r => match(r, args.where));
    const orders = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
    arr = [...arr].sort((a,b) => {
      for (const ord of orders) for (const [key, dir] of Object.entries(ord)) {
        const d = a[key] === b[key] ? 0 : a[key] > b[key] ? 1 : -1;
        if (d) return dir === "desc" ? -d : d;
      }
      return 0;
    });
    return arr.slice(args.skip ?? 0, args.take == null ? undefined : (args.skip ?? 0) + args.take).map(r => shape(r, args));
  }
  const out: Row = {};
  if (!args.select) for (const [key, value] of Object.entries(row)) if (value == null || typeof value !== "object" || value instanceof Date) out[key] = copy(value);
  for (const [key, spec] of Object.entries(args.select ?? args.include ?? {}) as [string, any][]) {
    if (!spec) continue;
    assert.ok(Object.hasOwn(row, key), `Missing fixture field ${key}`);
    out[key] = relations.has(key) ? shape(row[key], spec === true ? {} : spec) : copy(row[key]);
  }
  return out;
}
function strict(name: string, methods: Row): any {
  return new Proxy(methods, { get(t,k) { if (typeof k === "symbol" || k === "then") return undefined; if (!Object.hasOwn(t,k)) throw Error(`UNSTUBBED ${name}.${String(k)}`); return t[k]; } });
}
function ship(id: string, count = 2, parent: string | null = null): Row {
  return { id, companyId:"c", orderId:`o${parent ?? id}`, trackingNo:id, parentTrackingNo:parent, packageCount:count,
    currentStatus:"inWarehouseTH", transportMode:"sea", weightKg:8, volumeM3:0.2, updatedAt:new Date(0), createdAt:new Date(0),
    batchNo:null,containerNo:null,domesticTrackingNo:null,currentLocation:null,warehouseId:"wh",remark:null,
    /* 柜内记录：这些假运单都是没装过柜的普通单（2026-09-23 加）。
       整柜那条路会给这里塞 [{container:{isFcl:true}}]，建派送单那边据此拦下来。 */
    containerItems: [] as Row[],
    order:{id:`o${parent ?? id}`,orderNo:null,itemName:"鞋",clientId:"mark",client:{name:"客户"},packageCount:9,
      productQuantity:null,weightKg:36,volumeM3:0.9,transportMode:"sea",shipDate:"2026-09-01",receiverNameTh:"收货人",receiverPhoneTh:"123",receiverAddressTh:"地址",receivableAmountCny:null,receivableCurrency:"CNY",paymentStatus:"unpaid",packageUnit:"box",cargoType:"normal"},
  };
}
function delivery(id:string,sid:string,wd:string,status="DELIVERING"): Row {
 return {id,companyId:"c",shipmentId:sid,deliveryNo:wd,status,driverName:"司机",phoneNumber:"123",licensePlate:"车",deliveryDate:"2026-09-10",signImageBase64:null,updatedAt:new Date(0)};
}
function reset(list: Row[]) { ships=copy(list);deliveries=[];logs=[];reads.length=0;locks.length=0;writes.length=0;afterLock=()=>{}; }
function list(model: string, rows: Row[], args: any): any[] { reads.push({model,args:copy(args)}); return shape(rows,args); }
const db: any = strict("prisma", {
  shipment: strict("shipment", {
    async count(args: any) { reads.push({model:"shipment.count",args:copy(args)});return ships.filter(r=>match(r,args.where)).length; },
    async findMany(args: any) { return list("shipment",ships,args); },
    async findFirst(args: any) { return list("shipment",ships,{...args,take:1})[0] ?? null; },
    async findUnique(args: any) { return list("shipment",ships,{...args,take:1})[0] ?? null; },
    async update(args: any) { const r=ships.find(r=>match(r,args.where));assert.ok(r);Object.assign(r,args.data);return shape(r,args); },
  }),
  orderProduct: strict("orderProduct", { async findMany(args: any) { return list("orderProduct",[],args); } }),
  orderProductImage: strict("orderProductImage", { async findMany(args: any) { return list("orderProductImage",[],args); } }),
  adminLastmileOrder: strict("adminLastmileOrder", {
    async findMany(args: any) { return list("adminLastmileOrder",deliveries,args); },
    async findFirst(args: any) { return list("adminLastmileOrder",deliveries,{...args,take:1})[0] ?? null; },
    async findUnique(args: any) { return list("adminLastmileOrder",deliveries,{...args,take:1})[0] ?? null; },
    async create(args: any) { if(deliveries.some(r=>r.deliveryNo===args.data.deliveryNo&&r.shipmentId===args.data.shipmentId)) throw Object.assign(Error("duplicate"),{code:"P2002"});writes.push(`create:${args.data.shipmentId}`);deliveries.push(copy(args.data));return shape(args.data,args); },
    async update(args: any) { const r=deliveries.find(x=>match(x,args.where));assert.ok(r,"update 的目标派送单不存在");writes.push(`update:${r.id}`);Object.assign(r,args.data);return shape(r,args); },
    async delete(args: any) { const index=deliveries.findIndex(r=>match(r,args.where));assert.ok(index>=0);writes.push(`delete:${deliveries[index].id}`);return deliveries.splice(index,1)[0]; },
  }),
  statusLog: strict("statusLog", { async create(args: any) { logs.push(copy(args.data));return args.data; } }),
  async $queryRaw(strings: TemplateStringsArray,...values: any[]) {
    const sql=strings.join("?").replace(/\s+/g," ");
    assert.match(sql,/SELECT id FROM (admin_lastmile_orders|shipments).*FOR UPDATE/i);
    let id=values[0];if(sql.includes("tracking_no"))id=ships.find(s=>s.trackingNo===id)?.id;
    const key=`${sql.includes("admin_lastmile_orders")?"lastmile":"shipment"}:${id}`;locks.push(key);afterLock(key);return [{id}];
  },
  async $executeRawUnsafe(sql: string) { assert.equal(sql,"SELECT pg_advisory_xact_lock(2901)");locks.push("2901");return 1; },
  async $transaction(fn: (tx:any)=>Promise<any>) { const before=copy({ships,deliveries,logs});try{return await fn(db);}catch(e){({ships,deliveries,logs}=before);throw e;} },
});
(globalThis as any).__prisma=db;
function loadWebModule(relative: string, fetchImpl: (input:any,init?:RequestInit)=>Promise<Response>) {
  const ctx=vm.createContext({console,process:{env:{}},URLSearchParams,Response,Request,Headers,AbortController,atob,setTimeout,clearTimeout,fetch:fetchImpl});
  const cache=new Map<string,any>();
  function load(file: string): any {
    file=path.resolve(file);if(cache.has(file))return cache.get(file);
    const code=ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const mod={exports:{}};cache.set(file,mod.exports);
    vm.runInContext(`(function(require,module,exports){${code}\n})`,ctx,{filename:file})((name:string)=>{assert.ok(name.startsWith("."));return load(path.resolve(path.dirname(file),name+(path.extname(name)?"":".ts")));},mod,mod.exports);return mod.exports;
  }
  return load(relative);
}
// 真工作台 JSX/回调；只替换 hooks 与 I/O，不启动浏览器或 HTTP 服务。
function workspaceFixture(orderRows: Row[], replies: Array<{status:number;data?:Row;message?:string}>, answers: boolean[], canUnsign=false) {
  let cursor=0;const states:any[]=[];const requests:Row[]=[];const confirms:string[]=[];const toasts:string[]=[];let reloads=0;
  const hook=(init:any)=>{const i=cursor++;if(!(i in states))states[i]=typeof init==="function"?init():init;return [states[i],(v:any)=>{states[i]=typeof v==="function"?v(states[i]):v}]};
  const jsx= (type:any,props:any,key?:any)=>({type,props:props??{},key});
  const ctx=vm.createContext({console,Error,Set,Map,Date,JSON,requestAnimationFrame:(fn:Function)=>fn(),confirm:(message:string)=>{confirms.push(message);assert.ok(answers.length>0,"Unexpected confirmation");return answers.shift();}});
  function load(file:string):any {
    const mod={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
    vm.runInContext(`(function(require,module,exports){${code}\n})`,ctx,{filename:file})((name:string)=>{
      if(name==="react")return {useState:hook,useMemo:(fn:Function)=>fn(),useEffect:()=>{},useRef:(v:any)=>hook({current:v})[0]};
      if(name==="react/jsx-runtime")return {jsx,jsxs:jsx,Fragment:"fragment"};
      if(name.endsWith("core-api"))return {apiBaseUrl:()=>"http://fixture",authHeaders:()=>({}),fetchWithSession:async(_url:string,init:Row)=>{requests.push(JSON.parse(init.body));const r=replies.shift();assert.ok(r,"Unexpected request");return r;},parseApiResponse:async(r:Row)=>{if(r.status!==200)throw new Error(r.message);return r.data;}};
      if(name==="./viewModel")return load(path.resolve(path.dirname(file),"viewModel.ts"));
      if(name.endsWith("request-gate"))return {createRequestGate:()=>({})};
      if(name.endsWith("ShipmentTrackModal"))return {openShipmentTrack:()=>{throw Error("Unexpected track")}};
      if(name.endsWith("exportDispatchWorkbooks"))return {downloadLastmileCustomerWorkbook:()=>{throw Error("Unexpected export")}};
      throw Error(`Unstubbed workspace import ${name}`);
    },mod,mod.exports);return mod.exports;
  }
  const Component=load(path.resolve("apps/web/src/modules/lastmile/LastmileDispatchWorkspace.tsx")).default;
  const props={lmOrderList:orderRows,lmShipments:[{id:"S1",trackingNo:"S1",clientId:"客户",itemName:"鞋 / 包",packageCount:2}],onToast:(s:string)=>toasts.push(s),onReloadOrders:()=>{reloads++},onLoadShipments:()=>{},canUnsign};
  const render=()=>{cursor=0;return Component(props);};
  const nodes=(tree:any):any[]=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==="object"?(typeof tree.type==="function"?nodes(tree.type(tree.props)):[tree,...nodes(tree.props?.children)]):[];
  const text=(tree:any):string=>Array.isArray(tree)?tree.map(text).join(""):tree&&typeof tree==="object"?text(tree.props?.children):tree==null||typeof tree==="boolean"?"":String(tree);
  const button=(pattern:RegExp)=>{const node=nodes(render()).find(n=>n.type==="button"&&pattern.test(text(n)));assert.ok(node,`Button ${pattern}`);return node;};
  return {requests,confirms,toasts,render,text,get reloads(){return reloads;},
    async choose(append=false){await button(append?/追加运单/:/^创建 WD/).props.onClick();const box=nodes(render()).find(n=>n.type==="input"&&n.props.type==="checkbox");assert.ok(box);box.props.onChange();},
    async submit(){const node=nodes(render()).find(n=>n.type==="button"&&String(n.props.onClick).includes("submitDispatch"));assert.ok(node,"Submit button");await node.props.onClick();await new Promise<void>(resolve=>setImmediate(resolve));},
    /** ⚠️ text(render()) 不会展开函数组件（卡片是子组件），找卡片里的按钮必须走 nodes() */
    findButton(label:string){return nodes(render()).find(n=>n.type==="button"&&text(n).includes(label));},
    async clickUnsign(){const node=nodes(render()).find(n=>n.type==="button"&&text(n).includes("撤销签收"));assert.ok(node,"撤销签收 button");await node.props.onClick();await new Promise<void>(resolve=>setImmediate(resolve));},
  };
}

const cases: Array<[string,()=>Promise<void>]> = [];
const check=(name:string,fn:()=>Promise<void>)=>cases.push([name,fn]);
async function main() {
 const routes=new Map<string,Function>();const app:any={};for(const m of ["get","post","put","patch","delete"])app[m]=(p:string,h:Function)=>routes.set(`${m.toUpperCase()} ${p}`,h);
 (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
 (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);
 async function call(key:string,body:any={},query:Record<string,string>={},auth:any={userId:"staff",companyId:"c",role:"staff",name:"员工"}) {
  const handler=routes.get(key);assert.ok(handler);let status=200;let raw:any;const res:any={status(s:number){status=s;return res},json(p:any){raw=p}};
  await handler({body,query,headers:{},auth},res);return {status,raw,data:raw?.data};
 }
 const ADMIN={userId:"boss",companyId:"c",role:"admin",name:"管理员"};
 check("1) all=1提供hasChildren，普通列表原字段/查询次数不变",async()=>{
  reset([ship("P0",0),ship("C1",2,"P0"),ship("P1",3),ship("C2",1,"P1"),ship("L",0)]);
  const all=await call("GET /staff/shipments",{}, {all:"1"});assert.equal(all.status,200);
  const map=new Map<string,any>(all.data.items.map((r:any)=>[r.id,r]));
  assert.equal(map.get("P0").hasChildren,true);assert.equal(map.get("P1").hasChildren,true);assert.equal(map.get("L").hasChildren,false);assert.equal(map.get("C1").hasChildren,false);
  const allCount=reads.filter(r=>r.model==="shipment").length;reads.length=0;
  const ordinary=await call("GET /staff/shipments");assert.equal(ordinary.status,200);assert.equal(ordinary.data.items.length,3);
  assert.ok(ordinary.data.items.every((r:any)=>!Object.hasOwn(r,"hasChildren")));
  // hasChildren 复用「补父单总件数」那次子单查询，all=1 不该比普通列表多查一次
  assert.equal(reads.filter(r=>r.model==="shipment").length,allCount);
 });
 check("3a) 件数为空(null)的分柜父单同样拒绝——跟前端 (packageCount ?? 0) 一个口径",async()=>{
  const parent=ship("PN",0);parent.packageCount=null;reset([parent,ship("CN",2,"PN")]);
  const r=await call("POST /admin/lastmile/orders",{shipmentIds:["PN"]});
  assert.equal(r.status,409);assert.match(r.raw.message,/已分柜/);assert.equal(deliveries.length,0);
 });
 check("2) 真候选服务只过滤零件分柜父单，保留留货父单/子单/老单",async()=>{
  reset([ship("P0",0),ship("C1",0,"P0"),ship("P1",3),ship("C2",1,"P1"),ship("L",0)]);
  const api=loadWebModule("apps/web/src/services/business-api.ts",async(input:any)=>{
    const url=new URL(String(input));assert.equal(url.pathname,"/staff/shipments");assert.equal(url.searchParams.get("all"),"1");
    const r=await call("GET /staff/shipments",{},Object.fromEntries(url.searchParams));return new Response(JSON.stringify(r.raw),{status:r.status});
  });
  const result=await api.fetchLastmileShipments();
  assert.deepEqual(Array.from(result,(r:any)=>r.id),["C1","P1","C2","L"]);
  assert.deepEqual(Array.from(result,(r:any)=>r.packageCount),[0,3,1,0]);
 });
 check("3) 建单拒绝零件分柜父单，整车回滚且不写轨迹",async()=>{
  reset([ship("P0",0),ship("C1",2,"P0")]);
  const r=await call("POST /admin/lastmile/orders",{shipmentIds:["P0"]});
  assert.equal(r.status,409);assert.match(r.raw.message,/已分柜/);assert.equal(deliveries.length,0);assert.equal(logs.length,0);assert.equal(ships[0].currentStatus,"inWarehouseTH");
 });
 check("4) 未确认改派的409列全冲突单号与WD，整车不写",async()=>{
  reset([ship("S1"),ship("S2"),ship("S3")]);deliveries=[delivery("lm1","S1","WD000001"),delivery("lm2","S2","WD000002")];
  const r=await call("POST /admin/lastmile/orders",{shipmentIds:["S1","S2","S3"]});
  assert.equal(r.status,409);for(const text of ["S1","S2","WD000001","WD000002","派送中"])assert.ok(r.raw.message.includes(text),r.raw.message);
  assert.equal(deliveries.length,2);assert.equal(logs.length,0);
 });
 check("5) 改派删除旧行、新建新WD、一次状态轨迹与moved",async()=>{
  reset([ship("S1")]);deliveries=[delivery("lm1","S1","WD000001")];
  const r=await call("POST /admin/lastmile/orders",{shipmentIds:["S1"],moveFromDelivering:true});
  assert.equal(r.status,200);assert.equal(r.data.deliveryNo,"WD000002");assert.equal(r.data.count,1);assert.equal(r.data.moved,1);assert.deepEqual(r.data.skipped,[]);
  assert.equal(deliveries.length,1);assert.equal(deliveries[0].deliveryNo,"WD000002");assert.equal(ships[0].currentStatus,"outForDelivery");
  assert.equal(logs.length,1);assert.match(logs[0].remark,/改派：从 WD000001 转到 WD000002，/);
 });
 check("6) 同WD追加跳过且保留原状态/轨迹，重复ids不重复创建",async()=>{
  reset([ship("S1")]);deliveries=[delivery("lm1","S1","WD000001")];
  for(const flag of [true,false]) {
   const r=await call("POST /admin/lastmile/orders",{shipmentIds:["S1","S1"],deliveryNo:"WD000001",moveFromDelivering:flag});
   assert.equal(r.status,200);assert.equal(r.data.count,0);assert.equal(r.data.moved,0);assert.deepEqual(r.data.skipped,["S1"]);
  }
  assert.equal(deliveries.length,1);assert.equal(logs.length,0);assert.equal(ships[0].currentStatus,"inWarehouseTH");
 });
 check("7) 旧行锁后已SIGNED：保留历史和凭证，正常再派且moved=0",async()=>{
  reset([ship("S1")]);deliveries=[delivery("lm1","S1","WD000001")];
  afterLock=(key)=>{if(key==="lastmile:lm1"){deliveries[0].status="SIGNED";deliveries[0].signImageBase64="proof";ships[0].currentStatus="delivered";}};
  const r=await call("POST /admin/lastmile/orders",{shipmentIds:["S1"],moveFromDelivering:true});
  assert.equal(r.status,200);assert.equal(r.data.moved,0);assert.equal(deliveries.length,2);assert.equal(deliveries[0].status,"SIGNED");assert.equal(deliveries[0].signImageBase64,"proof");
  assert.equal(logs.length,1);assert.doesNotMatch(logs[0].remark,/改派/);assert.equal(logs[0].fromStatus,"delivered");
 });
 check("8) 新建/追加锁序：2901(仅新建) → 有序旧行 → 子单 → 父单",async()=>{
  for(const append of [false,true]) {
   reset([ship("P",0),ship("C2",2,"P"),ship("C1",2,"P"),ship("T")]);
   deliveries=[delivery("b","C1","WD000001"),delivery("a","C2","WD000001"),delivery("t","T","WD000002")];
   const r=await call("POST /admin/lastmile/orders",{shipmentIds:["C2","C1"],moveFromDelivering:true,deliveryNo:append?"WD000002":undefined});
   assert.equal(r.status,200);assert.equal(r.data.moved,2);
   assert.deepEqual(locks,[...(append?[]:["2901"]),"lastmile:a","lastmile:b","shipment:C1","shipment:C2","shipment:P","shipment:P","shipment:P"]);
   console.log(`LOCK ${append?"append":"new"}: ${locks.join(" -> ")}`);
  }
 });
 check("9) 锁运单期间新出现冲突：409整车回滚，不倒拿派送锁",async()=>{
  reset([ship("S1"),ship("S2")]);deliveries=[delivery("lm1","S1","WD000001")];
  afterLock=(key)=>{if(key==="shipment:S2")deliveries.push(delivery("race","S2","WD000099"));};
  const r=await call("POST /admin/lastmile/orders",{shipmentIds:["S1","S2"],moveFromDelivering:true});
  assert.equal(r.status,409);assert.match(r.raw.message,/派送中/);assert.equal(logs.length,0);assert.deepEqual(deliveries.map(r=>r.id),["lm1"]);
  assert.ok(!locks.includes("lastmile:race"));assert.ok(ships.every(r=>r.currentStatus==="inWarehouseTH"));
 });
 check("10) 真工作台本地冲突取消不发请求",async()=>{
  const ui=workspaceFixture([{...delivery("lm1","S1","WD000001"),trackingNo:"S1"}],[],[false]);
  await ui.choose();await ui.submit();assert.equal(ui.requests.length,0);assert.equal(ui.confirms.length,1);assert.match(ui.confirms[0],/S1（WD000001）/);
 });
 check("11) 真工作台确认改派、显示其他WD、成功提示改派/跳过计数",async()=>{
  const ui=workspaceFixture([{...delivery("lm1","S1","WD000001"),trackingNo:"S1"}], [{status:200,data:{deliveryNo:"WD000002",count:1,moved:1,skipped:["S2"]}}],[true]);
  await ui.choose();assert.match(ui.text(ui.render()),/在 WD000001 派送中/);await ui.submit();
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].moveFromDelivering,true);assert.match(ui.toasts[0],/改派 1 票，跳过 1 票/);assert.equal(ui.reloads,1);
 });
 check("12) 真工作台并发409仅确认重试一次；取消保留选择；非冲突不重试",async()=>{
  for(const accept of [true,false]) {
   const ui=workspaceFixture([], [{status:409,message:"S1（WD000001）派送中"},{status:200,data:{deliveryNo:"WD000002",count:1,moved:1,skipped:[]}}],[accept]);
   await ui.choose();await ui.submit();assert.equal(ui.requests.length,accept?2:1);assert.equal(ui.confirms.length,1);assert.equal(ui.requests[0].moveFromDelivering,false);
   if(accept)assert.equal(ui.requests[1].moveFromDelivering,true);else assert.match(ui.text(ui.render()),/本趟已选1/);
  }
  const repeat=workspaceFixture([], [{status:409,message:"第一张派送中"},{status:409,message:"第二张派送中"}],[true]);
  await repeat.choose();await repeat.submit();assert.equal(repeat.requests.length,2);assert.equal(repeat.confirms.length,1);assert.equal(repeat.toasts.at(-1),"第二张派送中");
  for(const error of [{status:409,message:"已分柜"},{status:500,message:"派送中服务失败"}]){
   const ui=workspaceFixture([], [error],[]);await ui.choose();await ui.submit();assert.equal(ui.requests.length,1);assert.equal(ui.confirms.length,0);
  }
 });
 check("13) 真工作台同WD追加无冲突标签/确认，SIGNED历史不提示改派",async()=>{
  const ui=workspaceFixture([{...delivery("lm1","S1","WD000001"),trackingNo:"S1"}], [{status:200,data:{deliveryNo:"WD000001",count:0,moved:0,skipped:["S1"]}}],[]);
  await ui.choose(true);assert.doesNotMatch(ui.text(ui.render()),/在 WD000001 派送中/);await ui.submit();assert.equal(ui.confirms.length,0);assert.equal(ui.requests[0].deliveryNo,"WD000001");assert.equal(ui.requests[0].moveFromDelivering,false);
  const signed=workspaceFixture([delivery("lm1","S1","WD000001","SIGNED")], [{status:200,data:{deliveryNo:"WD000002",count:1,moved:0,skipped:[]}}],[]);
  await signed.choose();await signed.submit();assert.equal(signed.confirms.length,0);assert.equal(signed.requests[0].moveFromDelivering,false);
 });
 check("14) 无效/跨公司运单整车回滚，非法改派标志400",async()=>{
  const foreign=ship("F");foreign.companyId="other";
  reset([ship("S1"),foreign]);deliveries=[delivery("lm1","S1","WD000001")];
  for(const invalid of ["MISSING","F"]) {
   const r=await call("POST /admin/lastmile/orders",{shipmentIds:["S1",invalid],moveFromDelivering:true});assert.equal(r.status,404);assert.deepEqual(deliveries.map(r=>r.id),["lm1"]);assert.equal(logs.length,0);
  }
  const r=await call("POST /admin/lastmile/orders",{shipmentIds:["S1"],moveFromDelivering:"true"});assert.equal(r.status,400);
 });
 check("15) 混选留货父单与另一家子单：所有祖先同层id排序，不误派祖先",async()=>{
  reset([ship("zP",3),ship("aQ",0),ship("C",2,"aQ"),ship("D",2,"zP")]);
  const r=await call("POST /admin/lastmile/orders",{shipmentIds:["zP","C"]});assert.equal(r.status,200);
  const firstLocks=[...new Set(locks.filter(key=>key.startsWith("shipment:")))];
  assert.deepEqual(firstLocks,["shipment:C","shipment:aQ","shipment:zP"]);
  assert.deepEqual(deliveries.map(r=>r.shipmentId).sort(),["C","zP"]);assert.equal(logs.length,2);
 });
 check("16) 真路由+service跨页过滤：第一页500空父单仍读取第二页",async()=>{
  const rows:Row[]=[];
  for(let i=0;i<500;i++){const id=`P${String(i).padStart(3,"0")}`;rows.push(ship(id,0));const c=ship(`C${i}`,1,id);c.currentStatus="created";rows.push(c);}
  rows.push(ship("stock",3),ship("legacy",0),ship("child-zero",0,"P000"));reset(rows);
  const pages:string[]=[];
  const api=loadWebModule("apps/web/src/services/business-api.ts",async(input:any)=>{
   const url=new URL(String(input));assert.equal(url.pathname,"/staff/shipments");pages.push(url.searchParams.get("page")!);
   const r=await call("GET /staff/shipments",{},Object.fromEntries(url.searchParams));return new Response(JSON.stringify(r.raw),{status:r.status});
  });
  const result=await api.fetchLastmileShipments();assert.deepEqual(pages,["1","2"]);assert.deepEqual(Array.from(result,(r:any)=>r.id),["stock","legacy","child-zero"]);assert.deepEqual(Array.from(result,(r:any)=>r.packageCount),[3,0,0]);
 });
 check("17) 改派后旧行的签收/删除均404，不碰新WD及子父状态",async()=>{
  reset([ship("P",0),ship("C",2,"P")]);deliveries=[delivery("old","C","WD000001")];
  const moved=await call("POST /admin/lastmile/orders",{shipmentIds:["C"],moveFromDelivering:true});assert.equal(moved.status,200);
  const snapshot=copy({ships,deliveries,logs});
  const signed=await call("POST /admin/lastmile/status",{id:"old",status:"SIGNED",signImageBase64:"proof"});assert.equal(signed.status,404);
  const deleted=await call("DELETE /admin/lastmile/orders",{}, {id:"old"});assert.equal(deleted.status,404);
  assert.deepEqual({ships,deliveries,logs},snapshot);
 });
 check("18) 删除改派后的新行：子单父单均回到仓库，轨迹只再增删除一条",async()=>{
  reset([ship("P",0),ship("C",2,"P")]);deliveries=[delivery("old","C","WD000001")];
  const moved=await call("POST /admin/lastmile/orders",{shipmentIds:["C"],moveFromDelivering:true});assert.equal(moved.status,200);
  assert.ok(ships.every(s=>s.currentStatus==="outForDelivery"));
  const deleted=await call("DELETE /admin/lastmile/orders",{}, {id:deliveries[0].id});assert.equal(deleted.status,200);assert.equal(deleted.data.reverted,true);
  assert.equal(deliveries.length,0);assert.equal(logs.length,2);assert.ok(ships.every(s=>s.currentStatus==="inWarehouseTH"));assert.match(logs[1].remark,/删除派送单/);
 });
 check("19) 删除已签收旧历史，新WD仍DELIVERING则不退回货物",async()=>{
  reset([ship("S1")]);deliveries=[delivery("signed","S1","WD000000","SIGNED"),delivery("old","S1","WD000001")];
  const moved=await call("POST /admin/lastmile/orders",{shipmentIds:["S1"],moveFromDelivering:true});assert.equal(moved.status,200);
  const deleted=await call("DELETE /admin/lastmile/orders",{}, {id:"signed"});assert.equal(deleted.status,200);assert.equal(deleted.data.reverted,false);
  assert.equal(deliveries.length,1);assert.equal(deliveries[0].deliveryNo,"WD000002");assert.equal(ships[0].currentStatus,"outForDelivery");assert.equal(logs.length,1);
 });
 check("20) 第一票已删旧建新后第二票不合法：整车回滚旧行/状态/轨迹",async()=>{
  reset([ship("A"),ship("Z",0),ship("Z-1",2,"Z")]);deliveries=[delivery("old","A","WD000001")];writes.length=0;
  const snapshot=copy({ships,deliveries,logs});
  const result=await call("POST /admin/lastmile/orders",{shipmentIds:["A","Z"],moveFromDelivering:true});assert.equal(result.status,409);assert.match(result.raw.message,/已分柜/);
  assert.deepEqual(writes,["delete:old","create:A"]);assert.deepEqual({ships,deliveries,logs},snapshot);
 });
 check("21) 混入其他公司运单：404整车不写，不移动其他公司旧WD",async()=>{
  reset([ship("A"),{...ship("FOREIGN"),companyId:"other"}]);deliveries=[delivery("old","A","WD000001"),{...delivery("secret","FOREIGN","WDSECRET"),companyId:"other"}];writes.length=0;
  const snapshot=copy({ships,deliveries,logs});
  const result=await call("POST /admin/lastmile/orders",{shipmentIds:["A","FOREIGN"],moveFromDelivering:true});assert.equal(result.status,404);
  assert.deepEqual(writes,[]);assert.deepEqual({ships,deliveries,logs},snapshot);assert.doesNotMatch(result.raw.message,/WDSECRET/);
 });
 check("22) 同WD已SIGNED历史保留跳过；非boolean改派标志400",async()=>{
  reset([ship("S1")]);ships[0].currentStatus="delivered";deliveries=[{...delivery("signed","S1","WD000001","SIGNED"),signImageBase64:"proof"}];
  const snapshot=copy({ships,deliveries,logs});
  const skipped=await call("POST /admin/lastmile/orders",{shipmentIds:["S1"],deliveryNo:"WD000001",moveFromDelivering:true});assert.equal(skipped.status,200);assert.deepEqual(skipped.data.skipped,["S1"]);assert.equal(skipped.data.moved,0);assert.deepEqual({ships,deliveries,logs},snapshot);
  const invalid=await call("POST /admin/lastmile/orders",{shipmentIds:["S1"],moveFromDelivering:"true"});assert.equal(invalid.status,400);assert.deepEqual({ships,deliveries,logs},snapshot);
 });

 check("23) 删除派送单时这票货另有已签收单：保持已签收，不退回已到仓",async()=>{
  /* 生产实测 3 票（GZ260702122-1/WD000363、YW0001379-1/WD000359、GZ260800490-1/WD000476）
     卡在「运单说在泰国仓、却挂着一张已签收派送单」。删单那条路原来只看有没有别的「派送中」单，
     没看「已签收」，于是把有签收记录的货退回了仓库。 */
  reset([ship("P",0),ship("C",2,"P")]);
  for(const row of ships) row.currentStatus="outForDelivery";
  deliveries=[{...delivery("signed","C","WD000363","SIGNED"),signImageBase64:"proof"},delivery("cur","C","WD000647")];
  const deleted=await call("DELETE /admin/lastmile/orders",{}, {id:"cur"});
  assert.equal(deleted.status,200);assert.equal(deleted.data.reverted,true);
  assert.match(deleted.data.message,/WD000363/);assert.match(deleted.data.message,/已经签收/);
  // 签收单和凭证一个字都不许动
  assert.deepEqual(deliveries.map(r=>r.id),["signed"]);assert.equal(deliveries[0].signImageBase64,"proof");
  assert.equal(ships.find(r=>r.id==="C")!.currentStatus,"delivered");
  assert.equal(logs.length,1);assert.equal(logs[0].fromStatus,"outForDelivery");assert.equal(logs[0].toStatus,"delivered");
  assert.match(logs[0].remark,/WD000647/);assert.match(logs[0].remark,/WD000363/);
  // 父单按全部子单推算：唯一子单已签收，父单不能留在「派送中」
  assert.equal(ships.find(r=>r.id==="P")!.currentStatus,"delivered");
 });
 check("23b) 没有已签收单时照旧退回已到仓（别把上面那条改成一刀切）",async()=>{
  reset([ship("S1")]);ships[0].currentStatus="outForDelivery";
  deliveries=[delivery("cur","S1","WD000647")];
  const deleted=await call("DELETE /admin/lastmile/orders",{}, {id:"cur"});
  assert.equal(deleted.status,200);assert.equal(deleted.data.reverted,true);assert.equal(deleted.data.message,undefined);
  assert.equal(ships[0].currentStatus,"inWarehouseTH");assert.equal(logs.length,1);assert.equal(logs[0].toStatus,"inWarehouseTH");
 });

 check("24) 撤销误签收：单子回派送中、运单回派送中、签收图保留、轨迹写撤销、父单跟着推算",async()=>{
  reset([ship("P",0),ship("C",2,"P")]);
  for(const row of ships) row.currentStatus="delivered";
  deliveries=[{...delivery("lm1","C","WD000001","SIGNED"),signImageBase64:"proof"}];
  locks.length=0;
  const r=await call("POST /admin/lastmile/unsign",{id:"lm1"},{},ADMIN);
  assert.equal(r.status,200);assert.equal(r.data.deliveryNo,"WD000001");assert.equal(r.data.trackingNo,"C");
  assert.match(r.data.message,/撤销/);
  assert.equal(deliveries[0].status,"DELIVERING","派送单没退回派送中");
  assert.equal(deliveries[0].signImageBase64,"proof","签收图被删了——点错签收不等于要销毁证据");
  assert.equal(ships.find(x=>x.id==="C")!.currentStatus,"outForDelivery");
  assert.equal(logs.length,1);assert.equal(logs[0].fromStatus,"delivered");assert.equal(logs[0].toStatus,"outForDelivery");
  assert.match(logs[0].remark,/撤销误签收（WD000001）/);
  assert.equal(logs[0].operatorRole,"admin","轨迹上要留是谁撤的");
  // 唯一子单回到派送中，父单必须跟着回派送中，不能留在已签收
  assert.equal(ships.find(x=>x.id==="P")!.currentStatus,"outForDelivery");
  // 锁序跟签收/删除一致：派送单 → 运单 → 父单
  assert.deepEqual(locks.filter(k=>k.startsWith("lastmile:")||k.startsWith("shipment:")),["lastmile:lm1","shipment:C","shipment:P"],locks.join(" -> "));
 });
 check("25) 撤销的三道闸：不是已签收 / 运单已退回仓库 / 货还在别的派送中单里 —— 都 409 且一个字不写",async()=>{
  // ① 单子本来就是派送中
  reset([ship("S1")]);ships[0].currentStatus="outForDelivery";deliveries=[delivery("lm1","S1","WD000001")];
  let snapshot=copy({ships,deliveries,logs});
  let r=await call("POST /admin/lastmile/unsign",{id:"lm1"},{},ADMIN);
  assert.equal(r.status,409);assert.match(r.raw.message,/不是「已签收」/);assert.deepEqual({ships,deliveries,logs},snapshot);

  // ② 单子说已签收，可运单已经退回仓库了（生产里卡住的那 3 票就是这样）—— 不许凭空改成派送中
  reset([ship("S1")]);ships[0].currentStatus="inWarehouseTH";
  deliveries=[{...delivery("lm1","S1","WD000001","SIGNED"),signImageBase64:"proof"}];
  snapshot=copy({ships,deliveries,logs});
  r=await call("POST /admin/lastmile/unsign",{id:"lm1"},{},ADMIN);
  assert.equal(r.status,409);assert.match(r.raw.message,/inWarehouseTH/);assert.deepEqual({ships,deliveries,logs},snapshot);

  // ③ 这票货还挂在另一张「派送中」的单里 —— 撤了就会有两张派送中
  reset([ship("S1")]);ships[0].currentStatus="delivered";
  deliveries=[{...delivery("lm1","S1","WD000001","SIGNED"),signImageBase64:"proof"},delivery("lm2","S1","WD000002")];
  snapshot=copy({ships,deliveries,logs});
  r=await call("POST /admin/lastmile/unsign",{id:"lm2X"},{},ADMIN);
  assert.equal(r.status,404,"不存在的 id 应该 404");
  r=await call("POST /admin/lastmile/unsign",{id:"lm1"},{},ADMIN);
  assert.equal(r.status,409);assert.match(r.raw.message,/WD000002/);assert.deepEqual({ships,deliveries,logs},snapshot);
 });
 check("26) 撤销只给管理员：员工 403；别家公司的单 404；都不许动数据",async()=>{
  reset([ship("S1")]);ships[0].currentStatus="delivered";
  deliveries=[{...delivery("lm1","S1","WD000001","SIGNED"),signImageBase64:"proof"}];
  const snapshot=copy({ships,deliveries,logs});
  const staff=await call("POST /admin/lastmile/unsign",{id:"lm1"});
  assert.equal(staff.status,403,`员工不该能撤销（拿到 ${staff.status}）`);
  assert.deepEqual({ships,deliveries,logs},snapshot);
  const foreign=await call("POST /admin/lastmile/unsign",{id:"lm1"},{},{...ADMIN,companyId:"other"});
  assert.equal(foreign.status,404,"别家公司的单应该当不存在");
  assert.deepEqual({ships,deliveries,logs},snapshot);
  const noId=await call("POST /admin/lastmile/unsign",{},{},ADMIN);
  assert.equal(noId.status,400);
 });
 check("27) 真工作台：管理端才有「撤销签收」按钮，点了弹确认，取消不发请求",async()=>{
  const signed=[{...delivery("lm1","S1","WD000001","SIGNED"),trackingNo:"S1"}];
  // 员工端（canUnsign 不传）：按钮不该出现
  const staffUi=workspaceFixture(signed,[],[]);
  assert.equal(staffUi.findButton("撤销签收"),undefined,"员工端不该看到撤销签收");
  assert.ok(staffUi.findButton("删除"),"卡片根本没渲染出来，这条用例等于没测");
  // 管理端：按钮在；点了先弹确认，选取消就不发请求
  const cancel=workspaceFixture(signed,[],[false],true);
  assert.ok(cancel.findButton("撤销签收"),"管理端看不到撤销签收按钮");
  // 已签收的单不该再出现「上传签收」
  assert.equal(cancel.findButton("上传签收"),undefined,"已签收的单还显示上传签收");
  await cancel.clickUnsign();
  assert.equal(cancel.requests.length,0,"取消了还是发了请求");
  assert.equal(cancel.confirms.length,1);assert.match(cancel.confirms[0],/撤销/);
  // 确认之后才发请求，并把后端那句话原样提给员工看
  const accept=workspaceFixture(signed,[{status:200,data:{message:"已撤销 WD000001 里 S1 的签收"}}],[true],true);
  await accept.clickUnsign();
  assert.equal(accept.requests.length,1);assert.equal(accept.requests[0].id,"lm1");
  assert.equal(accept.toasts.at(-1),"已撤销 WD000001 里 S1 的签收");assert.equal(accept.reloads,1);
 });

 /* 整柜不进尾端派送候选（老板 2026-09-23：「排除，整柜的尾端单独在页面里弄」）。
    ⚠️ 上面那些假运单的 containerItems 都是空的，所以整柜排除那条在它们身上**等于没测**
    （2026-09-23 第 2 轮复核点名要补的）。这里专门造一张「装在整柜里」的单，
    证明 /staff/shipments 的候选真的把它筛掉了 —— 尾端派送的候选走的就是这个接口。 */
 check("28) 装在整柜里的运单，不出现在尾端派送候选里", async () => {
  const normal=ship("NORMAL1");const inFcl=ship("INFCL1");
  (inFcl as any).containerItems=[{container:{isFcl:true}}];
  reset([normal,inFcl]);
  const r=await call("GET /staff/shipments",{},{all:"1",status:"inWarehouseTH",pageSize:"500"});
  assert.equal(r.status,200);
  const nos=(r.data?.items??[]).map((x:any)=>x.trackingNo);
  assert.ok(nos.includes("NORMAL1"),`普通单该在候选里，实际拿到 ${JSON.stringify(nos)}`);
  assert.ok(!nos.includes("INFCL1"),`整柜的单不该出现在尾端派送候选里，实际拿到 ${JSON.stringify(nos)}`);
 });

 let failures=0;for(const [name,fn] of cases){try{await fn();console.log("PASS "+name);}catch(e){failures++;console.log("FAIL "+name+"\n"+(e instanceof Error?e.stack:e));}}
console.log(`CHECKS ${cases.length}; FAILURES ${failures}`);if(failures)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
