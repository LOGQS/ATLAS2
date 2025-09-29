// status: alpha

import React, { useMemo } from 'react';
import '../../styles/agentic/LLMMonitor.css';
import { ToolCallEntry } from '../../utils/agentic/PlanStore';

interface LLMMonitorProps {
  calls: ToolCallEntry[];
}

const LLMMonitor: React.FC<LLMMonitorProps> = ({ calls }) => {
  const ordered = useMemo(() => [...calls].slice().reverse(), [calls]);
  const totalCalls = ordered.length;

  if (totalCalls === 0) {
    return null;
  }

  return (
    <section className="llm-monitor" aria-label="Tool call monitor">
      <header className="llm-monitor__header">
        <strong>Tool Calls</strong>
        <span className="llm-monitor__badge">{totalCalls} total</span>
      </header>
      <div className="llm-monitor__table-wrapper">
        <table className="llm-monitor__table">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Latency</th>
              <th scope="col">Tokens</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map(call => {
              const providerMeta = [call.provider, call.model].filter(Boolean).join(' · ');
              const latencyLabel = `${call.latencyMs.toLocaleString()} ms`;
              const tokenLabel = typeof call.tokens === 'number' ? call.tokens.toLocaleString() : '';
              const costLabel = typeof call.cost === 'number' ? `$${call.cost.toFixed(4)}` : '';

              return (
                <tr key={call.id}>
                  <td>
                    <div className="llm-monitor__tool">{call.tool}</div>
                    {providerMeta && <div className="llm-monitor__provider">{providerMeta}</div>}
                  </td>
                  <td className="llm-monitor__cell llm-monitor__cell--numeric">{latencyLabel}</td>
                  <td className="llm-monitor__cell llm-monitor__cell--numeric">{tokenLabel}</td>
                  <td className="llm-monitor__cell llm-monitor__cell--numeric">{costLabel}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default LLMMonitor;
