-- 将订单级别的货型同步到产品行（仅更新仍为默认值 NORMAL 的产品行）
UPDATE order_products
SET cargo_type = o.cargo_type
FROM orders o
WHERE order_products.order_id = o.id
  AND order_products.cargo_type = 'NORMAL'
  AND o.cargo_type != 'NORMAL';
