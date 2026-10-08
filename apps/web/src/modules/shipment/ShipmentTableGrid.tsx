/* 产品列共用固定宽度及 24px 行高；三行以内居中，更多产品由同一内表滚动。 */

import type { OrderProductItem } from "../../services/business-api";

/** 小表每行的高度；和可见行数一起决定每张运单占多高 */
export const DETAIL_ROW_HEIGHT = 24;
/** 不点开时露几行产品 */
export const DETAIL_VISIBLE_ROWS = 3;

const GRID_LINE = "1px solid var(--l-cool)";

/** 表头格子：四边都有框线 */
export const gridThStyle = {
  padding: "10px 8px",
  whiteSpace: "nowrap",
  border: GRID_LINE,
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

/** 数据格子：一单只有一个值的列，上下居中 */
export const gridTdStyle = {
  padding: "8px 6px",
  whiteSpace: "nowrap",
  border: GRID_LINE,
  verticalAlign: "middle",
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

/** 小表的格子：每行高度写死，各列才对得齐；超长用省略号，鼠标停上去看全 */
const detailCellStyle = {
  padding: "2px 6px",
  height: DETAIL_ROW_HEIGHT,
  boxSizing: "border-box",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  borderRight: GRID_LINE,
  borderBottom: "1px solid var(--s-cool-2)",
  color: "var(--t-strong)",
} as const;

const detailLastCellStyle = { ...detailCellStyle, borderRight: "none" } as const;

/**
 * 表格的列宽定义。
 * @param widths 每一列的宽度，个数必须等于表头 th 的个数
 * @param flexIndex 哪一列当弹性列（不写宽度，吃掉多余空间）
 */
export function GridColgroup({ widths, flexIndex }: { widths: readonly number[]; flexIndex: number }) {
  return (
    <colgroup>
      {widths.map((w, i) => (
        <col key={i} style={i === flexIndex ? undefined : { width: w }} />
      ))}
    </colgroup>
  );
}

/**
 * 跟着产品走的那几列：合并成一个格子，固定高度，整块一起滚。
 * @param widths 这几列的宽度，必须和外层 colgroup 里对应位置的数字完全一致
 * @param rows 每个产品一行，一行里每一列一个字符串
 */
export function ProductDetailCell({ widths, rows }: { widths: readonly number[]; rows: readonly string[][] }) {
  // 宽度写死成各列之和，不用 100%：Windows 的滚动条占宽度，
  // 用 100% 会被滚动条挤窄，列就和表头对不上了
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  /* 2026-09-03 老板拍板：项数不满 DETAIL_VISIBLE_ROWS 行时，内容**上下居中**。
     原来一律从顶上往下排，两项货就在格子底下空出一整行（老板圈的就是那块），
     而同一行右边的体积/重量/物流状态那几列是 verticalAlign: middle，两边差半行看着错位。
     一项、两项都按这条走。

     ⚠️ 满三行以上不能居中：flex 的 justify-content: center 配 overflow: auto 时，
        溢出的内容会从**顶上被切掉且滚不回去**（浏览器公认的老毛病）。
        所以要滚动的那种保持 flex-start，只有装得下的才居中。 */
  const needsScroll = rows.length > DETAIL_VISIBLE_ROWS;
  return (
    <td colSpan={widths.length} style={{ padding: 0, border: GRID_LINE, verticalAlign: "top" }}>
      <div
        style={{
          height: DETAIL_ROW_HEIGHT * DETAIL_VISIBLE_ROWS,
          overflowY: needsScroll ? "auto" : "hidden",
          overflowX: "hidden",
          display: "flex",
          flexDirection: "column",
          justifyContent: needsScroll ? "flex-start" : "center",
        }}
      >
        <table className="a3-table shipment-product-table" style={{ width: totalWidth, borderCollapse: "collapse", tableLayout: "fixed", fontSize: 13 }}>
          <colgroup>
            {widths.map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <tbody>
            {rows.map((cells, i) => {
              /* 最后一行不画下边框：居中之后那条线会悬在格子中间，像断了一截。
                 满三行时它本来就跟格子底边重合，去掉也看不出区别。 */
              const isLastRow = i === rows.length - 1;
              return (
                <tr key={i}>
                  {cells.map((v, j) => {
                    const base = j === cells.length - 1 ? detailLastCellStyle : detailCellStyle;
                    return (
                      <td key={j} title={v} style={isLastRow ? { ...base, borderBottom: "none" } : base}>
                        {v}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </td>
  );
}

/** 货型的中文名，三端口径一致 */
export function cargoTypeLabelOf(value?: string | null) {
  const v = (value ?? "normal").toLowerCase();
  return v === "inspection" ? "商检货" : v === "sensitive" ? "敏感货" : "普货";
}

/* -------------------------------------------------------------------------
   员工端和管理员端的明细列完全一样：品名 / 箱数 / 单箱数量 / 长宽高 / 国内单号 / 货型
   ------------------------------------------------------------------------- */

export const PRODUCT_DETAIL_COL_WIDTHS = [180, 70, 90, 150, 150, 70] as const;
export const PRODUCT_DETAIL_HEADS = ["品名", "箱数", "单箱数量", "长宽高(cm)", "国内单号", "货型"] as const;

const PRODUCT_LIST_COL_INDEXES = [0, 1, 3, 4, 5] as const;
export const PRODUCT_LIST_COL_WIDTHS = PRODUCT_LIST_COL_INDEXES.map((i) => PRODUCT_DETAIL_COL_WIDTHS[i]);

/** 主列表省略单箱数量；完整明细仍保留六列，数据及导出口径不变。 */
export function ProductListDetailCell({ rows }: { rows: readonly string[][] }) {
  return <ProductDetailCell widths={PRODUCT_LIST_COL_WIDTHS} rows={rows.map((row) => PRODUCT_LIST_COL_INDEXES.map((i) => row[i]))} />;
}


type ProductCarrier = {
  products?: OrderProductItem[];
  itemName?: string | null;
  domesticTrackingNo?: string | null;
  cargoType?: string | null;
  /** 整票的包装单位（bag / box）；产品行没有自己的单位，跟整票走 */
  packageUnit?: string | null;
};

/**
 * 包装单位中文（2026-10-08 模拟数据测试）：袋装的单员工端 / 超管端原来写死「箱」，客户端写「袋」，同一票货三端对不上。
 * 只有 bag / box 两个值（domain-dictionary），没填按箱（同后端 packageUnit 默认 box）。
 */
export function packageUnitZh(unit: string | null | undefined): "袋" | "箱" {
  return unit === "bag" ? "袋" : "箱";
}

/** 摊成小表的行；没有产品行的老运单退回用运单自己的字段，显示口径和改版前一致 */
export function buildProductDetailRows(item: ProductCarrier): string[][] {
  const products = item.products ?? [];
  const unit = packageUnitZh(item.packageUnit);
  if (products.length > 0) {
    return products.map((p) => [
      p.itemName ?? "—",
      knownPackageCount(p.packageCount) != null ? `${p.packageCount}${unit}` : "—",
      p.productQuantity ? `${p.productQuantity}个/${unit}` : "—",
      // 长宽高是三个独立输入框，可以只填一个 —— 原来只看长，只填长时会拼出「60×null×nullcm」。
      // 跟客户端口径一致：三个都有才拼，缺任何一个显示「—」
      p.lengthCm && p.widthCm && p.heightCm ? `${p.lengthCm}×${p.widthCm}×${p.heightCm}cm` : "—",
      p.domesticTrackingNo || "货拉拉",
      cargoTypeLabelOf(p.cargoType),
    ]);
  }
  return [[
    item.itemName || "—",
    "—",
    "—",
    "—",
    item.domesticTrackingNo || "—",
    cargoTypeLabelOf(item.cargoType),
  ]];
}

/**
 * 整单箱数。按这个顺序取（修复第 3 轮起 totalPackageCount 排第一，理由见下面最后一个 ⚠️）：
 *   1. totalPackageCount —— 后端算好的「父单剩余 + 全部子单」，就是整单箱数（员工 / 超管列表接口的父单才有）
 *   2. 上面小表里「箱数」那一列加起来 —— 多产品的运单「箱数」是一个产品一行，员工要自己心算总数，这里直接算好
 *   3. packageCount
 *
 * ⚠️ 口径是「到国内仓的总箱数」，**不是「还剩多少没装柜」**。
 *    已经装走一部分的运单，这个数不会跟着变少。两者的区别见
 *    docs/交接文档-2026-08-10-完整版.md 第 5.1 节。
 *
 * ⚠️ 员工端千万不能直接退到 packageCount：那张表上的 packageCount 是
 *    **还剩没装**，装走一批就少一批，标成「总箱数」是错的。
 *    客户端的 packageCount 是订单上的整单箱数，退到它才对 ——
 *    两边同名不同义，所以这里必须先看 totalPackageCount。
 *    （2026-09-28 核对更正：管理员端列表接口给的 packageCount 也是**运单上的**，
 *    拆过柜的父单同样是剩余量，不是整单箱数。导出一律走这个函数，别直接读 packageCount。）
 *
 * ⚠️ 产品行合计跟后端给的整票数 totalPackageCount 对不上时，听 totalPackageCount（2026-10-08 到货通知修复第 3 轮）：
 *    多产品行的预报单在「预报单审核」确认收货时改了件数（客户报 玩具 3 + 文具 4 = 7、实收 9），
 *    后端只在**只有一个**产品行时替人改那一行，两行以上不猜 —— 订单、运单是 9，产品行合计还是 7。
 *    原来这里只看产品行：员工列表 / 导出 / 超管列表 / 超管详情写 7，员工详情和客户端写 9，同一票货两个数。
 *    totalPackageCount = 父单剩余 + 全部子单（只有父单才有），是仓库实收口径；两者一致时（绝大多数单）结果不变。
 *    产品行那几格照旧显示客户报的 3、4，打印标签那边会拦住「产品行合计对不上件数」，提醒去改产品行。
 */
export function totalPackageCountOf(
  item: ProductCarrier & { packageCount?: number | null; totalPackageCount?: number | null },
): number | null {
  // 0 也当「没填」（2026-10-08 到货通知审查 F03）：拆过柜的父单剩 0 时 totalPackageCount 仍是整票数（> 0），不受影响
  const total = knownPackageCount(item.totalPackageCount);
  // 后端算好了整票数就听它（上面 ⚠️ 修复第 3 轮）：跟产品行合计一致时是同一个数，不一致时它才是实收
  if (total != null) return total;
  const products = item.products ?? [];
  if (products.length > 0) {
    const counts = products
      .map((p) => knownPackageCount(p.packageCount))
      .filter((n): n is number => n != null);
    // 一行都没填箱数时不要显示 0，那会让人以为真的一箱都没有
    if (counts.length > 0) return counts.reduce((a, b) => a + b, 0);
  }
  return knownPackageCount(item.packageCount);
}

/**
 * 员工端「运单详情（只读）」里件数 / 重量 / 体积那几格（修复第 1 轮，2026-10-08）。
 * 父单自己的 packageCount / weightKg / volumeM3 是**剩余量**（拆柜、部分装柜后从父单扣掉），原来详情直接显示它：
 * 列表「总箱数」写 10、点开详情「总件数」写 0 或 4，「总重量」也是剩下的。跟列表、导出一样按整票说
 * （totalPackageCountOf / totalWeightOf / totalVolumeOf）。没有的给空串（输入框显示空，待入库那格另有「未填」占位）。
 * 只管显示：别拿它去改编辑草稿（草稿里的 packageCount 保存时当剩余量写回去）。
 *
 * 件数先听后端算的整票数 totalPackageCount（父单剩余 + 全部子单，是仓库实收口径）（修复第 2 轮，2026-10-08）：
 * 多产品行的预报单确认收货时改了件数（客户报 7、实收 9），只改订单和运单、产品行还是 7。
 * 修复第 3 轮起列表 / 导出 / 超管详情用的 totalPackageCountOf 也先听它，这里直接调同一个函数，两边不会再一个 7 一个 9。
 */
export function shipmentDetailTotalsText(
  item: ProductCarrier & { packageCount?: number | null; totalPackageCount?: number | null; weightKg?: number | null; totalWeightKg?: number | null; volumeM3?: number | null; totalVolumeM3?: number | null },
): { packageCount: string; weightKg: string; volumeM3: string } {
  const s = (n: number | null) => (n == null ? "" : String(n));
  const packageCount = totalPackageCountOf(item);
  return { packageCount: s(packageCount), weightKg: s(totalWeightOf(item)), volumeM3: s(totalVolumeOf(item)) };
}

/**
 * 件数「填了没有」（2026-10-08 到货通知审查 F03）。
 * 箱数在系统里只可能是正整数（建单、改单、产品行都卡正整数）；0 / null / 非数字一律当「还没填」。
 * 到货通知「转待入库」时件数可以先空着：运单存 null，订单表这一列不许为空只能存 0 ——
 * 显示成「0 箱」客户会以为货丢了。后端不同接口给 0 或 null，前端一律用这个判断。
 */
export function knownPackageCount(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/** 「12 箱」/「—」：件数没填就只显示「—」，不带单位 */
export function packageCountText(n: unknown, unit: string): string {
  const v = knownPackageCount(n);
  return v != null ? `${v} ${unit}` : "—";
}

/**
 * 整票体积。
 *
 * totalVolumeM3 由列表接口按「订单合计 → 父子单家族合计」算好；
 * 老接口或无合计值时才退回当前运单字段。显式 0 是有效数值，保留不丢。
 */
export function totalVolumeOf(
  item: { volumeM3?: number | null; totalVolumeM3?: number | null },
): number | null {
  if (typeof item.totalVolumeM3 === "number" && Number.isFinite(item.totalVolumeM3)) {
    return item.totalVolumeM3;
  }
  return typeof item.volumeM3 === "number" && Number.isFinite(item.volumeM3) ? item.volumeM3 : null;
}

/** 整票重量；取值顺序与 totalVolumeOf 一致。 */
export function totalWeightOf(
  item: { weightKg?: number | null; totalWeightKg?: number | null },
): number | null {
  if (typeof item.totalWeightKg === "number" && Number.isFinite(item.totalWeightKg)) {
    return item.totalWeightKg;
  }
  return typeof item.weightKg === "number" && Number.isFinite(item.weightKg) ? item.weightKg : null;
}
