import {useEffect, useMemo, useState} from "react";
import {supabase} from "../lib/supabase";
import type {Observation} from "../types";

export function Trends({refreshKey}: {refreshKey: number}) {
  const [observations, setObservations] = useState<Observation[]>([]);
  useEffect(() => {
    void supabase
      .from("trusted_observations")
      .select("*")
      .order("observed_at")
      .then(({data}) => setObservations((data || []) as Observation[]));
  }, [refreshKey]);

  const summary = useMemo(() => {
    const grouped = new Map<string, number[]>();
    for (const item of observations) {
      if (item.numeric_value === null) continue;
      const values = grouped.get(item.type_code) || [];
      values.push(item.numeric_value);
      grouped.set(item.type_code, values);
    }
    return Array.from(grouped, ([name, values]) => ({
      name,
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      count: values.length,
      latest: values.at(-1) || 0,
    }));
  }, [observations]);

  return (
    <section className="page">
      <header className="page-header">
        <div><span className="eyebrow">Descriptive only</span><h1>Symptom trends</h1></div>
        <p>These summaries show recorded observations; they do not identify causes.</p>
      </header>
      <div className="metric-grid">
        {summary.map((metric) => (
          <article className="metric card" key={metric.name}>
            <span>{metric.name}</span><strong>{metric.latest.toFixed(0)}<small>/10 latest</small></strong>
            <div className="bar"><i style={{width: `${metric.mean * 10}%`}} /></div>
            <p>{metric.mean.toFixed(1)} average · {metric.count} observations</p>
          </article>
        ))}
      </div>
      {summary.length === 0 && <div className="empty"><h2>No trusted symptom data yet</h2><p>Complete a skin check to start a trend.</p></div>}
    </section>
  );
}

