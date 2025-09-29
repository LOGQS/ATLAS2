// status: alpha

import React from 'react';
import '../../styles/agentic/LLMMonitor.css';
import { ToolCallEntry } from '../../utils/agentic/PlanStore';

interface LLMMonitorProps {
  calls: ToolCallEntry[];
}

const LLMMonitor: React.FC<LLMMonitorProps> = ({ calls }) => {
  if (calls.length === 0) {
    return null;
  }

  const ordered = [...calls].slice().reverse();

  return (
    <section className="llm-monitor" aria-label="Tool call monitor">
      <header className="llm-monitor__header">
        <strong>Tool Calls</strong>
      </header>
      <table className="llm-monitor__table">
        <thead>
          <tr>
            <th>Tool</th>
            <th>Latency</th>
            <th>Tokens</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((call) => (
            <tr key={call.id}>
              <td>
                <div className="llm-monitor__tool">{call.tool}</div>
                <div className="llm-monitor__provider">{call.provider || '—'}</div>
              </td>
              <td>{call.latencyMs} ms</td>
              <td>{call.tokens ?? '—'}</td>
              <td>{typeof call.cost === 'number' ? `$${call.cost.toFixed(4)}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};

export default LLMMonitor;
