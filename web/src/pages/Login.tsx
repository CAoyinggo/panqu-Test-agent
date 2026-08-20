import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { login, type AuthUser } from '../api';

export default function Login({ onLogin }: { onLogin: Dispatch<SetStateAction<AuthUser | null>> }): JSX.Element {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await login(username, password);
      onLogin(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">PANQU Platform</h1>
        <div className="login-sub">AI 测试平台控制台 · 请登录</div>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label htmlFor="login-username">用户名</label>
          <input id="login-username" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </div>
        <div className="field">
          <label htmlFor="login-password">密码</label>
          <input id="login-password" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? '登录中…' : '登录'}</button>
      </form>
    </div>
  );
}
