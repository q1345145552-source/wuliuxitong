import type { AdminOrderItem } from "../../services/business-api";
import { formatMetric, shipmentStatusZh, transportModeLabel } from "../../modules/staff/utils";
import {
  buildProductDetailRows, PRODUCT_DETAIL_HEADS,
  totalPackageCountOf, totalVolumeOf, totalWeightOf,
} from "../../modules/shipment/ShipmentTableGrid";

const display = (value: string | number | null | undefined) =>
  typeof value === "string" ? value.trim() || "—" : value ?? "—";

type DetailOrder = Pick<AdminOrderItem,
  "orderNo" | "clientName" | "clientId" | "currentStatus" | "transportMode" |
  "shipDate" | "createdAt" | "packageUnit" | "packageCount" | "productQuantity" |
  "volumeM3" | "weightKg" | "totalVolumeM3" | "totalWeightKg" |
  "products" | "itemName" | "domesticTrackingNo" | "cargoType" | "receiverAddressTh" | "remark"
>;

export default function AdminShipmentDetail({ order, warehouseLabel }: { order: DetailOrder; warehouseLabel: string }) {
  const fields = [
    ["唛头", display(order.clientName?.trim() || order.clientId)],
    ["物流状态", shipmentStatusZh(order.currentStatus)],
    ["运输方式", display(transportModeLabel(order.transportMode))],
    ["仓库", display(warehouseLabel)],
    ["到仓日期", display(order.shipDate ?? order.createdAt?.slice(0, 10))],
    ["订单号", display(order.orderNo)],
    ["包装", order.packageUnit === "bag" ? "袋" : "箱"],
    ["总箱数", display(totalPackageCountOf(order))],
    ["产品数量", display(order.productQuantity)],
    ["总体积 (m³)", formatMetric(totalVolumeOf(order), 3)],
    ["总重量 (kg)", formatMetric(totalWeightOf(order), 2)],
  ];
  const rows = buildProductDetailRows(order);
  return (
    <div className="admin-shipment-detail">
      <section aria-label="运单信息">
        <h3>运单信息</h3>
        <dl className="shipment-detail-fields">
          {fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <dl className="shipment-detail-notes">
          <div><dt>收货地址</dt><dd>{display(order.receiverAddressTh)}</dd></div>
          <div><dt>备注</dt><dd>{display(order.remark)}</dd></div>
        </dl>
      </section>
      <section aria-label="产品明细">
        <h3>产品明细</h3>
        <div className="shipment-detail-products" tabIndex={0} role="region" aria-label="产品明细表，可滚动查看">
          <table>
            <thead><tr>{[...PRODUCT_DETAIL_HEADS, "重量(kg)"].map((head) => <th key={head} scope="col">{head}</th>)}</tr></thead>
            <tbody>{rows.map((cells, index) => {
              const product = order.products?.[index];
              return <tr key={product?.id ?? index}>
                {cells.map((value, column) => <td key={column}>{column === 2 && product?.productQuantity != null ? `${product.productQuantity}个/箱` : display(value)}</td>)}
                <td>{formatMetric(product?.weightKg, 2)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
