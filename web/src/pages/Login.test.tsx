// Phase 42.1：登录页组件测试（Login.tsx）
// 覆盖：渲染表单 / 输入提交调用 login 并回调 onLogin / 登录失败展示错误文案
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Login from './Login';

describe('Login 页面（Phase 42.1）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('渲染标题、用户名/密码输入框与登录按钮', () => {
    render(<Login onLogin={() => {}} />);
    expect(screen.getByRole('heading', { name: 'PANQU Platform' })).toBeInTheDocument();
    expect(screen.getByLabelText('用户名')).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
  });

  it('提交表单调用 login 并回调 onLogin', async () => {
    const onLogin = vi.fn();
    // mock api.login：成功返回 user
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accessToken: 't', user: { username: 'admin', roles: ['QA'] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    render(<Login onLogin={onLogin} />);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('用户名'));
    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'admin', role: 'QA' })
    ));
  });

  it('登录失败展示错误文案且不回调 onLogin', async () => {
    const onLogin = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_credentials', message: '用户名或密码错误',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })));

    render(<Login onLogin={onLogin} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), 'wrong');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(screen.getByText('用户名或密码错误')).toBeInTheDocument());
    expect(onLogin).not.toHaveBeenCalled();
  });
});
