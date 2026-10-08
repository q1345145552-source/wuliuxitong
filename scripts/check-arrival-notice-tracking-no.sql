-- 到货通知运单号体检（2026-10-08 到货通知修复第 3 轮）—— 纯只读，一个字都不改。
--
-- 为什么要有：20261008_arrival_notice_fixes 迁移末尾的回填，会把「转了运单、又在运单管理改过号」的老到货通知
-- 改成运单现在的号，但按设计跳过两种：
--   ① 运单现在的号被同公司另一条到货通知登记着（最常见：一条还没转的）；
--   ② 两张运单互换了号（P1↔P2），谁都腾不出来；以及一张运单挂着不止一条到货通知的。
-- prisma migrate deploy 只打印「successfully applied」，不说跳过了几条；上线以后列表按运单现在的号显示，
-- 会出现两张卡片都是同一个号、按号搜只搜得到没转的那条、没转的那条点「转运单」被挡「已经有运单了」。
-- 之后保存那张运单也只往服务器日志写一条 warn，员工看不到。所以部署完跑一遍这里，有结果就交给员工手工处理：
--   · holder_converted_to 是空的（占着号的那条还没转）：到「到货通知」搜 shipment_tracking_no（= 运单现在的号），
--     把那条的运单号改掉或删掉，再到「运单管理」把 shipment_id 这张运单保存一次，这条到货通知就会跟上；
--   · holder_converted_to 有值（两张运单互换了号，两条到货通知都已转、在到货通知里改不了）：到「运单管理」
--     先把其中一张运单改成一个没用过的临时号保存，再把另一张原样保存一次，最后把第一张改回它该用的号保存；
--   · holder_notice_id 是空的却仍在这里：一张运单挂着不止一条到货通知，或者跟号时出了错，找开发看。
--
-- 不进 deploy.sh（2026-10-08 主控决定：部署脚本不为一次性的老数据体检改动；而且 deploy.sh 开头 cp "$0" 跑的是旧副本，
-- 加进去引入它的那一次部署也不会跑）。带 20261008 迁移的那次部署跑完以后，在服务器上**手工跑一遍**（只读）：
--   cd /root/MyWebSite && docker compose exec -T postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -t -A -q -F " | "' < scripts/check-arrival-notice-tracking-no.sql
-- 没有输出 = 都对得上；有输出就按上面的说明交给员工。别靠紧接着再跑一遍 bash deploy.sh 补：没有新提交它会直接退出。
-- 列名都核过库（tracking_no / shipment_id / converted_to / company_id / client_id 都有 @map，教训 26）。
SELECT n.company_id,
       n.id           AS notice_id,
       n.client_id,
       n.tracking_no  AS notice_tracking_no,
       s.id           AS shipment_id,
       s.tracking_no  AS shipment_tracking_no,
       h.id           AS holder_notice_id,
       h.converted_to AS holder_converted_to
  FROM arrival_notices AS n
  JOIN shipments AS s ON s.id = n.shipment_id AND s.company_id = n.company_id
  LEFT JOIN arrival_notices AS h ON h.company_id = n.company_id AND h.tracking_no = s.tracking_no AND h.id <> n.id
 WHERE n.converted_to IS NOT NULL
   AND n.tracking_no IS DISTINCT FROM s.tracking_no
 ORDER BY n.company_id, n.id;
