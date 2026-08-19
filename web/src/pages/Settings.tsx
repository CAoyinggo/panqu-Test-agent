// 平台设置：信息展示（认证用户 / 作用域 / 接口信息 / 版本溯源）
import { useEffect, useState } from 'react';
import { getStoredUser, api } from '../api';
import { Card, Table, JsonBlock, Badge } from '../components/ui';

interface BuildInfo {
  version: string;
  commit: string;
  buildTime: string;
  environment: string;
}

export default function Settings(): JSX.Element {
  const user = getStoredUser();
  const [info, setInfo] = useState<BuildInfo | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<BuildInfo>('/api/version')
      .then((v) => { if (alive) setInfo(v); })
      .catch(() => { if (alive) setInfo(null); });
    return () => { alive = false; };
  }, []);

  return (
    <div>
      <div className="page-title">平台设置</div>
      <div className="page-sub">控制台信息 · 仅展示，配置经平台 API / CLI 修改</div>

      <Card title="版本信息（构建溯源）">
        {info ? (
          <Table head={['字段', '值']}>
            <tr><td>Version</td><td><Badge kind="info">{info.version}</Badge></td></tr>
            <tr><td>Environment</td><td><Badge kind={info.environment === 'production' ? 'err' : 'ok'}>{info.environment}</Badge></td></tr>
            <tr><td>Commit</td><td className="cell-clip">{info.commit || '（未注入）'}</td></tr>
            <tr><td>Build Time</td><td>{info.buildTime || '（未注入）'}</td></tr>
          </Table>
        ) : (
          <p className="muted">版本信息不可用（/api/version 未响应）</p>
        )}
      </Card>

      <Card title="当前会话">
        {user ? (
          <Table head={['字段', '值']}>
            <tr><td>用户名</td><td>{user.username}</td></tr>
            <tr><td>角色</td><td><Badge kind="info">{user.role}</Badge></td></tr>
            <tr>
              <td>项目作用域</td>
              <td>{(user.scopes?.projects ?? []).length === 0 ? '全部' : (user.scopes?.projects ?? []).join(', ')}</td>
            </tr>
            <tr>
              <td>环境作用域</td>
              <td>{(user.scopes?.environments ?? []).length === 0 ? '全部' : (user.scopes?.environments ?? []).join(', ')}</td>
            </tr>
            <tr>
              <td>业务线作用域</td>
              <td>{(user.scopes?.businesses ?? []).length === 0 ? '全部' : (user.scopes?.businesses ?? []).join(', ')}</td>
            </tr>
          </Table>
        ) : (
          <p className="muted">未登录</p>
        )}
      </Card>

      <Card title="接口信息">
        <JsonBlock data={{ api: '/api', auth: '/auth', refresh: '2 秒轮询', token: 'JWT (localStorage)' }} />
      </Card>

      <Card title="说明">
        <p className="muted">
          本控制台为 PANQU AI 测试平台的生产化 Web Dashboard（Phase 25.6）。
          所有数据均来自平台真实 API（遥测 / 执行 / 调度 / 审计 / 审批 / 健康检查），无任何虚构指标。
        </p>
      </Card>
    </div>
  );
}
