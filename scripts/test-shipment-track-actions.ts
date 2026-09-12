/** 轨迹操作回归：真实路由和前端弹窗；严格内存桩，不连接数据库。 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";
const webRequire = createRequire(path.resolve("apps/web/package.json"));
type Row = Record<string, any>;
let ships: Row[] = [], deliveries: Row[] = [], logs: Row[] = [];
const reads: Array<{ model: string; args: any }> = [];
const locks: string[] = [];
const writes: string[] = [];
let afterLock: (key: string) => void = () => {};
const copy = <T>(v: T): T => structuredClone(v);
const relations = new Set(["shipment", "order", "client", "products", "shipments", "containerItems", "container", "statusLogs", "addresses"]);
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
    order:{id:`o${parent ?? id}`,orderNo:null,itemName:"鞋",clientId:"mark",client:{name:"客户"},packageCount:9,
      productQuantity:null,weightKg:36,volumeM3:0.9,transportMode:"sea",shipDate:"2026-09-01",receiverNameTh:"收货人",receiverPhoneTh:"123",receiverAddressTh:"地址",receivableAmountCny:null,receivableCurrency:"CNY",paymentStatus:"unpaid",packageUnit:"box",cargoType:"normal"},
  };
}
function delivery(id:string,sid:string,wd:string,status="DELIVERING"): Row {
 return {id,companyId:"c",shipmentId:sid,deliveryNo:wd,status,driverName:"司机",phoneNumber:"123",licensePlate:"车",deliveryDate:"2026-09-10",signImageBase64:null,updatedAt:new Date(0)};
}
function shipGraph() { return ships.map(s=>({...s,containerItems:[],statusLogs:logs.filter(l=>l.shipmentId===s.id),order:{...s.order,products:[]}})); }
function reset(list: Row[]) { ships=copy(list);deliveries=[];logs=[];reads.length=0;locks.length=0;writes.length=0;afterLock=()=>{}; }
function list(model: string, rows: Row[], args: any): any[] { reads.push({model,args:copy(args)}); return shape(rows,args); }
const db: any = strict("prisma", {
  shipment: strict("shipment", {
    async count(args: any) { reads.push({model:"shipment.count",args:copy(args)});return ships.filter(r=>match(r,args.where)).length; },
    async findMany(args: any) { return list("shipment",shipGraph(),args); },
    async findFirst(args: any) { return list("shipment",shipGraph(),{...args,take:1})[0] ?? null; },
    async findUnique(args: any) { return list("shipment",shipGraph(),{...args,take:1})[0] ?? null; },
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
  statusLog: strict("statusLog", {
 async create(args:any){logs.push(copy(args.data));return args.data;},
 async findFirst(args:any){return list("statusLog",logs.map(r=>({...r,shipment:ships.find(s=>s.id===r.shipmentId)})),{...args,take:1})[0]??null;},
 async delete(args:any){const i=logs.findIndex(r=>match(r,args.where));assert.ok(i>=0);return logs.splice(i,1)[0];},
 }),
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

const cases: Array<[string,()=>Promise<void>]> = [];
const check=(name:string,fn:()=>Promise<void>)=>cases.push([name,fn]);
function trackModule(runEffects:boolean,requests:string[]=[]) {
 const filename=path.resolve("apps/web/src/modules/shipment/ShipmentTrackModal.tsx");
 const source=fs.readFileSync(filename,"utf8")+"\nexport { TrackContent };";
 const js=ts.transpileModule(source,{fileName:filename,compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const result={exports:{} as any};const react=webRequire("react");
 const hooks={...react,useState:(initial:any)=>[initial,()=>{}],useCallback:(f:any)=>f,useEffect:(f:any)=>f()};
 const core={authHeaders:()=>({}),apiBaseUrl:()=>"http://fixture.invalid",parseApiResponse:async()=>({trackingNo:"T"}),fetchWithSession:async(url:string)=>{requests.push(url);return{}},apiRequest:async()=>{throw Error("Unexpected mutation")}};
 vm.runInNewContext(js,{module:result,exports:result.exports,URLSearchParams,console,
   document:{getElementById:()=>null,createElement:()=>({remove(){}}),body:{appendChild(){}}},
   require:(id:string)=>id==="react"?(runEffects?hooks:react):id==="react-dom/client"?{createRoot:()=>({render:(element:any)=>element.type(element.props),unmount(){}})}:id.includes("core-api")?core:(id.startsWith(".")?createRequire(filename)(id):webRequire(id)),
 },{filename});return result.exports;
}
async function main() {
 const routes=new Map<string,Function>();const app:any={};for(const m of ["get","post","put","patch","delete"])app[m]=(p:string,h:Function)=>routes.set(`${m.toUpperCase()} ${p}`,h);
 (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
 (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);
 (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);
 const {BusinessError}=await import("../apps/api/src/modules/core/business-error");
 async function call(key:string,body:any={},auth:any={userId:"staff",companyId:"c",role:"staff",name:"员工"},query:Record<string,string>={}) {
  const handler=routes.get(key);assert.ok(handler);let status=200;let raw:any;const res:any={status(s:number){status=s;return res},json(p:any){raw=p}};
  try {await handler({body,query,headers:{},auth},res);}catch(e){if(e instanceof BusinessError){status=e.httpStatus;raw={code:e.code,message:e.message}}else throw e;}return {status,raw,data:raw?.data};
 }
 const ADMIN={userId:"boss",companyId:"c",role:"admin",name:"管理员"};
 check("撤销误签收后，直接删除该业务轨迹应409且WD/子单/父单/旧记录不变",async()=>{
  reset([ship("P",0),ship("C",2,"P")]);for(const s of ships)s.currentStatus="delivered";
  deliveries=[{...delivery("lm1","C","WD000001","SIGNED"),signImageBase64:"proof"}];
  logs=[{id:"signedLog",companyId:"c",shipmentId:"C",fromStatus:"outForDelivery",toStatus:"delivered",changedAt:new Date(0)}];
  const unsign=await call("POST /admin/lastmile/unsign",{id:"lm1"},ADMIN);assert.equal(unsign.status,200);
  const unsignLog=logs.find(x=>x.id!=="signedLog")!;const before=copy({ships,deliveries,logs});
  for(const role of ["staff","admin"]){const deleted=await call("POST /staff/shipments/track/delete-log",{logId:unsignLog.id},{...ADMIN,role});assert.equal(deleted.status,409,JSON.stringify(deleted));assert.deepEqual({ships,deliveries,logs},before);}
  assert.ok(ships.every(s=>s.currentStatus==="outForDelivery"));assert.equal(deliveries[0].status,"DELIVERING");
 });
 check("普通轨迹仍可删除并回退，派送日志所有来源受保护",async()=>{
  for(const entry of [
    ["sl_lm_1",""],["sl_lmunsign_1",""],["sl_lmdel_1",""],
  ]) {
    reset([ship("S")]);logs=[{id:entry[0],remark:entry[1],companyId:"c",shipmentId:"S",fromStatus:"inWarehouseTH",toStatus:"outForDelivery",changedAt:new Date(1)}];
    const before=copy({ships,logs});assert.equal((await call("POST /staff/shipments/track/delete-log",{logId:entry[0]})).status,409);assert.deepEqual({ships,logs},before);
  }
  reset([ship("P",0),ship("C",2,"P")]);ships.forEach(s=>s.currentStatus="loaded");
  logs=[{id:"ordinary",companyId:"c",shipmentId:"C",fromStatus:"inWarehouseCN",toStatus:"loaded",changedAt:new Date(1)}];
  assert.equal((await call("POST /staff/shipments/track/delete-log",{logId:"ordinary"})).status,200);
  assert.equal(logs.length,0);assert.ok(ships.every(s=>s.currentStatus==="inWarehouseCN"));
 });
 check("普通柜子轨迹的用户备注含派送字样仍可删除",async()=>{
  reset([ship("S")]);ships[0].currentStatus="inWarehouseTH";
  logs=[{id:"sl_ctn_1",companyId:"c",shipmentId:"S",remark:"尾端派送前检查包装",fromStatus:"unloading",toStatus:"inWarehouseTH",changedAt:new Date(1)}];
  assert.equal((await call("POST /staff/shipments/track/delete-log",{logId:"sl_ctn_1"})).status,200);assert.equal(ships[0].currentStatus,"unloading");
 });
 check("锁内重读日志，不采信锁前状态；跨公司及客户无删除权限",async()=>{
  reset([ship("S")]);logs=[{id:"ordinary",companyId:"c",shipmentId:"S",remark:"普通",fromStatus:"inWarehouseTH",toStatus:"outForDelivery",changedAt:new Date(1)}];
  afterLock=()=>{logs=[];};assert.equal((await call("POST /staff/shipments/track/delete-log",{logId:"ordinary"})).status,404);assert.equal(logs.length,1);
  afterLock=()=>{};
  assert.equal((await call("POST /staff/shipments/track/delete-log",{logId:"ordinary"},{...ADMIN,companyId:"other"})).status,404);
  assert.equal((await call("POST /staff/shipments/track/delete-log",{logId:"ordinary"},{...ADMIN,role:"client"})).status,403);
 });
 check("真轨迹GET：父子日志删除能力与权限一致，真组件保留普通删除/隐藏派送删除",async()=>{
  reset([ship("P",0),ship("C",2,"P")]);
  logs=[{id:"sl_lmunsign_1",companyId:"c",shipmentId:"C",fromStatus:"delivered",toStatus:"outForDelivery",remark:"撤销误签收",changedAt:new Date(1),operatorRole:"admin",operatorName:"老板"},
    {id:"ordinary",companyId:"c",shipmentId:"P",fromStatus:"created",toStatus:"inWarehouseCN",remark:"入库",changedAt:new Date(0),operatorRole:"staff",operatorName:"员工"}];
  for(const role of ["admin","staff","client"]) {
    const r=await call("GET /client/shipments/track",{}, {...ADMIN,role,userId:role==="client"?"mark":"boss"},{trackingNo:"P"});assert.equal(r.status,200);
    assert.equal(r.data.timeline[0].canDelete,role!=="client");assert.equal(r.data.timeline[1].canDelete,false);assert.equal(r.data.children[0].timeline[0].canDelete,false);
    const mod=trackModule(false);const react=webRequire("react");
    const html=webRequire("react-dom/server").renderToStaticMarkup(react.createElement(mod.TrackContent,{data:r.data}));
    assert.equal((html.match(/>删除<\/button>/g)||[]).length,role==="client"?0:1);
  }
 });
 check("真公开弹窗：长短单号均用trackingNo，显式内部ID用shipmentId",async()=>{
  for(const target of [{trackingNo:"SHORT001"},{trackingNo:"LONG202609120000000000000001"},{trackingNo:"中文 运单/001?x=1"},{shipmentId:"internal-id"}]) {
    const requests:string[]=[];const mod=trackModule(true,requests);mod.openShipmentTrack(target);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,1);
    const url=new URL(requests[0]);assert.equal(url.searchParams.get(Object.keys(target)[0]),Object.values(target)[0]);assert.equal([...url.searchParams].length,1);
  }
 });
 let failures=0;for(const [name,fn] of cases){try{await fn();console.log("PASS "+name);}catch(e){failures++;console.log("FAIL "+name+"\n"+(e instanceof Error?e.stack:e));}}
 console.log(`CHECKS ${cases.length}; FAILURES ${failures}`);if(failures)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
