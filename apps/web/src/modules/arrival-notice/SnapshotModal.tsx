"use client";

/**
 * 「看转运单时的原样」弹窗（2026-10-19 老板选 B）：转正式运单那一刻存下的到货通知，只能看、不能改；
 * 跟卡片现在的样子逐项比，不一样的标出来。运单被删、重转过的会有好几份，新的在前、都标着时间。
 * 不做「恢复成原样」（老板认可的：运单可能已经装柜、派送，一键改回去容易把后来改对的冲掉；要改回去照着原样到「运单管理」改）。
 */
import { useEffect, useState } from "react";
import DetailModal from "../layout/DetailModal";
import { fetchArrivalNoticeSnapshots, type ArrivalNotice, type ArrivalNoticeSnapshot } from "../../services/arrival-notice-api";
import { snapshotChangeCount, snapshotMetaRows, snapshotProductRows, type SnapshotDiffRow } from "./snapshot-diff";

function when(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

function DiffTable(props: { rows: SnapshotDiffRow[] }) {
  if (props.rows.length === 0) return <p className="an-muted">产品未登记</p>;
  return (
    <table className="an-snap-table">
      <thead>
        <tr><th scope="col">项目</th><th scope="col">转运单时</th><th scope="col">现在</th></tr>
      </thead>
      <tbody>
        {props.rows.map((r) => (
          <tr key={r.label} className={r.changed ? "is-changed" : undefined}>
            <th scope="row">{r.label}{r.changed ? <span className="an-snap-flag">改过</span> : null}</th>
            <td className={r.was ? undefined : "is-empty"}>{r.was || "未填"}</td>
            <td className={r.now ? undefined : "is-empty"}>
              {/* 没改过、写法也一样才写「同左」；没改过但写法不一样（「货拉拉」同步成没填那种）照写现在的 */}
              {r.changed || r.now !== r.was ? (r.now || "（现在没有）") : "同左"}
              {r.details?.length ? (
                <ul className="an-snap-details" aria-label="改了哪几项">
                  {r.details.map((d) => <li key={d}>{d}</li>)}
                </ul>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function SnapshotModal(props: {
  /** 点的那张卡片（拿 id；标题在读回来之前先用它的运单号） */
  notice: ArrivalNotice;
  onClose: () => void;
}) {
  const { notice, onClose } = props;
  /* 原样和「现在」是同一个请求读回来的：现在 = 后端按这条到货通知现读的那份（跟列表卡片同一个口径），
     不拿列表里那张 —— 弹窗开着时列表刷新、这张被搜索条件 / 翻页挤掉，打开时那份旧的会冒充「现在」（审查第 1 轮 Codex） */
  const [loaded, setLoaded] = useState<{ items: ArrivalNoticeSnapshot[]; current: ArrivalNotice } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    // 每打开一次是一个新的弹窗（父组件按次数给 key）；关掉以后晚回来的不管
    let alive = true;
    fetchArrivalNoticeSnapshots(notice.id)
      .then((r) => {
        if (!alive) return;
        // 后端一定回 current；没有说明前后端版本没对上（上线那几秒），不拿旧卡片凑数
        if (!r.current) { setError("页面版本跟后台不一致，请刷新页面再点"); return; }
        setLoaded({ items: r.items ?? [], current: r.current });
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "没读出来，请稍后再点一次"); });
    return () => { alive = false; };
  }, [notice.id]);

  const items = loaded?.items ?? null;
  const current = loaded?.current ?? null;
  return (
    <DetailModal title="转运单时的原样" subtitle={current?.trackingNo ?? notice.trackingNo ?? null} onClose={onClose}>
      <div className="an-snap">
        <p className="an-muted">这是点「转正式运单」那一刻到货通知上登记的内容，只能看、不能改；跟现在（打开这个窗口时）不一样的地方标了「改过」。要改回去，照着这里到「运单管理」里改。</p>
        {error ? <p className="an-missing">读原样失败：{error}</p> : null}
        {!error && items === null ? <p className="an-muted">读取中…</p> : null}
        {items !== null && items.length === 0 ? <p className="an-muted">这条没有存原样（上线前转的）。</p> : null}
        {current && items?.map((s, i) => {
          const changes = s.data ? snapshotChangeCount(s.data, current) : 0;
          return (
            <section key={s.id} className="an-snap-one" aria-label={`第 ${i + 1} 份原样`}>
              <h4>
                {/* 好几份时按先后编号（第 1 次最早），最新那份再标「最近一次」（审查第 2 轮 dsh：三份以上原来都叫「更早一次」） */}
                {items.length > 1 ? `第 ${items.length - i} 次转运单${i === 0 ? "（最近一次）" : ""}：` : ""}
                {when(s.convertedAt)}{s.convertedByName ? ` · ${s.convertedByName} 转的` : ""}
                <span className={changes > 0 ? "an-snap-count is-changed" : "an-snap-count"}>{s.data ? (changes > 0 ? `有 ${changes} 处跟现在不一样` : "跟现在一样") : ""}</span>
              </h4>
              {s.data ? (
                <>
                  <DiffTable rows={snapshotMetaRows(s.data, current)} />
                  <DiffTable rows={snapshotProductRows(s.data, current)} />
                </>
              ) : <p className="an-missing">这一份读不出来（存的内容坏了），请告诉技术。</p>}
            </section>
          );
        })}
      </div>
    </DetailModal>
  );
}
