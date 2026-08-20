// Test Suite（Phase 39.1）：创建 / 修改 / 复制 / 归档 / 恢复 / 添加移除 Case / 按 Tag 过滤
import { useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks/usePolling';
import { Card, StatusBadge, Table, Empty, fmtTime } from '../components/ui';

interface Suite {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  caseIds: string[];
  tags?: string[];
  status: 'ACTIVE' | 'ARCHIVED';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export default function TestSuites(): JSX.Element {
  const { data, error, refresh } = usePolling<Suite[]>(() => api.get<Suite[]>('/test-suites'), 3000);
  const [name, setName] = useState('');
  const [caseIds, setCaseIds] = useState('');
  const [tags, setTags] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [msg, setMsg] = useState('');

  const doCreate = async (): Promise<void> => {
    if (!name.trim()) { setMsg('请填写 Suite 名称'); return; }
    await api.post<Suite>('/test-suites', {
      projectId: 'wan3',
      name: name.trim(),
      caseIds: caseIds.split(',').map((s) => s.trim()).filter(Boolean),
      tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
    });
    setName(''); setCaseIds(''); setTags(''); setMsg('已创建'); refresh();
  };

  const doAction = async (action: string, id: string, body?: unknown): Promise<void> => {
    await api.post<unknown>(`/test-suites/${id}/${action}`, body);
    setMsg(`${action} 成功`); refresh();
  };

  const filtered = data
    ? tagFilter ? data.filter((s) => (s.tags ?? []).includes(tagFilter)) : data
    : null;

  return (
    <div>
      <h1 className="page-title">Test Suites</h1>
      <div className="page-sub">测试集合（只维护 caseIds 引用，不复制 TestCase 数据）</div>
      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="ok-banner">{msg}</div>}

      <Card title="新建 Suite">
        <div className="form-row">
          <input aria-label="名称" placeholder="名称（如 WAN3 1080p 回归）" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="Case IDs（逗号分隔）" placeholder="Case IDs（逗号分隔）" value={caseIds} onChange={(e) => setCaseIds(e.target.value)} />
          <input aria-label="Tags（逗号分隔）" placeholder="Tags（逗号分隔，如 p0,smoke）" value={tags} onChange={(e) => setTags(e.target.value)} />
          <button className="btn btn-sm" onClick={() => void doCreate()}>创建</button>
        </div>
      </Card>

      <Card
        title={`全部 Suite（${filtered?.length ?? 0}）`}
        action={<input aria-label="按 Tag 过滤" placeholder="按 Tag 过滤" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} style={{ width: 140 }} />}
      >
        {!filtered && <Empty text="加载中…" />}
        {filtered && filtered.length === 0 && <Empty text="暂无 Suite" />}
        {filtered && filtered.length > 0 && (
          <Table head={['名称', '状态', '项目', 'Cases', 'Tags', '操作', '更新时间']}>
            {filtered.map((s) => (
              <tr key={s.id}>
                <td>{s.name}<div className="mono small">{s.id}</div></td>
                <td><StatusBadge status={s.status} /></td>
                <td className="mono">{s.projectId}</td>
                <td>{s.caseIds.length}</td>
                <td>{(s.tags ?? []).join(', ') || '—'}</td>
                <td>
                  <div className="btn-group">
                    {s.status === 'ACTIVE'
                      ? <button className="btn btn-sm" onClick={() => void doAction('archive', s.id)}>归档</button>
                      : <button className="btn btn-sm" onClick={() => void doAction('restore', s.id)}>恢复</button>}
                    <button className="btn btn-sm" onClick={() => void doAction('copy', s.id)}>复制</button>
                  </div>
                </td>
                <td>{fmtTime(s.updatedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
