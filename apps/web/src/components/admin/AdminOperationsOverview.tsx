import type { AdminOpsOverview, AdminOverview } from "../../services/business-api";
import styles from "./AdminOperationsOverview.module.css";

export interface AdminShipmentCounts {
  processing: number;
  inTransit: number;
  atWarehouse: number;
  delivered: number;
  exception: number;
}

export interface AdminOperationsOverviewProps {
  overview: AdminOverview | null;
  opsOverview: AdminOpsOverview | null;
  shipmentCounts: AdminShipmentCounts | null;
  overviewError?: boolean;
  ordersError?: boolean;
  opsError?: boolean;
}

type Metric = {
  label: string;
  value: number | null | undefined;
  unit: string;
  decimals?: number;
};

function formatNumber(value: number | null | undefined, decimals?: number) {
  if (value == null || !Number.isFinite(value)) return "—";
  return decimals == null ? value.toLocaleString("zh-CN") : value.toFixed(decimals);
}

function MetricList({ metrics, className }: { metrics: Metric[]; className: string }) {
  return (
    <dl className={`${styles.metrics} ${className}`}>
      {metrics.map((metric) => (
        <div className={styles.metric} key={metric.label}>
          <dt>{metric.label}</dt>
          <dd>
            <span className={styles.value}>{formatNumber(metric.value, metric.decimals)}</span>
            {" "}<span className={styles.unit}>{metric.unit}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function transportLabel(mode: string) {
  return mode === "land" ? "陆运" : mode === "sea" ? "海运" : mode || "运输方式未提供";
}

function stalledReason(container: AdminOverview["stalledContainers"][number]) {
  if (container.reason === "overdue") {
    return container.loadedDays == null
      ? "超期未到仓（装柜天数未提供）"
      : `装柜 ${container.loadedDays} 天未到仓`;
  }
  return container.idleDays == null
    ? "长时间未更新（天数未提供）"
    : `${container.idleDays} 天未更新状态`;
}

function customsStatusLabel(status: string) {
  return status === "inspection" ? "查验" : status === "pending" ? "待处理" : status === "released" ? "放行" : status;
}

/** 仅展示已有接口结果；订单、运单、柜子各用自己的口径，不在这里重新统计。 */
export default function AdminOperationsOverview({
  overview,
  opsOverview,
  shipmentCounts,
  overviewError = false,
  ordersError = false,
  opsError = false,
}: AdminOperationsOverviewProps) {
  // 旧 API 缺字段不等于成功返回空列表，不能据此显示「没有卡住的柜子」。
  const stalledContainers = Array.isArray(overview?.stalledContainers) ? overview.stalledContainers : null;
  const customsAlerts = Array.isArray(opsOverview?.customsAlerts) ? opsOverview.customsAlerts : null;
  const supplierPriceAlerts = Array.isArray(opsOverview?.supplierPriceAlerts) ? opsOverview.supplierPriceAlerts : null;

  return (
    <div className={styles.overview}>
      <div className={styles.heading}>
        <div>
          <h2>运营看板</h2>
          <p className={styles.scope}>普通订单、运单与柜子；不含两种集货业务。</p>
        </div>
        <p className={styles.accounts}>
          <span>员工账号 <b>{formatNumber(overview?.staffAccountCount)}</b> 个</span>
          <span>客户账号 <b>{formatNumber(overview?.clientAccountCount)}</b> 个</span>
        </p>
      </div>

      {overviewError ? (
        <p className={styles.error} role="status">
          {overview ? "总览更新失败，今日数字、柜子进度及卡住的柜子保留上次结果。" : "总览加载失败，今日数字和柜子信息暂不可用。请刷新页面重试。"}
        </p>
      ) : !overview ? <p className={styles.message} role="status">总览数据加载中…</p> : null}

      <MetricList
        className={styles.summaryMetrics}
        metrics={[
          { label: "今日新增订单", value: overview?.newOrderCountToday, unit: "单" },
          { label: "今日收货体积", value: overview?.receivedVolumeM3Today, unit: "m³", decimals: 1 },
          { label: "当前在途运单", value: overview?.inTransitOrderCount, unit: "票" },
        ]}
      />
      <p className={styles.note}>收货体积按今日新建的普通父运单统计；当前在途为全部普通父运单中的在途数量。</p>

      <div className={styles.attention} role="region" aria-labelledby="overview-stalled-heading">
        <div className={styles.sectionHeading}>
          <h3 id="overview-stalled-heading">卡住的柜子{stalledContainers?.length ? <span className={styles.count}>展示 {stalledContainers.length} 个</span> : null}</h3>
          <a className={styles.link} href="/staff/container-loading">查看装柜管理 →</a>
        </div>
        {stalledContainers == null ? (
          <p className={styles.message}>
            {overview ? "暂未提供卡住的柜子数据，无法判断是否存在超期。" : overviewError ? "卡住的柜子数据加载失败，无法判断是否存在超期。" : "卡住的柜子数据加载中…"}
          </p>
        ) : stalledContainers.length === 0 ? (
          <p className={styles.message}>{overviewError ? "上次结果：暂无超期或长时间未推进的柜子。" : "暂无超期或长时间未推进的柜子。"}</p>
        ) : (
          <>
            <ul className={styles.stalledList}>
              {stalledContainers.map((container) => (
                <li key={container.containerNo}>
                  <div className={styles.containerInfo}>
                    <strong className={styles.identifier}>{container.containerNo}</strong>
                    <div className={styles.details}>
                      <span>{transportLabel(container.transportMode)}</span>
                      <span>{formatNumber(container.shipmentCount)} 票货</span>
                      <span>当前：{container.currentStatusZh || container.currentStatus || "状态未提供"}</span>
                    </div>
                  </div>
                  <p className={styles.reason}>{stalledReason(container)}</p>
                </li>
              ))}
            </ul>
            <p className={styles.note}>
              {stalledContainers.length >= 10 ? "接口最多返回 10 个，当前展示数量不代表全部。" : "展示本次接口返回的柜子列表。"}
              {" "}海运：装柜超 21 天未到仓或超 14 天未更新；陆运均为超 7 天。已到泰国仓的不计入。
            </p>
          </>
        )}
      </div>

      <div className={styles.progress} role="region" aria-labelledby="overview-shipments-heading">
        <div className={styles.sectionHeading}>
          <h3 id="overview-shipments-heading">运单进度</h3>
          <a className={styles.link} href="/admin#orders">查看运单管理 →</a>
        </div>
        <p className={styles.note}>按当前已加载的普通运单列表统计，不代表全部柜子的货量。</p>
        {ordersError ? (
          <p className={styles.error} role="status">{shipmentCounts ? "运单进度更新失败，以下保留上次结果。" : "运单进度加载失败，数量暂不可用。请刷新页面重试。"}</p>
        ) : !shipmentCounts ? <p className={styles.message} role="status">运单进度加载中…</p> : null}
        <MetricList
          className={styles.shipmentMetrics}
          metrics={[
            { label: "未发出", value: shipmentCounts?.processing, unit: "票" },
            { label: "在途", value: shipmentCounts?.inTransit, unit: "票" },
            { label: "已到泰国仓", value: shipmentCounts?.atWarehouse, unit: "票" },
            { label: "已签收", value: shipmentCounts?.delivered, unit: "票" },
            { label: "异常/其他", value: shipmentCounts?.exception, unit: "票" },
          ]}
        />
      </div>

      <div className={styles.progress} role="region" aria-labelledby="overview-containers-heading">
        <div className={styles.sectionHeading}>
          <h3 id="overview-containers-heading">柜子进度<span className={styles.count}>共 {formatNumber(overview?.containerTotalCount)} 个柜</span></h3>
          <a className={styles.link} href="/staff/container-loading">查看装柜管理 →</a>
        </div>
        <MetricList
          className={styles.containerMetrics}
          metrics={[
            { label: "装柜中", value: overview?.containerLoadingCount, unit: "个柜" },
            { label: "在路上", value: overview?.containerOnTheWayCount, unit: "个柜" },
            { label: "已到泰国仓", value: overview?.containerAtWarehouseCount, unit: "个柜" },
            { label: "已完成", value: overview?.containerDoneCount, unit: "个柜" },
          ]}
        />
        <p className={styles.note}>按柜子本身的状态统计；已到泰国仓包含预约派送、派送中的柜子。</p>
      </div>

      {opsError ? (
        <p className={styles.error} role="status">{opsOverview ? "关务与报价提醒更新失败，以下保留上次返回结果。" : "关务与报价提醒加载失败，暂不能判断是否有待处理事项。请刷新页面重试。"}</p>
      ) : !opsOverview ? (
        <p className={styles.message} role="status">关务与报价提醒加载中…</p>
      ) : customsAlerts == null || supplierPriceAlerts == null ? (
        <p className={styles.message}>关务或报价提醒数据未完整提供，不能据此判断没有待处理事项。</p>
      ) : null}

      {customsAlerts && customsAlerts.length > 0 ? (
        <div className={styles.alertSection} role="region" aria-labelledby="overview-customs-heading">
          <div className={styles.sectionHeading}>
            <h3 id="overview-customs-heading">关务查验预警<span className={styles.count}>展示 {customsAlerts.length} 条</span></h3>
          </div>
          <p className={styles.note}>以下为接口返回的提醒列表，并非全量关务记录。</p>
          <ul className={styles.alertList}>
            {customsAlerts.map((alert) => (
              <li key={alert.id}>
                <div className={styles.details}>
                  <strong>{customsStatusLabel(alert.status)}</strong>
                  <span>运单 {alert.shipmentTrackingNo ?? alert.shipmentId ?? "未关联"}</span>
                </div>
                <p>{alert.remark || "无备注"}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {supplierPriceAlerts && supplierPriceAlerts.length > 0 ? (
        <div className={styles.alertSection} role="region" aria-labelledby="overview-prices-heading">
          <div className={styles.sectionHeading}>
            <h3 id="overview-prices-heading">供应商报价变化提醒<span className={styles.count}>展示 {supplierPriceAlerts.length} 条</span></h3>
          </div>
          <p className={styles.note}>以下为接口返回的变化列表，并非全量报价记录；只比较同一路线、供应商、运输方式、季节和币种。</p>
          <ul className={styles.alertList}>
            {supplierPriceAlerts.map((alert) => (
              <li key={JSON.stringify([alert.routeCode, alert.supplierName, alert.transportMode, alert.seasonTag, alert.currency, alert.updatedAt])}>
                <div className={styles.details}>
                  <strong>{alert.routeCode}</strong>
                  <span>{alert.supplierName}</span>
                  <span>{transportLabel(alert.transportMode)}</span>
                  <span>{alert.seasonTag || "季节未提供"}</span>
                </div>
                <p className={styles.price}>
                  {alert.currency} {formatNumber(alert.previousQuotePrice, 2)} → {formatNumber(alert.latestQuotePrice, 2)}
                  {" "}<strong>（变动 {alert.delta > 0 ? "+" : ""}{formatNumber(alert.delta, 2)} {alert.currency}）</strong>
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
