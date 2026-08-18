import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { clearSession, getStoredUser } from './api';
import { useState } from 'react';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Runs from './pages/Runs';
import RunDetail from './pages/RunDetail';
import Projects from './pages/Projects';
import Approvals from './pages/Approvals';
import Metrics from './pages/Metrics';
import Telemetry from './pages/Telemetry';
import TelemetryEvents from './pages/TelemetryEvents';
import TelemetryActivation from './pages/TelemetryActivation';
import Health from './pages/Health';
import Audit from './pages/Audit';
import Jobs from './pages/Jobs';
import Workers from './pages/Workers';
import Settings from './pages/Settings';
import NotFound from './pages/NotFound';

const NAV = [
  { to: '/', label: '总览' },
  { to: '/runs', label: '执行' },
  { to: '/projects', label: '项目' },
  { to: '/approvals', label: '审批' },
  { to: '/metrics', label: '指标' },
  { to: '/telemetry', label: '遥测' },
  { to: '/telemetry/events', label: '事件' },
  { to: '/telemetry/activation', label: '激活' },
  { to: '/jobs', label: '调度' },
  { to: '/workers', label: 'Worker' },
  { to: '/audit', label: '审计' },
  { to: '/health', label: '健康' },
  { to: '/settings', label: '设置' },
];

export default function App() {
  const [user, setUser] = useState(getStoredUser());
  const navigate = useNavigate();

  if (!user) {
    return <Routes><Route path="*" element={<Login onLogin={setUser} />} /></Routes>;
  }

  const doLogout = (): void => {
    clearSession();
    setUser(null);
    navigate('/');
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">PANQU</div>
        <div className="brand-sub">AI 测试平台控制台</div>
        <nav className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} end={n.to === '/'}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="user-name">{user.username}</div>
          <div className="user-role">{user.role}</div>
          <button className="btn btn-ghost" onClick={doLogout}>退出</button>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="/telemetry" element={<Telemetry />} />
          <Route path="/telemetry/events" element={<TelemetryEvents />} />
          <Route path="/telemetry/activation" element={<TelemetryActivation />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/workers" element={<Workers />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/health" element={<Health />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
